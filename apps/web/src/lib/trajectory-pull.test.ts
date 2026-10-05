import type { TrajectoryTurnOutcome } from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import {
  PREFETCH_LOGICAL,
  PULLED_TURNS_MAX,
  SEEDED,
  anchorKey,
  createTrajectoryPuller,
  isFinalTurn,
  mergePulled,
  prefetchAnchors,
  staleAnchors,
  statusOf,
} from '@/lib/trajectory-pull';
import type { PullSnapshot, PulledTurn } from '@/lib/trajectory-pull';
import { call, decision, digest, tool, turn, view } from '@/test/trajectory-fixtures';

const ok = (turns: ReturnType<typeof turn>[], seq = 1000): TrajectoryTurnOutcome => ({
  kind: 'ok',
  result: { turns, seq },
});

/** 一個可以手動放行的假端點：每次呼叫記下查詢，回應由測試決定先後。 */
function fakeClient() {
  const queries: unknown[] = [];
  const waiting: { resolve: (outcome: TrajectoryTurnOutcome) => void; signal?: AbortSignal }[] = [];
  const client = {
    trajectoryTurn: vi.fn(
      (_threadId: string, query: unknown, signal?: AbortSignal) =>
        new Promise<TrajectoryTurnOutcome>((resolve, reject) => {
          queries.push(query);
          waiting.push({ resolve, ...(signal === undefined ? {} : { signal }) });
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ),
  };
  return { client, queries, waiting };
}

const pulledOf = (...turns: ReturnType<typeof turn>[]): ReadonlyMap<number, PulledTurn> =>
  new Map(turns.map((t) => [t.seq, { turn: t, final: true, through: 10 }]));

const snapshotOf = (over: Partial<PullSnapshot> = {}): PullSnapshot => ({
  turns: new Map(),
  pending: new Set(),
  failed: new Map(),
  unsupported: false,
  ...over,
});

describe('isFinalTurn：只信不會再變的輪', () => {
  it('收了尾、沒有還在跑的工具、沒有沒結局的核准：定案', () => {
    expect(isFinalTurn(turn(1, { calls: [call(1, { tools: [tool('t')] })] }))).toBe(true);
  });

  it('還沒收尾、呼叫裡有還在跑的工具、歸不到呼叫的還在跑的工具：都不算', () => {
    const { end: _end, ...open } = turn(1);
    expect(isFinalTurn(open as ReturnType<typeof turn>)).toBe(false);
    expect(
      isFinalTurn(turn(1, { calls: [call(1, { tools: [tool('t', { status: 'running' })] })] })),
    ).toBe(false);
    expect(isFinalTurn(turn(1, { looseTools: [tool('t', { status: 'running' })] }))).toBe(false);
  });

  it('核准問題沒有結局：不算（結局會落在後面的 resume 輪）；有結局或是問答那一種中斷：算', () => {
    const asked = decision('interrupt', 5, { id: 'i', approval: { tool: 'bash' } });
    expect(isFinalTurn(turn(1, { decisions: [asked] }))).toBe(false);
    const decided = decision('interrupt', 5, {
      id: 'i',
      approval: { tool: 'bash', outcome: 'allowed-once' },
    });
    expect(isFinalTurn(turn(1, { decisions: [decided] }))).toBe(true);
    expect(isFinalTurn(turn(1, { decisions: [decision('interrupt', 5, { id: 'q' })] }))).toBe(true);
  });
});

describe('mergePulled：把拉到的輪併進推送的 view', () => {
  const pushed = view([turn(5)], {
    digests: [digest(1), digest(2), digest(3), digest(4)],
    omitted: 7,
  });

  it('什麼都沒拉到、或拉到的都是窗口裡的輪：回原來那個 view 物件（參照不變）', () => {
    expect(mergePulled(pushed, new Map()).view).toBe(pushed);
    expect(mergePulled(pushed, pulledOf(turn(5, { calls: [call(9)] }))).view).toBe(pushed);
  });

  it('拉到的摘要換成完整的輪；它前面的摘要留著，後面還沒拉的補成只有摘要的輪', () => {
    const full = turn(3, { calls: [call(31)] });
    const merged = mergePulled(pushed, pulledOf(full));
    expect(merged.view.digests.map((d) => d.index)).toEqual([1, 2]);
    expect(merged.view.turns.map((t) => t.index)).toEqual([3, 4, 5]);
    expect(merged.view.turns[0]).toBe(full);
    expect([...merged.placeholders]).toEqual([400]);
    expect(merged.view.turns[1]!.calls).toEqual([]);
    expect(merged.view.omitted).toBe(7);
  });

  it('緊貼窗口的摘要拉回來：沒有補出來的輪', () => {
    const merged = mergePulled(pushed, pulledOf(turn(4)));
    expect(merged.view.turns.map((t) => t.index)).toEqual([4, 5]);
    expect(merged.placeholders.size).toBe(0);
  });

  it('一個邏輯輪的幾個實體輪一起拉回來：每一列摘要各換一次', () => {
    const merged = mergePulled(
      view([turn(5)], {
        digests: [digest(2), digest(3, { logical: false, kind: 'resume' }), digest(4)],
      }),
      pulledOf(turn(2), turn(3, { logical: false, kind: 'resume' })),
    );
    expect(merged.view.digests).toEqual([]);
    expect(merged.view.turns.map((t) => t.index)).toEqual([2, 3, 4, 5]);
    expect([...merged.placeholders]).toEqual([400]);
  });

  it('窗口裡的輪照推送的：就算快取裡有同一輪也不取代', () => {
    const live = turn(5, { calls: [call(50)] });
    const merged = mergePulled(
      view([live], { digests: [digest(3), digest(4)] }),
      pulledOf(turn(3), turn(5, { calls: [call(51)] })),
    );
    expect(merged.view.turns.at(-1)).toBe(live);
  });

  it('窗口之前、摘要之外的輪（在 omitted 裡）放不進去：不收', () => {
    const merged = mergePulled(pushed, pulledOf(turn(0)));
    expect(merged.view).toBe(pushed);
  });
});

describe('createTrajectoryPuller', () => {
  it('同一個錨點進行中只送一次；拉回來的輪進快取、進行中與失敗都清掉', async () => {
    const { client, waiting } = fakeClient();
    const puller = createTrajectoryPuller(client, 'thread-1');
    const first = puller.pull({ seq: 300 });
    const second = puller.pull({ seq: 300 });
    expect(client.trajectoryTurn).toHaveBeenCalledTimes(1);
    expect(client.trajectoryTurn).toHaveBeenCalledWith('thread-1', { seq: 300 }, expect.anything());
    expect(puller.getSnapshot().pending.has('seq:300')).toBe(true);
    waiting[0]!.resolve(ok([turn(3), turn(4, { logical: false, kind: 'resume' })]));
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    const snapshot = puller.getSnapshot();
    expect([...snapshot.turns.keys()]).toEqual([300, 400]);
    expect(snapshot.pending.size).toBe(0);
    expect(snapshot.turns.get(300)).toMatchObject({ final: true, through: 1000 });
  });

  it('回覆的 messageId 當錨點', async () => {
    const { client, waiting, queries } = fakeClient();
    const puller = createTrajectoryPuller(client, 't');
    const done = puller.pull({ messageId: 'run-a' });
    expect(queries).toEqual([{ messageId: 'run-a' }]);
    waiting[0]!.resolve(ok([turn(1)]));
    await done;
    expect(anchorKey({ messageId: 'run-a' })).toBe('msg:run-a');
  });

  it('伺服器拒絕：原因原樣記下，下一次成功才清掉；not_supported 之後標記不支援', async () => {
    const { client, waiting } = fakeClient();
    const puller = createTrajectoryPuller(client, 't');
    const bad = puller.pull({ seq: 100 });
    waiting[0]!.resolve({ kind: 'rejected', code: 'turn_not_found', message: '日誌裡沒有那一輪' });
    expect(await bad).toEqual({ ok: false, code: 'turn_not_found', message: '日誌裡沒有那一輪' });
    expect(statusOf(puller.getSnapshot(), 100)).toEqual({
      kind: 'failed',
      code: 'turn_not_found',
      message: '日誌裡沒有那一輪',
    });
    expect(puller.getSnapshot().unsupported).toBe(false);
    const retry = puller.pull({ seq: 100 });
    expect(statusOf(puller.getSnapshot(), 100)).toEqual({ kind: 'loading' });
    waiting[1]!.resolve(ok([turn(1)]));
    await retry;
    expect(statusOf(puller.getSnapshot(), 100)).toEqual({ kind: 'idle' });
    const none = puller.pull({ seq: 7 });
    waiting[2]!.resolve({ kind: 'rejected', code: 'not_supported', message: '沒有掛軌跡投影' });
    await none;
    expect(puller.getSnapshot().unsupported).toBe(true);
  });

  it('連線拋錯：講「連線出了問題」，不拋出去', async () => {
    const puller = createTrajectoryPuller(
      { trajectoryTurn: () => Promise.reject(new Error('socket hang up')) },
      't',
    );
    expect(await puller.pull({ seq: 1 })).toEqual({
      ok: false,
      code: 'network',
      message: '連線出了問題',
    });
  });

  it('回應不保證順序：伺服器看到的日誌位置舊的，不蓋掉新的', async () => {
    const { client, waiting } = fakeClient();
    const puller = createTrajectoryPuller(client, 't');
    const a = puller.pull({ seq: 100 });
    const b = puller.pull({ messageId: 'm' });
    const newer = turn(1, { calls: [call(2)] });
    const older = turn(1, { calls: [call(1)] });
    waiting[1]!.resolve(ok([newer], 900));
    await b;
    waiting[0]!.resolve(ok([older], 500));
    await a;
    expect(puller.getSnapshot().turns.get(100)!.turn).toBe(newer);
  });

  it('seed：只收已定案的、已經有的不動；之後任何一次拉都比它新', async () => {
    const { client, waiting } = fakeClient();
    const puller = createTrajectoryPuller(client, 't');
    const { end: _end, ...running } = turn(2);
    puller.seed([turn(1), running as ReturnType<typeof turn>]);
    expect([...puller.getSnapshot().turns.keys()]).toEqual([100]);
    expect(puller.getSnapshot().turns.get(100)!.through).toBe(SEEDED);
    const seeded = puller.getSnapshot();
    puller.seed([turn(1)]);
    expect(puller.getSnapshot()).toBe(seeded);
    const fresh = turn(1, { calls: [call(9)] });
    const done = puller.pull({ seq: 100 });
    waiting[0]!.resolve(ok([fresh], 0));
    await done;
    expect(puller.getSnapshot().turns.get(100)!.turn).toBe(fresh);
  });

  it(`最多留 ${PULLED_TURNS_MAX} 個實體輪：丟最早進來的`, () => {
    const puller = createTrajectoryPuller(fakeClient().client, 't');
    puller.seed(Array.from({ length: PULLED_TURNS_MAX + 5 }, (_, i) => turn(i + 1)));
    const keys = [...puller.getSnapshot().turns.keys()];
    expect(keys).toHaveLength(PULLED_TURNS_MAX);
    expect(keys[0]).toBe(600);
  });

  it('reset：快取清空；那之前送出的請求回來不收，也不會刪掉之後同一錨點的新請求', async () => {
    const { client, waiting } = fakeClient();
    const puller = createTrajectoryPuller(client, 't');
    puller.seed([turn(1)]);
    const stale = puller.pull({ seq: 200 });
    puller.reset();
    expect(puller.getSnapshot().turns.size).toBe(0);
    const again = puller.pull({ seq: 200 });
    expect(client.trajectoryTurn).toHaveBeenCalledTimes(2);
    waiting[0]!.resolve(ok([turn(2)]));
    await stale.catch(() => {});
    expect(puller.getSnapshot().turns.size).toBe(0);
    expect(puller.getSnapshot().pending.has('seq:200')).toBe(true);
    waiting[1]!.resolve(ok([turn(2)]));
    await again;
    expect(puller.getSnapshot().turns.size).toBe(1);
  });

  it('dispose：進行中的請求被中止；之後仍然可以拉', async () => {
    const { client, waiting } = fakeClient();
    const puller = createTrajectoryPuller(client, 't');
    const pending = puller.pull({ seq: 100 });
    puller.dispose();
    expect(waiting[0]!.signal!.aborted).toBe(true);
    expect(await pending).toMatchObject({ ok: false, code: 'aborted' });
    expect(statusOf(puller.getSnapshot(), 100)).toEqual({ kind: 'idle' });
    void puller.pull({ seq: 100 });
    expect(client.trajectoryTurn).toHaveBeenCalledTimes(2);
  });

  it('訂閱：每次快照換了才通知；取消訂閱後不再通知', async () => {
    const { client, waiting } = fakeClient();
    const puller = createTrajectoryPuller(client, 't');
    const listener = vi.fn();
    const off = puller.subscribe(listener);
    const done = puller.pull({ seq: 100 });
    expect(listener).toHaveBeenCalledTimes(1);
    waiting[0]!.resolve(ok([turn(1)]));
    await done;
    const count = listener.mock.calls.length;
    expect(count).toBeGreaterThan(1);
    off();
    void puller.pull({ seq: 200 });
    expect(listener).toHaveBeenCalledTimes(count);
  });
});

describe('prefetchAnchors：預拉哪些', () => {
  const digests = [digest(1), digest(2), digest(3), digest(4)];

  it(`窗口前面最近 ${PREFETCH_LOGICAL} 個邏輯輪，新的在前`, () => {
    expect(prefetchAnchors(view([turn(5)], { digests }), snapshotOf())).toEqual([
      { seq: 400 },
      { seq: 300 },
    ]);
  });

  it('已經拉到的（含收進來的）、進行中的、失敗過的不排', () => {
    const snapshot = snapshotOf({
      turns: pulledOf(turn(4)),
      pending: new Set(['seq:300']),
    });
    expect(prefetchAnchors(view([turn(5)], { digests }), snapshot)).toEqual([]);
    expect(
      prefetchAnchors(
        view([turn(5)], { digests }),
        snapshotOf({ failed: new Map([['seq:400', { code: 'x', message: 'y' }]]) }),
      ),
    ).toEqual([{ seq: 300 }]);
  });

  it('續接輪拆在兩邊：邏輯輪的哪一半沒拉到都要排；窗口第一輪是 resume 時，它接著的那一輪排在最前', () => {
    const split = view([turn(5, { logical: false, kind: 'resume' })], {
      digests: [digest(3), digest(4)],
    });
    expect(prefetchAnchors(split, snapshotOf())).toEqual([
      { seq: 500 },
      { seq: 400 },
      { seq: 300 },
    ]);
    // 邏輯輪（4）的 resume 在摘要最後一列：兩半都到了才算拉到。
    const inside = view([turn(6)], {
      digests: [digest(4), digest(5, { logical: false, kind: 'resume' })],
    });
    expect(prefetchAnchors(inside, snapshotOf({ turns: pulledOf(turn(4)) }))).toEqual([
      { seq: 400 },
    ]);
    expect(
      prefetchAnchors(
        inside,
        snapshotOf({ turns: pulledOf(turn(4), turn(5, { logical: false })) }),
      ),
    ).toEqual([]);
  });

  it('沒有摘要：沒有要預拉的；不支援：一個都不排', () => {
    expect(prefetchAnchors(view([turn(1)]), snapshotOf())).toEqual([]);
    expect(
      prefetchAnchors(view([turn(5)], { digests }), snapshotOf({ unsupported: true })),
    ).toEqual([]);
  });
});

describe('staleAnchors：還會變的輪', () => {
  const digests = [digest(1), digest(2), digest(3, { logical: false, kind: 'resume' })];

  it('只有拉過、而且沒定案的才排；同一個邏輯輪只排它第一個實體輪', () => {
    const open: PulledTurn = { turn: turn(2), final: false, through: 5 };
    const open2: PulledTurn = { turn: turn(3), final: false, through: 5 };
    const done: PulledTurn = { turn: turn(1), final: true, through: 5 };
    const snapshot = snapshotOf({
      turns: new Map([
        [100, done],
        [200, open],
        [300, open2],
      ]),
    });
    expect(staleAnchors(view([turn(4)], { digests }), snapshot)).toEqual([{ seq: 200 }]);
  });

  it('進行中的不重送；沒拉過的、不支援的不排', () => {
    const open: PulledTurn = { turn: turn(2), final: false, through: 5 };
    expect(
      staleAnchors(
        view([turn(4)], { digests }),
        snapshotOf({ turns: new Map([[200, open]]), pending: new Set(['seq:200']) }),
      ),
    ).toEqual([]);
    expect(staleAnchors(view([turn(4)], { digests }), snapshotOf())).toEqual([]);
    expect(
      staleAnchors(
        view([turn(4)], { digests }),
        snapshotOf({ turns: new Map([[200, open]]), unsupported: true }),
      ),
    ).toEqual([]);
  });
});
