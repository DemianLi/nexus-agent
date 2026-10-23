import type { SlashDescriptor } from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import { CommandDirectory } from '@/lib/command-directory';

/**
 * 一條 thread 的命令清單（#1929），照 dsh `CommandDirectory` 的生命週期：重連丟掉重抓、失敗清空、送出時 strong-wait。
 * hook 怎麼接驗在 `hooks/use-conversation-commands.test.tsx`。
 */

const plan: SlashDescriptor = { name: 'plan', description: '規劃模式' };
const help: SlashDescriptor = { name: 'help', description: '說明' };

/** 每次 fetch 回一個由測試決定何時到、到什麼的 promise。 */
function scripted() {
  const pending: {
    resolve: (value: readonly SlashDescriptor[]) => void;
    reject: (error: Error) => void;
  }[] = [];
  const fetchCommands = vi.fn(
    () =>
      new Promise<readonly SlashDescriptor[]>((resolve, reject) =>
        pending.push({ resolve, reject }),
      ),
  );
  const changes: (readonly SlashDescriptor[])[] = [];
  const directory = new CommandDirectory(fetchCommands, (commands) => changes.push(commands));
  return { directory, fetchCommands, changes, call: (index: number) => pending[index]! };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('CommandDirectory（#1929，dsh directory.ts）', () => {
  it('resetConnected：丟掉手上的清單、狀態翻成在途，到了才是 ready', async () => {
    const { directory, call, changes } = scripted();
    const first = directory.resetConnected();
    call(0).resolve([plan]);
    expect(await first).toEqual({ kind: 'ready' });
    expect(directory.status).toBe('ready');

    const second = directory.resetConnected();
    expect(directory.status).toBe('pending');
    expect(changes.at(-1)).toEqual([]);
    call(1).resolve([help]);
    await second;
    expect(changes.at(-1)).toEqual([help]);
  });

  it('抓失敗：原本 ready 也清空、標 failed，回失敗的原因', async () => {
    const { directory, call, changes } = scripted();
    const first = directory.resetConnected();
    call(0).resolve([plan]);
    await first;

    const again = directory.refresh();
    expect(directory.status).toBe('ready');
    call(1).reject(new Error('清單讀不出來'));
    expect(await again).toEqual({ kind: 'failed', message: '清單讀不出來' });
    expect(directory.status).toBe('failed');
    expect(changes.at(-1)).toEqual([]);
  });

  it('ensureReady：重抓的那一次還是失敗就拋，訊息是那一次的原因', async () => {
    const { directory, call, fetchCommands } = scripted();
    const first = directory.resetConnected();
    call(0).reject(new Error('第一次'));
    await first;

    const waiting = directory.ensureReady();
    await flush();
    expect(fetchCommands).toHaveBeenCalledTimes(2);
    call(1).reject(new Error('第二次'));
    await expect(waiting).rejects.toThrow('第二次');
  });

  it('ensureReady：在途就等那一次，不另外再抓', async () => {
    const { directory, call, fetchCommands } = scripted();
    void directory.resetConnected();
    const waiting = directory.ensureReady();
    await flush();
    expect(fetchCommands).toHaveBeenCalledTimes(1);
    call(0).resolve([plan]);
    expect(await waiting).toEqual([plan]);
    expect(fetchCommands).toHaveBeenCalledTimes(1);
  });

  it('ensureReady：之前失敗就當場重抓一次，抓到了照用', async () => {
    const { directory, call, fetchCommands } = scripted();
    const first = directory.resetConnected();
    call(0).reject(new Error('清單讀不出來'));
    await first;

    const waiting = directory.ensureReady();
    await flush();
    expect(fetchCommands).toHaveBeenCalledTimes(2);
    call(1).resolve([plan]);
    expect(await waiting).toEqual([plan]);
  });

  it('ensureReady：沒抓過（cold）也會自己抓', async () => {
    const { directory, call, fetchCommands } = scripted();
    const waiting = directory.ensureReady();
    await flush();
    expect(fetchCommands).toHaveBeenCalledTimes(1);
    call(0).resolve([help]);
    expect(await waiting).toEqual([help]);
  });

  it('只有最新那一次能發布：先開的那一次晚到，結果不採用，等的人等到新的', async () => {
    const { directory, call, changes } = scripted();
    const stale = directory.resetConnected();
    const waiting = directory.ensureReady();
    const fresh = directory.resetConnected();

    call(0).resolve([plan]);
    expect(await stale).toEqual({ kind: 'superseded' });
    expect(directory.status).toBe('pending');
    expect(changes).not.toContainEqual([plan]);

    call(1).resolve([help]);
    expect(await fresh).toEqual({ kind: 'ready' });
    expect(await waiting).toEqual([help]);
  });
});
