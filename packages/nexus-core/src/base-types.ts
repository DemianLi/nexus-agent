/**
 * 從基座型別導出的別名。
 *
 * 這些形狀的出處是 `deepagents` 的 `CreateDeepAgentParams`，不是我們自己定的——
 * 用索引存取而不是重打一份，是為了讓基座升版時 `tsc` 當場指出對不上的地方，而不是
 * 讓兩份定義各自漂走。順帶讓 `packages/nexus-core` 不必為了 `AgentMiddleware`
 * 與 checkpointer 的型別去相依 `langchain` 與 `@langchain/langgraph-checkpoint`
 * （版本範圍規則：每個 package 只宣告它直接 import 的那幾個）。
 */

import type { CreateDeepAgentParams } from 'deepagents';

/** 一個 middleware。基座把 `middleware` 收成陣列，這是它的元素型別。 */
export type AgentMiddleware = NonNullable<CreateDeepAgentParams['middleware']>[number];

/** 一個工具的核准設定。基座的 `boolean` 簡寫我們不產出——詞彙是封閉的。 */
export type InterruptOnConfig = Exclude<
  NonNullable<CreateDeepAgentParams['interruptOn']>[string],
  boolean
>;

/** 決定某一次工具呼叫要不要中斷的述詞。可以回 promise。 */
export type WhenPredicate = NonNullable<InterruptOnConfig['when']>;

/** 組裝點給的模型。 */
export type AgentModel = CreateDeepAgentParams['model'];

/** 組裝點給的 checkpointer。`false` 與缺席同義：沒有 checkpointer。 */
export type AgentCheckpointer = CreateDeepAgentParams['checkpointer'];

/** 組裝點給的 store。 */
export type AgentStore = CreateDeepAgentParams['store'];
