/**
 * **同一個行程裡的寫入先排隊、再取鎖檔**（[#1450](https://github.com/DemianLi/nexus-agent/issues/1450)）。
 *
 * `plugin-journal.test.ts` 的「25 個寫入同時進來」只斷言結果（25 筆、序號遞增），不問怎麼排的——沒有行程內佇列時它照樣綠，
 * 只是慢（實測 4.4 秒、其中 4 秒在睡眠），負載下撞破 vitest 的 5 秒逾時。這一檔直接問**機制**：
 * 數 `wx` 建鎖檔的次數。有佇列時每個寫入只建一次（沒有任何一次撞到別人的鎖）；拿掉佇列，後面的每輪重試都多一次。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const lockCreates = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: ((...args: Parameters<typeof actual.writeFile>) => {
      const [path, , options] = args;
      const flag = typeof options === 'object' && options !== null ? options.flag : undefined;
      if (flag === 'wx' && typeof path === 'string' && path.endsWith('.lock')) {
        lockCreates.count += 1;
      }
      return actual.writeFile(...args);
    }) as typeof actual.writeFile,
  };
});

import { appendJournalRecord, readJournal, withFileLock } from './plugin-journal.js';
import type { JournalActor } from './plugin-journal.js';

const ACTOR: JournalActor = {
  kind: 'host-account',
  effective: 'svc',
  invoker: 'alice',
  invokerSource: 'SUDO_USER',
};

const temporary: string[] = [];
afterEach(() => {
  lockCreates.count = 0;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-journal-queue-'));
  temporary.push(root);
  return root;
}

/** 一道手動開的閘：`open()` 之前 `wait` 不會回來。 */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('行程內佇列（#1450）', () => {
  it('25 個寫入同時進來：每個只建一次鎖檔，沒有任何一次撞到同行程裡別人的鎖', async () => {
    const path = join(dir(), 'j.jsonl');
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        appendJournalRecord(path, { actor: ACTOR }, () => ({
          op: 'config-set',
          id: `row-${String(index)}`,
          name: 'm',
          before: null,
          after: { index },
        })),
      ),
    );
    // 拿掉 `withFileLock` 裡的行程內佇列，這裡會是 25 加上每一輪重試。
    expect(lockCreates.count).toBe(25);
    expect(readJournal(path)?.records).toHaveLength(25);
  });

  it('依呼叫順序輪流：先進來的先寫', async () => {
    const path = join(dir(), 'j.jsonl');
    const ran: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        withFileLock(path, async () => {
          ran.push(index);
          await new Promise((resolve) => setTimeout(resolve, 2));
        }),
      ),
    );
    expect(ran).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('前一個一直不放：後來的在 waitMs 內拋「等不到」、自己的操作沒跑；前一個放了之後佇列照常往下走', async () => {
    const path = join(dir(), 'j.jsonl');
    const hold = gate();
    const first = withFileLock(path, () => hold.wait);
    let secondRan = false;
    const second = withFileLock(
      path,
      async () => {
        secondRan = true;
      },
      { waitMs: 100 },
    );
    await expect(second).rejects.toThrow(/等不到/u);
    expect(secondRan).toBe(false);
    // 第二個離開了，第三個仍排在第一個後面（順序沒被它搞亂），第一個放了就輪到。
    let thirdRan = false;
    const third = withFileLock(path, async () => {
      thirdRan = true;
    });
    await Promise.resolve();
    expect(thirdRan).toBe(false);
    hold.open();
    await first;
    await third;
    expect(thirdRan).toBe(true);
    // 佇列清乾淨了：之後的呼叫不會被留下的尾巴卡住。
    await expect(withFileLock(path, async () => 'ok', { waitMs: 100 })).resolves.toBe('ok');
  });

  it('不同的檔各排各的：一個檔的持有者不擋另一個檔', async () => {
    const root = dir();
    const hold = gate();
    const held = withFileLock(join(root, 'a.jsonl'), () => hold.wait);
    await expect(
      withFileLock(join(root, 'b.jsonl'), async () => 'b', { waitMs: 1_000 }),
    ).resolves.toBe('b');
    hold.open();
    await held;
  });

  it('操作拋錯：照樣放行後面的', async () => {
    const path = join(dir(), 'j.jsonl');
    const failing = withFileLock(path, async () => {
      throw new Error('boom');
    });
    const after = withFileLock(path, async () => 'next');
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('next');
  });
});
