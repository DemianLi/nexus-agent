/**
 * 一次工具呼叫的**會話身分**：這次呼叫發生在 root agent 上，還是某一次 subagent 的執行裡。
 *
 * ## 為什麼要有這一層
 *
 * dsh 的模型工具直接問 `exec.agent.session`——**它自己擁有派發點**，所以身分是被塞進來的
 * （`packages/core/agent-loop/src/tool-calls.ts:78`，`ToolExecutionInput.agent` 的註解寫著
 * “set by the agent loop”）。我們的工具跑在 LangGraph 的 ToolNode 裡，那個派發點不是我們的，
 * 所以身分只能從執行期的 config 推出來。
 *
 * **這是 AGENTS.md 那條偏離規則的正例，不是偏好。** [#136](https://github.com/DemianLi/nexus-agent/pull/136)
 * 刻意避開執行期鍵，靠組裝期把工具換成拒絕樁——那條路走得通，是因為「拒絕 subagent」
 * **無條件**：不需要知道是哪一個 subagent，也不需要知道是第幾次 spawn。這裡要的是身分
 * 本身，而身分按定義是 per-run 的；組裝期表達得出的最細粒度是 **subagent 的名字**，
 * 同一個 subagent 併發兩次會被併成一格。所以退到執行期鍵，退到最接近的那一個。
 *
 * ## 鑰匙是 `checkpoint_ns`，而它整個包在這一個檔案裡
 *
 * LangGraph 的 `configurable.checkpoint_ns` 是**巢狀的圖命名空間**，用 `|` 分段，每一段是
 * 一次 task 的 id。實測（2026-09-01，調研見 `.docs/subagent-session-log-survey.md`）：
 *
 * | 情境 | `checkpoint_ns` |
 * | --- | --- |
 * | root 呼叫 | `tools:<自己的 task id>` |
 * | subagent 呼叫 | `tools:<父圖那次 task 呼叫的 id>｜tools:<自己的 task id>` |
 *
 * **最後一段是「這次工具呼叫」，前面的是「誰在跑」。** 去掉最後一段之後：
 *
 * - root 剩下空的 —— 分得出 root。
 * - 每一次 spawn 各一個，**循序與併發都各一個** —— 這就是 dsh 的粒度（per-session、
 *   每次 spawn 一份）。
 * - **同一次 spawn 裡叫幾次工具都是同一個** —— 前綴不變，變的是最後一段。
 *
 * ## 三件要記住的事
 *
 * 1. **格式沒有公開承諾。** `|` 這個分隔符查不到 LangGraph 的契約，只查得到它的行為。
 *    所以解析只准發生在這裡一次，而且 `session-address.test.ts` 逐條釘住上面那張表——
 *    升版把格式改掉時，紅的是那幾條解析測試，**不是「root 與 subagent 的狀態靜默合成
 *    一份」**。那個靜默失敗是這整條路上最貴的東西。
 * 2. **`ls_agent_type` 不是這裡的答案。** 它分得出 root／subagent，但它是 LangSmith
 *    tracing 的元資料（`ls_` 前綴），而且**它只有兩個值**——分不出「哪一次 spawn」。
 * 3. **認不出來時回 `undefined`，不要猜。** 沒有 `checkpoint_ns` 的呼叫（例如工具被直接
 *    叫、不在圖裡）如果被當成 root，兩份狀態就靜默合流了。照 dsh 那句註解的理由：
 *    “Reject rather than silently no-op”。
 *
 * @module
 */

/**
 * 一次呼叫屬於哪一個會話。
 *
 * 對到 dsh 的 `SessionHeader.origin`——它那側是 `undefined`（root）或 `'subagent'`，外加
 * `parentSession` 指回去。我們的 `runId` 同時扮演那兩格：它就是父圖裡那一次 `task` 呼叫，
 * 所以「是子代理」與「誰生的」是同一個值。
 */
export type SessionAddress =
  | { readonly kind: 'root' }
  | {
      readonly kind: 'subagent';
      /** 父圖裡那一次 `task` 呼叫的命名空間。**一次 spawn 一個**。 */
      readonly runId: string;
    };

/**
 * LangGraph 的巢狀圖命名空間分隔符。
 *
 * **抽成常數是為了讓它出現在測試的斷言裡。** 寫死在 `split()` 裡的話，升版換掉分隔符
 * 只會讓解析安靜地退化成「整串都是最後一段」＝所有呼叫都是 root，而那是靜默合流。
 */
const CHECKPOINT_NS_SEPARATOR = '|';

/** 從一份 `configurable` 裡把命名空間挖出來，形狀不對就當沒有。 */
function checkpointNamespace(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const configurable = (config as { configurable?: unknown }).configurable;
  if (typeof configurable !== 'object' || configurable === null) return undefined;
  const namespace = (configurable as { checkpoint_ns?: unknown }).checkpoint_ns;
  return typeof namespace === 'string' && namespace.length > 0 ? namespace : undefined;
}

/**
 * 認出一次工具呼叫的會話身分。
 *
 * @param config - 工具 handler 的**第二個參數**（LangChain 的 `ToolRunnableConfig`）。
 *   宣告不出第二個參數的工具永遠拿不到身分——那不是這裡的 bug，是那顆工具沒有要。
 * @returns 認得出來的身分，或 `undefined`（沒有 `checkpoint_ns`＝這次呼叫不在圖裡）。
 */
export function toolCallSessionAddress(config: unknown): SessionAddress | undefined {
  const namespace = checkpointNamespace(config);
  if (namespace === undefined) return undefined;
  const segments = namespace.split(CHECKPOINT_NS_SEPARATOR);
  // 最後一段是這次工具呼叫自己的 task，不是「誰在跑」。
  const owner = segments.slice(0, -1).join(CHECKPOINT_NS_SEPARATOR);
  return owner.length === 0 ? { kind: 'root' } : { kind: 'subagent', runId: owner };
}

/**
 * 身分的字串鍵，拿來當 Map 的 key。
 *
 * **前綴不能省。** 沒有 `subagent:` 的話，一個 `runId` 剛好等於 `'root'` 的 subagent 會撞上
 * root 那一格——不可能歸不可能，撞上去的下場是靜默合流，而這整個模組存在的理由就是不要
 * 有那種東西。
 *
 * @param address - 要編碼的身分。
 * @returns 唯一的字串鍵。
 */
export function sessionAddressKey(address: SessionAddress): string {
  return address.kind === 'root' ? 'root' : `subagent:${address.runId}`;
}
