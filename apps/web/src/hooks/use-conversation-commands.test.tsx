import type { Event, SkillEntry, SlashDescriptor, SlashListOutcome, WireClient } from '@nexus/wire';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandsFailedText, useConversation } from '@/hooks/use-conversation';

/**
 * 命令清單與技能清單跟著連線走（[#1929](https://github.com/DemianLi/nexus-agent/issues/1929)，照 dsh 的
 * `CommandDirectory.resetConnected` 與 `ui-skill` 重連丟快取）：每次連上都丟掉重抓，送出時認命令那一道等的是**這條線**的
 * 清單。機制本身驗在 `lib/command-directory.test.ts`；這裡驗 hook 真的在重連時重設、送出時等它。
 */

const plan: SlashDescriptor = { name: 'plan', description: '規劃模式' };
const deploy: SkillEntry = { name: 'deploy', description: '部署', modelInvocable: false };

/** 每次 `openEvents` 開一條新的下行；`fail` 讓最新那一條出錯，hook 照退避重接。 */
function scriptedClient(
  slashList: () => Promise<SlashListOutcome>,
  skillList: WireClient['skillList'],
) {
  const fails: ((error: Error) => void)[] = [];
  const openEvents = vi.fn(async () => {
    let fail: ((error: Error) => void) | undefined;
    const failed = new Promise<never>((_resolve, reject) => (fail = reject));
    fails.push(fail!);
    // 這條線不送任何 frame，只等測試叫它出錯。
    return (async function* stream(): AsyncGenerator<Event> {
      yield await failed;
    })();
  });
  const slashed: string[] = [];
  const started: string[] = [];
  const client = {
    openEvents,
    threadHistory: async () => ({
      kind: 'ok',
      result: { events: [], firstSeq: 0, throughSeq: 0, hasMore: false, legacy: false },
    }),
    slashList: vi.fn(slashList),
    skillList,
    slashRun: async (_threadId: string, line: string) => {
      slashed.push(line);
      return { kind: 'ok', result: { type: 'message', text: '好' } };
    },
    runStart: async (_threadId: string, text: string) => {
      started.push(text);
      return { type: 'success', id: 1, result: { run_id: `run-${started.length}` } };
    },
  } as unknown as WireClient & { slashList: ReturnType<typeof vi.fn> };
  return {
    client,
    openEvents,
    slashed,
    started,
    failLatest: () => fails[fails.length - 1]!(new Error('network error')),
  };
}

/** 讓 promise 鏈跑完、再推進假時鐘。 */
async function tick(ms = 0) {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

/** 斷一次線、推過第 1 次重試的退避（亂數固定 0：250ms），等它接回。 */
async function reconnect(failLatest: () => void) {
  failLatest();
  await tick();
  await tick(250);
}

/** 可以從外面決定什麼時候到、到什麼的 promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useConversation 的命令清單跟著連線走（#1929，dsh resetConnected）', () => {
  it('重連後重抓失敗：上一條線的清單不留，送「/plan」重抓一次還是失敗就退回', async () => {
    const answers: SlashListOutcome[] = [{ kind: 'ok', commands: [plan] }];
    const fake = scriptedClient(
      async () => answers.shift() ?? { kind: 'rejected', message: '清單讀不出來' },
      async () => ({ kind: 'ok', skills: [] }),
    );
    const { result } = renderHook(() => useConversation({ client: fake.client, threadId: 't' }));
    await tick();
    expect(result.current.slashCommands).toEqual([plan]);

    await reconnect(fake.failLatest);
    expect(fake.openEvents).toHaveBeenCalledTimes(2);
    expect(result.current.connected).toBe(true);
    expect(result.current.slashCommands).toEqual([]);
    expect(fake.client.slashList).toHaveBeenCalledTimes(2);

    let rejected: Awaited<ReturnType<typeof result.current.send>>;
    await act(async () => {
      rejected = await result.current.send('/plan');
    });
    expect(rejected!).toEqual({ message: commandsFailedText('清單讀不出來') });
    expect(fake.client.slashList).toHaveBeenCalledTimes(3);
    expect(fake.slashed).toEqual([]);
    expect(fake.started).toEqual([]);
  });

  it('重連後新清單還在途：送出等它，照新的那份路由（舊的有 plan、新的沒有 → 送給模型）', async () => {
    const second = deferred<SlashListOutcome>();
    const answers: Promise<SlashListOutcome>[] = [
      Promise.resolve({ kind: 'ok', commands: [plan] }),
      second.promise,
    ];
    const fake = scriptedClient(
      () => answers.shift()!,
      async () => ({ kind: 'ok', skills: [] }),
    );
    const { result } = renderHook(() => useConversation({ client: fake.client, threadId: 't' }));
    await tick();
    expect(result.current.slashCommands).toEqual([plan]);

    await reconnect(fake.failLatest);
    expect(fake.client.slashList).toHaveBeenCalledTimes(2);

    let sending!: Promise<unknown>;
    act(() => {
      sending = result.current.send('/plan');
    });
    await tick();
    expect(fake.slashed).toEqual([]);
    expect(fake.started).toEqual([]);

    second.resolve({ kind: 'ok', commands: [] });
    await act(async () => {
      await sending;
    });
    expect(fake.started).toEqual(['/plan']);
    expect(fake.slashed).toEqual([]);
    // 在途那一次就是要等的那一次，不另外再抓。
    expect(fake.client.slashList).toHaveBeenCalledTimes(2);
  });

  it('重連時技能清單先清掉：新的還沒到，選單不留上一條線的技能', async () => {
    const second = deferred<Awaited<ReturnType<WireClient['skillList']>>>();
    const answers = [Promise.resolve({ kind: 'ok' as const, skills: [deploy] }), second.promise];
    const fake = scriptedClient(
      async () => ({ kind: 'ok', commands: [plan] }),
      () => answers.shift()!,
    );
    const { result } = renderHook(() => useConversation({ client: fake.client, threadId: 't' }));
    await tick();
    expect(result.current.skills).toEqual([deploy]);

    await reconnect(fake.failLatest);
    expect(result.current.connected).toBe(true);
    expect(result.current.skills).toEqual([]);

    second.resolve({ kind: 'ok', skills: [] });
    await tick();
    expect(result.current.skills).toEqual([]);
  });
});
