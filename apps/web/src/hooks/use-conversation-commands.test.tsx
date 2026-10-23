import type { Event, SkillEntry, SlashDescriptor, SlashListOutcome, WireClient } from '@nexus/wire';
import { act, cleanup, configure, renderHook } from '@testing-library/react';
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

// `main.tsx` 開著 StrictMode：effect 先跑一次、收掉、再跑一次，開線與 `resetConnected` 都會多一次；被蓋掉的那一次不能發布。
// 所以清單的回答跟著「現在是第幾條線」走（`phase`），呼叫次數從斷線前那一刻算起。
describe.each([false, true])(
  'useConversation 的命令清單跟著連線走（#1929，dsh resetConnected；StrictMode：%s）',
  (strict) => {
    beforeEach(() => configure({ reactStrictMode: strict }));
    afterEach(() => configure({ reactStrictMode: false }));

    it('重連後重抓失敗：上一條線的清單不留，送「/plan」重抓一次還是失敗就退回', async () => {
      let phase: 'first' | 'second' = 'first';
      const fake = scriptedClient(
        async () =>
          phase === 'first'
            ? { kind: 'ok', commands: [plan] }
            : { kind: 'rejected', message: '清單讀不出來' },
        async () => ({ kind: 'ok', skills: [] }),
      );
      const { result } = renderHook(() => useConversation({ client: fake.client, threadId: 't' }));
      await tick();
      expect(result.current.slashCommands).toEqual([plan]);

      phase = 'second';
      const opened = fake.openEvents.mock.calls.length;
      const listed = fake.client.slashList.mock.calls.length;
      await reconnect(fake.failLatest);
      expect(fake.openEvents).toHaveBeenCalledTimes(opened + 1);
      expect(result.current.connected).toBe(true);
      expect(result.current.slashCommands).toEqual([]);
      expect(fake.client.slashList).toHaveBeenCalledTimes(listed + 1);

      let rejected: Awaited<ReturnType<typeof result.current.send>>;
      await act(async () => {
        rejected = await result.current.send('/plan');
      });
      expect(rejected!).toEqual({ message: commandsFailedText('清單讀不出來') });
      expect(fake.client.slashList).toHaveBeenCalledTimes(listed + 2);
      expect(fake.slashed).toEqual([]);
      expect(fake.started).toEqual([]);
    });

    it('重連後新清單還在途：送出等它，照新的那份路由（舊的有 plan、新的沒有 → 送給模型）', async () => {
      const second = deferred<SlashListOutcome>();
      let phase: 'first' | 'second' = 'first';
      const fake = scriptedClient(
        () =>
          phase === 'first' ? Promise.resolve({ kind: 'ok', commands: [plan] }) : second.promise,
        async () => ({ kind: 'ok', skills: [] }),
      );
      const { result } = renderHook(() => useConversation({ client: fake.client, threadId: 't' }));
      await tick();
      expect(result.current.slashCommands).toEqual([plan]);

      phase = 'second';
      const listed = fake.client.slashList.mock.calls.length;
      await reconnect(fake.failLatest);
      expect(fake.client.slashList).toHaveBeenCalledTimes(listed + 1);

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
      expect(fake.client.slashList).toHaveBeenCalledTimes(listed + 1);
    });

    it('等清單時畫面卸載：不等了，清單後來到也不送', async () => {
      const pending = deferred<SlashListOutcome>();
      const fake = scriptedClient(
        () => pending.promise,
        async () => ({ kind: 'ok', skills: [] }),
      );
      const { result, unmount } = renderHook(() =>
        useConversation({ client: fake.client, threadId: 't' }),
      );
      await tick();

      let rejected: Awaited<ReturnType<typeof result.current.send>> | 'pending' = 'pending';
      act(() => {
        void result.current.send('/plan').then((outcome) => (rejected = outcome));
      });
      await tick();
      expect(rejected).toBe('pending');

      unmount();
      await tick();
      expect(rejected).not.toBe('pending');
      expect(rejected).toHaveProperty('message');

      pending.resolve({ kind: 'ok', commands: [plan] });
      await tick();
      expect(fake.slashed).toEqual([]);
      expect(fake.started).toEqual([]);
    });

    it('重連時技能清單先清掉：新的還沒到，選單不留上一條線的技能', async () => {
      const second = deferred<Awaited<ReturnType<WireClient['skillList']>>>();
      let phase: 'first' | 'second' = 'first';
      const fake = scriptedClient(
        async () => ({ kind: 'ok', commands: [plan] }),
        () =>
          phase === 'first' ? Promise.resolve({ kind: 'ok', skills: [deploy] }) : second.promise,
      );
      const { result } = renderHook(() => useConversation({ client: fake.client, threadId: 't' }));
      await tick();
      expect(result.current.skills).toEqual([deploy]);

      phase = 'second';
      await reconnect(fake.failLatest);
      expect(result.current.connected).toBe(true);
      expect(result.current.skills).toEqual([]);

      second.resolve({ kind: 'ok', skills: [] });
      await tick();
      expect(result.current.skills).toEqual([]);
    });
  },
);
