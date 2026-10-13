/**
 * 「套一次，服務多條 thread」那一格本身的測試：用一顆最小的合成插件（一張以 key 存取的表）當受測物，
 * 合格與不合格各量一遍，並確認不合格時訊息指名哪一步、哪條 thread、兩邊各是什麼。
 */

import { describe, expect, it } from 'vitest';

import { checkSharedAcrossThreads } from './shared-across-threads.js';
import type { ThreadStep } from './shared-across-threads.js';

/** 一顆「記住這條 thread 說過的話」的合成插件：逐條 thread 的狀態放在哪裡，決定它合不合格。 */
interface Notebook {
  /** 寫一句進去，回目前這條 thread 看到的全部。 */
  note(thread: string, text: string): string[];
}

/** 合格：狀態以 thread 為鍵。 */
function perThread(): Notebook {
  const tables = new Map<string, string[]>();
  return {
    note(thread, text) {
      const lines = tables.get(thread) ?? [];
      tables.set(thread, lines);
      lines.push(text);
      return [...lines];
    },
  };
}

/** 不合格：狀態放在閉包裡一張表，不分 thread。一份各自掛時看不出來，共用時串台。 */
function inClosure(): Notebook {
  const lines: string[] = [];
  return {
    note(_thread, text) {
      lines.push(text);
      return [...lines];
    },
  };
}

const steps: ThreadStep<string>[] = [
  { thread: 'a', input: '甲一' },
  { thread: 'b', input: '乙一' },
  { thread: 'a', input: '甲二' },
  { thread: 'b', input: '乙二' },
];

function target(
  make: () => Notebook,
  options: { failMount?: (threads: readonly string[]) => void } = {},
) {
  return {
    name: 'notebook',
    steps,
    mount: (threads: readonly string[]) => {
      options.failMount?.(threads);
      return Promise.resolve(make());
    },
    call: (mounted: Notebook, thread: string, input: string) =>
      Promise.resolve(mounted.note(thread, input)),
  };
}

describe('checkSharedAcrossThreads', () => {
  it('狀態以 thread 為鍵：共用一份與各自一份的結果相同，回空陣列', async () => {
    expect(await checkSharedAcrossThreads(target(perThread))).toEqual([]);
  });

  it('狀態放在閉包裡不分 thread：指名第幾步、哪條 thread、兩邊各是什麼', async () => {
    const failures = await checkSharedAcrossThreads(target(inClosure));
    // 第 1 步 a 兩邊都是 ['甲一']；第 2 步 b 起共用那一份看到 a 的話。
    expect(failures.map((failure) => failure.check)).toEqual(['parity', 'parity', 'parity']);
    expect(failures[0]?.message).toContain('notebook：第 2 步（thread b）');
    expect(failures[0]?.message).toContain('["甲一","乙一"]');
    expect(failures[0]?.message).toContain('各自一份時回 ["乙一"]');
  });

  it('只掛一次：共用那一份的 mount 只呼叫一次、帶全部 thread；基準各自一次、只帶自己', async () => {
    const seen: string[] = [];
    await checkSharedAcrossThreads(
      target(perThread, { failMount: (threads) => void seen.push(threads.join('+')) }),
    );
    expect(seen).toEqual(['a', 'b', 'a+b']);
  });

  it('共用那一份拋、各自一份沒拋：訊息帶拋的原因', async () => {
    const failures = await checkSharedAcrossThreads({
      name: 'ambiguous-demo',
      steps,
      mount: (threads) => Promise.resolve({ shared: threads.length > 1 }),
      call: (mounted: { shared: boolean }, thread, input) => {
        if (mounted.shared && thread === 'b') return Promise.reject(new Error('ambiguous'));
        return Promise.resolve(`${thread}:${input}`);
      },
    });
    expect(failures.length).toBe(2);
    expect(failures[0]?.message).toContain('共用那一份拋錯「ambiguous」');
    expect(failures[0]?.message).toContain('各自一份時回 "b:乙一"');
  });

  it('掛不起來：回 mount，後面不量', async () => {
    const failures = await checkSharedAcrossThreads({
      ...target(perThread),
      mount: (threads) =>
        threads.length > 1 ? Promise.reject(new Error('只能綁一條')) : Promise.resolve(perThread()),
    });
    expect(failures).toEqual([
      { check: 'mount', message: 'notebook：掛一次綁 a、b 時掛不起來：只能綁一條' },
    ]);
  });

  it('序列只有一條 thread：這一格量不到串台，直接說', async () => {
    const failures = await checkSharedAcrossThreads({
      ...target(perThread),
      steps: [{ thread: 'a', input: 'x' }],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.check).toBe('mount');
    expect(failures[0]?.message).toContain('至少兩條');
  });

  it('dispose 每一份都收：基準各一、共用一', async () => {
    const disposed: string[] = [];
    await checkSharedAcrossThreads({
      name: 'notebook',
      steps,
      mount: (threads) => Promise.resolve({ label: threads.join('+'), notebook: perThread() }),
      call: (mounted, thread, input) => Promise.resolve(mounted.notebook.note(thread, input)),
      dispose: (mounted) => {
        disposed.push(mounted.label);
        return Promise.resolve();
      },
    });
    expect(disposed).toEqual(['a', 'b', 'a+b']);
  });
});
