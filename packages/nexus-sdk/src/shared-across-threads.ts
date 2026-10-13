/**
 * 一致性的一格：**套一次，服務兩條 thread**（[#1418](https://github.com/DemianLi/nexus-agent/issues/1418)）。
 *
 * 插件上了行程樹以後 `apply` 只跑一次，一份插件要服務好幾條 thread。今天每條 thread 各組裝一次，插件在
 * `apply` 的閉包裡放「逐條 thread 的東西」（等結果的表、抓下來的答題者）也不會出事；一旦只套一次，那些東西就串台。
 * 這一格量的就是這件事：**同一份只掛一次、綁兩個以上的 thread、交錯呼叫，每一步的結果要和「各自一份」時相同**。
 *
 * ## 為什麼是回呼，不是 registry
 *
 * SDK 不 import `@nexus/core`（決議 §3-4 第 17 條）。「怎麼掛一次」與「怎麼以某條 thread 的身分呼叫」是宿主的事：
 * 今天的相容層插件用 `@nexus/core` 的 registry 寫轉接（見 `packages/nexus-plugin-ask-user`、`nexus-plugin-present`
 * 的測試），日後上樹的插件接 Loader 的形狀（那時加進 {@link checkConformance} 的格子）。這一支只管比對與回報。
 *
 * ## 回傳
 *
 * 同 {@link checkConformance}：結構化結果，空陣列代表全過。每一條不合格指名**哪一步、哪條 thread、兩邊各是什麼**，
 * 看得出卡在哪裡（例如「共用的那一份在 thread b 的第 1 步回 ambiguous，各自一份時回的是拒絕」）。
 *
 * @module
 */

import { isDeepStrictEqual } from 'node:util';

/** 一格裡的細項。 */
export type SharedAcrossThreadsCheck = 'mount' | 'parity';

/** 一條不合格。形狀同 {@link import('./conformance.js').ConformanceFailure}。 */
export interface SharedAcrossThreadsFailure {
  readonly check: SharedAcrossThreadsCheck;
  readonly message: string;
}

/** 交錯呼叫序列裡的一步：哪一條 thread、用什麼輸入。 */
export interface ThreadStep<Input = unknown> {
  readonly thread: string;
  readonly input: Input;
}

/** 受測的東西與怎麼量它。 */
export interface SharedAcrossThreadsTarget<Mounted, Input = unknown> {
  /** 受測插件的名字；訊息指名它。 */
  readonly name: string;
  /**
   * 交錯的呼叫序列。**至少要有兩條 thread**，而且彼此交錯（`a, b, a, b`），不是先跑完一條再跑另一條：
   * 串台的缺陷只有在兩條 thread 的呼叫在時間上重疊時才看得見。
   */
  readonly steps: readonly ThreadStep<Input>[];
  /**
   * 掛上去，**綁這幾條 thread**。共用那一份會以全部 thread 呼叫**一次**；基準那一份（每條 thread 各自一份，
   * 今天的做法）對每條 thread 各呼叫一次、只帶它自己。
   *
   * 回傳的東西原樣交給 {@link call}。
   */
  mount(threads: readonly string[]): Promise<Mounted>;
  /**
   * 以某條 thread 的身分呼叫一次，回**可比較的結果**（純資料：字串、數字、物件，不要放函式或實例）。
   *
   * 結果裡不要放跟 thread 本身無關、每次都不同的值（時間戳、隨機 id）：兩邊要逐項比對。拋錯會被收成結果的一部分，
   * 所以「共用那一份拋了、各自一份沒拋」是一條可以指名的不合格。
   */
  call(mounted: Mounted, thread: string, input: Input, index: number): Promise<unknown>;
  /** 收掉掛上去的東西；省略就不收。 */
  dispose?(mounted: Mounted): Promise<void>;
}

/** 一步的結果：回了什麼，或拋了什麼。 */
type Outcome = { readonly returned: unknown } | { readonly threw: string };

async function run<Mounted, Input>(
  target: SharedAcrossThreadsTarget<Mounted, Input>,
  mounted: Mounted,
  step: ThreadStep<Input>,
  index: number,
): Promise<Outcome> {
  try {
    return { returned: await target.call(mounted, step.thread, step.input, index) };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

const show = (outcome: Outcome): string =>
  'threw' in outcome ? `拋錯「${outcome.threw}」` : `回 ${JSON.stringify(outcome.returned)}`;

/**
 * 量一顆插件「套一次，服務多條 thread」。
 *
 * @param target - 受測的東西與呼叫序列。
 * @returns 不合格的條目；空陣列代表全過。掛不起來就只回 `mount` 那一條（後面量不了）。
 */
export async function checkSharedAcrossThreads<Mounted, Input = unknown>(
  target: SharedAcrossThreadsTarget<Mounted, Input>,
): Promise<SharedAcrossThreadsFailure[]> {
  const failures: SharedAcrossThreadsFailure[] = [];
  const fail = (check: SharedAcrossThreadsCheck, message: string) =>
    failures.push({ check, message: `${target.name}：${message}` });
  const threads = [...new Set(target.steps.map((step) => step.thread))];
  if (threads.length < 2) {
    fail('mount', `呼叫序列只有 ${threads.length} 條 thread：這一格要至少兩條交錯才量得到串台`);
    return failures;
  }

  // 基準：每條 thread 各自一份，只跑自己的那幾步（今天的做法）。
  const expected: (Outcome | undefined)[] = target.steps.map(() => undefined);
  for (const thread of threads) {
    let mounted: Awaited<ReturnType<typeof target.mount>>;
    try {
      mounted = await target.mount([thread]);
    } catch (error) {
      fail('mount', `各自一份時，thread ${thread} 就掛不起來：${errorText(error)}`);
      return failures;
    }
    try {
      for (const [index, step] of target.steps.entries()) {
        if (step.thread === thread) expected[index] = await run(target, mounted, step, index);
      }
    } finally {
      await target.dispose?.(mounted);
    }
  }

  // 共用：只掛一次，綁全部 thread，照序列交錯呼叫。
  let shared: Awaited<ReturnType<typeof target.mount>>;
  try {
    shared = await target.mount(threads);
  } catch (error) {
    fail('mount', `掛一次綁 ${threads.join('、')} 時掛不起來：${errorText(error)}`);
    return failures;
  }
  try {
    for (const [index, step] of target.steps.entries()) {
      const actual = await run(target, shared, step, index);
      const wanted = expected[index] as Outcome;
      if (!isDeepStrictEqual(actual, wanted)) {
        fail(
          'parity',
          `第 ${index + 1} 步（thread ${step.thread}）共用那一份${show(actual)}，各自一份時${show(wanted)}`,
        );
      }
    }
  } finally {
    await target.dispose?.(shared);
  }
  return failures;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
