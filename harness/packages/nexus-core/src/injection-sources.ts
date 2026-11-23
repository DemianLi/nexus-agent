/**
 * **一次模型請求裡各注入源放了多少位元組**（[#2777](https://github.com/DemianLi/nexus-agent/issues/2777)），給 `context/measure` 的
 * `sources`。只量，不改請求。
 *
 * 源分兩邊，量法不同：
 *
 * - **接在系統提示上的**（頭尾段、中段、Skills、記憶）：接上的那一刻回報（{@link reportInjectionSources}，由
 *   `system-prompt-step.ts` 叫）。摘要器在夾住下一層時開一格收（{@link captureInjectionSources}），格子靠
 *   `AsyncLocalStorage` 帶進內層。摘要器外層的那幾步（root 的 Skills）跑的時候格子還沒開，改掛在往內交的請求上
 *   （{@link INJECTION_SOURCES}），摘要器開格子時拿它當底。
 * - **放在訊息串裡的**（agent-instructions、`/名字` 技能叫用）：在模型呼叫之前的節點就進了 state，摘要器從送出的訊息上的來源
 *   標記認（{@link messageInjectionSources}）。
 *
 * 同一個源在同一格裡回報兩次，後一次蓋掉前一次：串流重試會把內層的幾步重跑一遍，送出去的是最後那一次。
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { INJECTION_SOURCE_BUDGETS, injectionLimitFor } from './injection-budget.js';
import type { InjectionSourceId } from './injection-budget.js';
import { messageSourceOf } from './message-source.js';
import type { MessageSource } from './message-source.js';
import type { SessionEventMap } from './session-log.js';

/** 一個源這一次放了多少。 */
export interface InjectionSourceReport {
  /** 源的識別：預算表的鍵，或中段的段名。 */
  readonly id: string;
  /** UTF-8 位元組數。 */
  readonly bytes: number;
  /** 放不下、沒放進去的原文位元組數；沒有延後就不給。 */
  readonly deferredBytes?: number;
}

/**
 * 訊息 `additional_kwargs` 上的鍵：這一則注入有多少原文位元組放不下、沒放進去（正整數）。放在訊息串裡的源（插件的
 * `agent/pre-step` listener）用它回報；插件不能 import core，鍵名照抄，`apps/harness` 的測試把兩邊釘成相等。
 */
export const INJECTION_DEFERRED_BYTES_KEY = 'nexus_injection_deferred_bytes';

/** 格子裡一個源的數。 */
interface Tally {
  bytes: number;
  deferredBytes: number;
}

/** 請求上的鍵：收集格還沒開時回報的那幾筆，見檔頭。 */
export const INJECTION_SOURCES: unique symbol = Symbol('nexus.injectionSources');

const collectors = new AsyncLocalStorage<Map<string, Tally>>();

/** 一段文字的 UTF-8 位元組數。 */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 把同一批裡同名的加起來。 */
function totals(reports: readonly InjectionSourceReport[]): Map<string, Tally> {
  const sums = new Map<string, Tally>();
  for (const { id, bytes, deferredBytes } of reports) {
    const tally = sums.get(id) ?? { bytes: 0, deferredBytes: 0 };
    tally.bytes += bytes;
    tally.deferredBytes += deferredBytes ?? 0;
    sums.set(id, tally);
  }
  return sums;
}

function reportsOf(sums: Map<string, Tally>): InjectionSourceReport[] {
  return [...sums].map(([id, { bytes, deferredBytes }]) => ({
    id,
    bytes,
    ...(deferredBytes > 0 && { deferredBytes }),
  }));
}

/**
 * 回報一步接上的那幾塊。同一批裡同名的相加；跟格子裡已有的同名則蓋掉。
 *
 * @param reports - 這一步接上的。
 * @returns 有沒有開著的格子收下；`false` 時呼叫端要自己帶（{@link INJECTION_SOURCES}）。
 */
export function reportInjectionSources(reports: readonly InjectionSourceReport[]): boolean {
  const collector = collectors.getStore();
  if (collector === undefined) return false;
  for (const [id, tally] of totals(reports)) collector.set(id, tally);
  return true;
}

/**
 * 開一格（以 `seed` 打底）、在裡面跑 `call`，交回這一格最後的內容：`seed` 加內層回報的，同名以內層為準。
 *
 * @param seed - 外層已經接上的（請求上的 {@link INJECTION_SOURCES}）。
 * @param call - 往內的那次呼叫。
 * @returns `call` 的結果，與這一格收到的。`call` 拋的錯原樣往外傳。
 */
export async function captureInjectionSources<T>(
  seed: readonly InjectionSourceReport[] | undefined,
  call: () => T | Promise<T>,
): Promise<{ readonly result: T; readonly reports: readonly InjectionSourceReport[] }> {
  const collector = totals(seed ?? []);
  const result = await collectors.run(collector, call);
  return { result, reports: reportsOf(collector) };
}

/** 請求上掛著的那幾筆；沒有就是 `undefined`。 */
export function carriedInjectionSources(
  request: object,
): readonly InjectionSourceReport[] | undefined {
  return (request as { [INJECTION_SOURCES]?: readonly InjectionSourceReport[] })[INJECTION_SOURCES];
}

/** 一則機器訊息屬於表上的哪個源；不在表上是 `undefined`。 */
function sourceIdOf(source: MessageSource | undefined): InjectionSourceId | undefined {
  if (source === undefined) return undefined;
  if (source.kind === 'skill-invocation') return 'skill-invocation';
  // `@nexus/plugin-agent-instructions` 的 `AGENT_INSTRUCTIONS_MIDDLEWARE_NAME`；core 不能 import 插件，名字照抄。
  if (source.kind === 'plugin' && source['plugin'] === 'AgentInstructionsMiddleware') {
    return 'agent-instructions';
  }
  return undefined;
}

/** 只算文字塊；圖、檔案等非文字塊不計。 */
function contentBytes(content: unknown): number {
  if (typeof content === 'string') return utf8Bytes(content);
  if (!Array.isArray(content)) return 0;
  let bytes = 0;
  for (const block of content) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text === 'string') bytes += utf8Bytes(text);
  }
  return bytes;
}

/**
 * 送出的訊息串裡，表上的源各佔多少：同一個源的幾則相加。
 *
 * @param messages - 這次送出的訊息。
 */
export function messageInjectionSources(
  messages: readonly {
    readonly content?: unknown;
    readonly additional_kwargs?: Record<string, unknown>;
  }[],
): InjectionSourceReport[] {
  const reports: InjectionSourceReport[] = [];
  for (const message of messages) {
    const id = sourceIdOf(messageSourceOf(message));
    if (id === undefined) continue;
    const deferred = message.additional_kwargs?.[INJECTION_DEFERRED_BYTES_KEY];
    reports.push({
      id,
      bytes: contentBytes(message.content),
      ...(typeof deferred === 'number' &&
        Number.isSafeInteger(deferred) &&
        deferred > 0 && { deferredBytes: deferred }),
    });
  }
  return reportsOf(totals(reports));
}

/**
 * 組成 `context/measure` 的 `sources`：照 `id` 排序；表上有、而且上限是整個源一個的，附上這個窗口下的上限。
 *
 * @param reports - 系統提示那邊收到的，加上訊息那邊認到的；`id` 不重複。
 * @param contextWindow - 這次請求走的模型的窗口；取不到就不給。
 */
export function measuredInjectionSources(
  reports: readonly InjectionSourceReport[],
  contextWindow: number | undefined,
): NonNullable<SessionEventMap['context/measure']['sources']> {
  return [...reports]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, bytes, deferredBytes }) => {
      const budget = (INJECTION_SOURCE_BUDGETS as Record<string, { kind: string } | undefined>)[id];
      return {
        id,
        bytes,
        ...(budget !== undefined &&
          budget.kind !== 'per-server' && {
            limit: injectionLimitFor(id as InjectionSourceId, contextWindow),
          }),
        ...(deferredBytes !== undefined && deferredBytes > 0 && { deferredBytes }),
      };
    });
}
