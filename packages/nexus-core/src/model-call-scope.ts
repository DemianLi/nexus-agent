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

/** 起訖紀錄器為一次呼叫開的範圍，給它內側的寫入點讀。 */
interface CallScope {
  readonly log: SessionLog;
  readonly modelCall: number;
}

/** 外層放的格子，內層的起訖紀錄器填。 */
interface CallProbe {
  log: SessionLog | undefined;
  modelCall: number | undefined;
}

const scopes = new AsyncLocalStorage<CallScope>();
const probes = new AsyncLocalStorage<CallProbe>();
const lastCalls = new WeakMap<SessionLog, number>();

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
  lastCalls.set(log, modelCall);
  const probe = probes.getStore();
  if (probe !== undefined) {
    probe.log = log;
    probe.modelCall = modelCall;
  }
  return Promise.resolve(scopes.run({ log, modelCall }, call));
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
 * 這份日誌**最近開的**那一次呼叫的 `model/start` `seq`；從沒開過是 `undefined`。
 *
 * 給「呼叫已經結束、寫入點不在範圍裡」的那一個用：人按停止，pump 在那一輪收尾時補記被切斷的半段回覆
 * （`assistant/message {interrupted}`）。一份日誌的模型呼叫是一次一個（子代理有自己的日誌），被切斷的那次
 * 必定是最近開的那次。**行程重啟就沒有**：這是行程內的記憶，不是日誌上的事實，所以只給當場補記用。
 */
export function lastModelCall(log: SessionLog): number | undefined {
  return lastCalls.get(log);
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
