/**
 * **一次模型呼叫的識別，以及怎麼把它傳到每一個寫入點**
 * （[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)）。
 *
 * ## 識別就是 `model/start` 的 `seq`
 *
 * 日誌每筆事件只有 `type`／`seq`／`time`／`data`，沒有 turn、step、parent。靠位置把 `model/end`、`model/usage`、
 * `llm/retry*`、`assistant/message` 歸給某次呼叫，遇到背景請求、佇列事件、摘要器的量測就歸錯（`indexModelCalls` 的
 * 檔頭有三個真實日誌的反例）。所以這些事件各帶一格 `modelCall`，值是**它所屬那次呼叫的 `model/start` 的 `seq`**。
 *
 * 不另外生號碼：`seq` 在一份日誌內本來就唯一、單調、續接不變，生出來的 uuid 還得多存一格、多一個對不上的機會。
 * 輪編號維持推導值、不另存（repo 既有規則，免得兩份號碼對不上）；子代理有自己的日誌，所以 `modelCall` 只在**同一份日誌內**有意義。
 *
 * ## 傳法：三個寫入點在三個位置
 *
 * 一次模型呼叫的寫入點分散在洋蔥的不同層（`fold.ts` 的槽位表）：
 *
 * | 寫入點 | 位置 | 怎麼拿到識別 |
 * | --- | --- | --- |
 * | `model/end`、`assistant/message` | 起訖紀錄器自己 | 手上就有 |
 * | `model/usage`、`llm/retry*` | 起訖紀錄器**內側** | {@link currentModelCall}（`AsyncLocalStorage`，往內傳） |
 * | `context/measure` | 摘要器，**外側** | {@link captureModelCall}：外層放一個格子，內層填進去 |
 * | `assistant/message {interrupted}` | pump，呼叫已經結束之後 | {@link lastModelCall}：這份日誌最近開的那一次 |
 *
 * 往外傳不能用 `AsyncLocalStorage`（它只往內流），所以外層自己開格子、內層把識別填進去，同一個
 * `AsyncLocalStorage` 把格子帶進去。**每次 `handler` 呼叫各開一格**：脈絡溢出時摘要器會叫兩次內層，兩次是兩個識別。
 *
 * ## 日誌身分跟識別一起放
 *
 * 識別只在「格子裡記的日誌就是這次要寫的那一份」時才給出去（{@link currentModelCall}、{@link CapturedModelCall.of} 都要傳日誌）：
 * `seq` 是某一份日誌裡的號碼，拿到別份日誌上只會指到不相干的事件。root 與子代理各有日誌，一個寫入點若解析出別份，
 * 寧可不附也不附錯。
 *
 * ## 標題請求不在裡面
 *
 * 標題呼叫由 `model/start` 的訂閱者排起。`model/start` 是在**開範圍之前**寫的（起訖紀錄器先 `append`、拿到 `seq`，才
 * {@link runInModelCall}），所以訂閱者跑的那一刻沒有任何範圍；它又綁在接上日誌那一刻的 context 上跑
 * （`session-title-llm.ts` 的 `AsyncResource.bind`，為的是 LangChain 的 callbacks，見該檔頭）。兩層各自都擋得住，
 * 標題的重試不會掉進主呼叫、帶上主呼叫的識別。`session-title-llm.test.ts` 用強制重試釘著這一條。
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionLog } from './session-log.js';

/**
 * adapter 在一次請求裡看到的供應商用量，三個數字**原樣、還沒驗**（驗的是讀它的那一側，見 `model-usage.ts` 的
 * `validateUsage`）。
 */
export interface AttemptUsage {
  /** 供應商報的 prompt 總數，**含**下面兩格（OpenAI 相容端點的 `prompt_tokens`）。 */
  readonly inputTokens: unknown;
  readonly outputTokens: unknown;
  readonly totalTokens: unknown;
  /** `prompt_tokens_details.cached_tokens`；供應商沒報（缺欄或 `null`）就不放 key。 */
  readonly cacheReadTokens?: unknown;
  /** `prompt_tokens_details.cache_write_tokens`；供應商沒報（缺欄或 `null`）就不放 key。 */
  readonly cacheWriteTokens?: unknown;
}

/** 一次呼叫裡最近那次請求的用量格。每次請求開跑時換一格新的，所以舊請求遲到的回報進不了新的。 */
interface AttemptCell {
  usage: AttemptUsage | undefined;
}

/** 起訖紀錄器為一次呼叫開的範圍，給它內側的寫入點讀。 */
interface CallScope {
  readonly log: SessionLog;
  readonly modelCall: number;
  /** 最近那次請求的用量格（#1022）。`undefined` ＝ 還沒有請求開跑。 */
  attempt: AttemptCell | undefined;
}

/** 外層放的格子，內層的起訖紀錄器填。 */
interface CallProbe {
  log: SessionLog | undefined;
  modelCall: number | undefined;
}

const scopes = new AsyncLocalStorage<CallScope>();
const probes = new AsyncLocalStorage<CallProbe>();
/** 每份日誌最近開的那次呼叫，與它有沒有記過正常回覆。 */
const lastCalls = new WeakMap<SessionLog, { readonly modelCall: number; replied: boolean }>();

/**
 * 在一次模型呼叫的範圍裡跑 `call`：它內側的寫入點用 {@link currentModelCall} 讀得到識別。
 * 同時登記成這份日誌「最近開的那一次」（{@link lastModelCall}），並填進外層放的格子（{@link captureModelCall}）。
 *
 * @param log - 這次呼叫寫進的日誌。
 * @param modelCall - 這次呼叫的 `model/start` 的 `seq`。
 */
export function runInModelCall<T>(
  log: SessionLog,
  modelCall: number,
  call: () => T | Promise<T>,
): Promise<T> {
  lastCalls.set(log, { modelCall, replied: false });
  const probe = probes.getStore();
  if (probe !== undefined) {
    probe.log = log;
    probe.modelCall = modelCall;
  }
  return Promise.resolve(scopes.run({ log, modelCall, attempt: undefined }, call));
}

/**
 * 此刻所在那次模型呼叫的識別——**只在那次呼叫寫進的就是 `log` 這一份時**才給。
 * 不在任何呼叫範圍裡（標題請求、pump、測試直接叫）一律 `undefined`。
 */
export function currentModelCall(log: SessionLog): number | undefined {
  const scope = scopes.getStore();
  return scope !== undefined && scope.log === log ? scope.modelCall : undefined;
}

/**
 * 這份日誌**最近開的**那一次呼叫的 `model/start` `seq`；從沒開過、或那一次**已經記過正常回覆**是 `undefined`。
 *
 * 給「呼叫已經結束、寫入點不在範圍裡」的那一個用：人按停止，pump 在那一輪收尾時補記被切斷的半段回覆
 * （`assistant/message {interrupted}`）。一份日誌的模型呼叫是一次一個（子代理有自己的日誌），被切斷的那次
 * 通常就是最近開的那次。
 *
 * **最近那次已經有正常回覆就不給**：被切斷的那次是拋錯收的，沒有回覆。最近那次若已經回完，半段字就不是它的——
 * 例如摘要器自己叫模型產摘要（不經起訖紀錄器）時被停止。寧可標「—」也不掛到一次已經完整回覆的呼叫底下，
 * 讀方才不會看到同一次呼叫兩則回覆。**行程重啟就沒有**：這是行程內的記憶，不是日誌上的事實，只給當場補記用。
 */
export function lastModelCall(log: SessionLog): number | undefined {
  const last = lastCalls.get(log);
  return last === undefined || last.replied ? undefined : last.modelCall;
}

/** 起訖紀錄器記下一則正常回覆之後呼叫：那一次不再是「可能被切斷」的候選。 */
export function noteModelCallReplied(log: SessionLog, modelCall: number): void {
  const last = lastCalls.get(log);
  if (last !== undefined && last.modelCall === modelCall) last.replied = true;
}

/**
 * adapter 在**每次請求開跑**時呼叫（`fetch` 層，跟 `noteRequestStart` 同一個時刻），換來一個回報函式：請求的串流裡
 * 看到供應商的用量就用它回報（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）。
 *
 * ## 為什麼是 adapter 回報，不是記錄器自己讀
 *
 * 失敗的呼叫沒有回應物件可讀；v3 串流的模型層也收不到 token 回呼（pump 轉發的逐段片段不經模型的回呼）。
 * 供應商的用量只活在 `fetch` 回來的位元組裡，所以只有 adapter 手上有它——同 {@link ./llm-retry.ts} 的重試回報。
 *
 * ## 回報函式要在請求開跑時就拿住
 *
 * 串流是之後才被讀的，那時候已經不在這個範圍的 `AsyncLocalStorage` 裡，所以不能事後再問「現在屬於哪次呼叫」。
 * 每次請求各拿一個函式，**重試的下一次請求會換一格新的**（上一次的用量不算這一次的）。範圍外（標題那一顆、沒有日誌的
 * 呼叫、測試直接叫）回 `undefined`，呼叫端不回報。
 *
 * @returns 回報函式（後到的覆蓋先到的：供應商的用量在最後一則片段，累計值以最後一個為準）；不在範圍裡是 `undefined`。
 */
export function beginAttemptReport(): ((usage: AttemptUsage) => void) | undefined {
  const scope = scopes.getStore();
  if (scope === undefined) return undefined;
  const cell: AttemptCell = { usage: undefined };
  scope.attempt = cell;
  return (usage) => {
    cell.usage = usage;
  };
}

/**
 * 最近那次請求報回來的用量（還沒驗）；沒報、或這份日誌不是此刻範圍裡的那一份是 `undefined`。
 * 給用量記錄器在呼叫沒有正常回來時讀（它在起訖紀錄器內側，所以範圍還在）。
 */
export function reportedAttemptUsage(log: SessionLog): AttemptUsage | undefined {
  const scope = scopes.getStore();
  return scope !== undefined && scope.log === log ? scope.attempt?.usage : undefined;
}

/** {@link captureModelCall} 交回的識別。 */
export interface CapturedModelCall {
  /** 被夾在裡面的那次呼叫，寫進 `log` 這一份的識別；沒有（呼叫沒開成、或寫進別份）是 `undefined`。 */
  of(log: SessionLog): number | undefined;
}

/**
 * 跑 `call`，並回報它裡面**最近開的**那次模型呼叫的識別。給外層寫入點用（摘要器的 `context/measure`）。
 *
 * `call` 拋就照拋，不回報。裡面叫了不只一次內層（脈絡溢出）時，回報最後一次——外層正常回來的那一次。
 */
export async function captureModelCall<T>(
  call: () => T | Promise<T>,
): Promise<{ readonly result: T; readonly call: CapturedModelCall }> {
  const probe: CallProbe = { log: undefined, modelCall: undefined };
  const result = await probes.run(probe, call);
  return {
    result,
    call: { of: (log) => (probe.log === log ? probe.modelCall : undefined) },
  };
}

/** 把識別放進一筆事件的資料；沒有識別就一個 key 都不加（`undefined` 欄位會讓日誌拒收，見 `snapshotJsonValue`）。 */
export function withModelCall<D extends object>(
  data: D,
  modelCall: number | undefined,
): D & { readonly modelCall?: number } {
  return modelCall === undefined ? data : { ...data, modelCall };
}
