/**
 * 把協定 frame 折成一份可以直接畫出來的對話。
 *
 * **它住在 `@nexus/wire` 而不是 `apps/web`，理由不是「共用」，是測法。** 放在 web 裡
 * 它只驗得到手寫的 fixture，而手寫 fixture 會靜靜地與基座漂移——那正是
 * `stream-parity.test.ts` 當初存在的理由。放在這裡，`@nexus/harness` 的測試就能
 * **拿真的 agent 跑過真的線再折進來，跟 `invoke` 的結果對照**。這一層因此不得碰
 * DOM 或 React（本套件的 tsconfig 沒有 DOM lib，碰了就編不過）。
 *
 * ## subagent 的歸屬要自己 join，而且兩個口子明著標成「不知道」
 *
 * 基座的 `run.subagents` 投影給得出 `{ name, cause: { tool_call_id } }`，但**那是
 * 投影層算出來的，協定 frame 上一個字都沒有**（實測那個物件連 `path` 都沒有）。
 * 線上看到的只有 namespace 樹：subagent 的訊息長成
 * `["tools:<uuid>", "model_request:<uuid>"]`，而 `tools` 是節點名不是 subagent 名。
 *
 * 所以歸屬靠 join：巢狀 frame 的 `namespace[0]` ↔ 同一個 namespace 上那顆
 * `tool_name: "task"` 的 `tools` frame ↔ 它的 `input.subagent_type`。**這個 join 可靠**
 * ——實測一輪派兩個 `task` 出去時，每個呼叫拿到自己的 `tools:<uuid>`，兩條訊息逐字
 * 交錯但前綴不同。
 *
 * 兩種情況 join 不起來，一律標成 `unattributed` 而**不是猜一個**：
 *
 * 1. 訂閱時沒帶 `tools` channel——鑰匙根本沒上線。
 * 2. 重連之後才接上——`tools` frame 早就過去了，而這條線沒有重播（見開發計劃第 7 節決策 6）。歷史重抓
 *    （`GET /threads/:id/history`，[#306](https://github.com/DemianLi/nexus-agent/issues/306)）讀的是 root 那份
 *    日誌，子代理的訊息不在裡面，所以接不回這把鑰匙。
 *
 * 協定其實留了位子給這件事（`LifecycleData.cause`，註解明寫「Populated by …
 * deepagents' SubagentTransformer」），但 `deepagents@1.13.1` 沒填。哪天它填了，
 * 這個 join 就可以退休——`subagent-cause` 那條測試會是第一個發現的人。
 */

import { CONTEXT_MEASURE, MODEL_USAGE } from './context-pressure.js';
import type { WireContextMeasure, WireContextPressure } from './context-pressure.js';
import type { CustomFrameName } from './custom-frame.js';
import { DELIVERABLES_PRESENTED } from './deliverables.js';
import { IMAGE_MEDIA_TYPES } from './attachments.js';
import type { WireAttachmentRef } from './attachments.js';
import { AGENT_MESSAGE, INBOX, SETTLE_NOTICE, isSettleReason } from './inbox.js';
import type {
  WireQueuedInput,
  WireQueuedInputSource,
  WireSessionReference,
  WireSettleReason,
} from './inbox.js';
import { COMPACTION } from './compaction.js';
import { GOAL, GOAL_PHASES } from './goal.js';
import { MESSAGE_DISCARD } from './message-discard.js';
import type { WireGoal, WireGoalPhase } from './goal.js';
import { PLAN_MODE } from './plan-mode.js';
import { PROJECTION, PROJECTION_KEY_PATTERN } from './projection.js';
import type { WireProjection } from './projection.js';
import type { PlanModePayload } from './plan-mode.js';
import { SESSION_STATS, TOKEN_USAGE } from './session-totals.js';
import type { WireSessionStats, WireTokenUsage } from './session-totals.js';
import { SUBAGENT_CATALOG } from './subagent-catalog.js';
import type { SubagentCatalogPayload } from './subagent-catalog.js';
import { SUBAGENT_STATUS } from './subagent-status.js';
import type { SubagentRunStatus } from './subagent-status.js';
import { TITLE } from './title.js';
import { TODOS } from './todos.js';
import type { WireTodoItem } from './todos.js';
import type { WirePresentedFile } from './deliverables.js';
import { WORKSPACE_CHANGES } from './workspace-changes.js';
import type { Event } from './protocol.js';

/** 一則東西是誰說的。 */
export type Attribution =
  | { readonly kind: 'root' }
  | { readonly kind: 'subagent'; readonly name: string; readonly callId: string }
  | { readonly kind: 'unattributed'; readonly namespace: readonly string[] };

export interface HumanEntry {
  readonly kind: 'human';
  readonly id: string;
  readonly text: string;
  /** 這一句出現在線上的時刻，見 {@link ConversationEntry} 的「時刻」。 */
  readonly startedAt?: number;
  /**
   * 這一則是送出佇列的哪一件開跑時畫的（`inbox` 的 `claimed.id`）。同一顆 `claimed` 再到一次靠它認出來，不畫第二次。
   * 歷史重播的人話沒有這一格。
   */
  readonly inboxId?: string;
  /**
   * 這一句 `@` 的會話（[#713](https://github.com/DemianLi/nexus-agent/issues/713)），照出現先後。`text` 裡對應的那段是
   * `@<label>`，畫面據它把那一段畫成點得開的引用。沒有引用就不給這一格。
   */
  readonly references?: readonly WireSessionReference[];
  /**
   * 這一句帶的附件（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：**參照，不是位元組**，照使用者選取的順序。
   * 圖與檔案由 `type` 判別。沒有附件就不給這一格（空陣列與沒給是同一件事）。
   */
  readonly attachments?: readonly WireAttachmentRef[];
}

/**
 * 「這一輪（或這一步）是被什麼叫醒的」（[#851](https://github.com/DemianLi/nexus-agent/issues/851)）：目前只有背景子代理的
 * 結算通知。落在**觸發訊息本來會出現的位置**——人話的泡泡出現的地方——所以畫面能在模型的回覆前面畫出來由。
 *
 * **不帶文字**：通知的字是給模型的英文，畫面不顯示它；帶的是怎麼收的（{@link NoticeEntry.reason}，#884），字由畫面自己配。即時（`inbox` 的 `claimed`／`claimedNextStep`）與歷史重播
 * （{@link SETTLE_NOTICE}）長出同一種東西，重新整理後畫面不變。不影響 `status`、`pendings`，也不會是 {@link AiEntry.turnTail}。
 */
export interface NoticeEntry {
  readonly kind: 'notice';
  /** 即時是 `inbox:<件的 id>`（跟排著時那一行的 key 同一個，同一格換成正式的）；歷史是 `history-<seq>`。 */
  readonly id: string;
  /** 通知的來源。今天只有 `subagent-settled`；`agent-message`（#849）的顯示是另一件，這裡不長。 */
  readonly source: 'subagent-settled';
  /**
   * 怎麼收的（[#884](https://github.com/DemianLi/nexus-agent/issues/884)）：完成、被停止、超出上限、失敗。
   * **沒有這一格＝不知道**（格式 26 以前的日誌）：畫面退成中性的說法，不假裝成「已完成」。
   */
  readonly reason?: WireSettleReason;
  /** 即時的那一種是送出佇列的哪一件（`inbox` 的 `claimed.id`），同一顆 `claimed` 再到一次靠它認出來。歷史的沒有。 */
  readonly inboxId?: string;
  /** 這則通知出現在線上的時刻，見 {@link ConversationEntry} 的「時刻」。 */
  readonly startedAt?: number;
}

/**
 * 背景子代理用 `send_message` 寫給主對話的話（[#863](https://github.com/DemianLi/nexus-agent/issues/863)）：畫成「某某子代理說：…」，
 * 不是人的泡泡。方向永遠是子代理→主對話；主對話→子代理是主對話自己那顆 `send_message` 的工具卡。
 *
 * 落在**這則話被領走的位置**：主對話閒著時它叫醒的那一輪的開頭，忙著時插進那一輪的那一刻。即時（`inbox` 的
 * `claimed`／`claimedNextStep`）與歷史重播（{@link AGENT_MESSAGE}）長出同一種東西。不影響 `status`、`pendings`，也不會是 {@link AiEntry.turnTail}。
 */
export interface AgentMessageEntry {
  readonly kind: 'agent-message';
  /** 即時是 `inbox:<件的 id>`；歷史是 `history-<seq>`。 */
  readonly id: string;
  /** 寄件的背景子代理的會話 id。 */
  readonly senderSessionId: string;
  /** 它的編號，對得上委派卡（`background-subagent` 的 `runId`）。 */
  readonly runId: string;
  /** 它寫的話，**已拿掉給模型看的 `Agent <寄件人> sent a message: ` 前綴**。 */
  readonly text: string;
  /** 即時的那一種是送出佇列的哪一件，同一顆 `claimed` 再到一次靠它認出來。歷史的沒有。 */
  readonly inboxId?: string;
  /** 這則話出現在線上的時刻，見 {@link ConversationEntry} 的「時刻」。 */
  readonly startedAt?: number;
}

export interface AiEntry {
  readonly kind: 'ai';
  readonly id: string;
  readonly text: string;
  /**
   * 模型的推理（[#527](https://github.com/DemianLi/nexus-agent/issues/527)），沒有就不給。收的是
   * `reasoning-delta`，歷史由 harness 從日誌那則的 `reasoning` 區塊投成同一種 delta，所以重新整理之後還在。
   *
   * **一則裡的推理攤平成一串，同 {@link AiEntry.text}**。dsh 的助手節點按 `index` 留一串區塊、照順序畫
   * （`ui-chat` 的 `conversation-nodes/assistant.ts`，`ddefc45`），這裡丟掉了區塊的順序與個數——偏離，
   * 2026-09-23 拍板。代價今天是零：我們唯一的 adapter（OpenAI completions）一則最多產一塊推理。線上
   * 與日誌都還留著按 `index` 的區塊，哪天要照 dsh 改成區塊清單，來源都在。
   *
   * **只有推理、正文是空的那則也是一則**：模型只想、只呼叫工具的那幾步就是這樣。
   */
  readonly reasoning?: string;
  /** 還在吐字。`message-finish` 之後為 false。 */
  readonly streaming: boolean;
  readonly attribution: Attribution;
  readonly error?: string;
  /**
   * 講到一半被人按了停止（[#276](https://github.com/DemianLi/nexus-agent/issues/276)）。**只標在那一刻
   * 還在吐字的那幾則上**：講完的那些不是被打斷的。伺服器那側把這半段存回對話，下一輪模型看得到
   * 它說到哪。
   */
  readonly stopped?: true;
  /**
   * 那則回覆在日誌裡的訊息 id，**評分指名的就是它**（[#382](https://github.com/DemianLi/nexus-agent/issues/382)）。
   * 取自 `message-start` 的 `id`：即時的是串流層給的那個，量過等於日誌 `assistant/message` 記的；重播的由
   * server 照日誌填。沒有這一格的（日誌沒記 id）評不了。
   *
   * **不是 {@link AiEntry.id}**：entry 的 key 是 `run_id`，因為逐字片段只帶它。
   */
  readonly messageId?: string;
  /**
   * 這一輪收尾的那一則：一輪結束時，那一輪裡最後一則有文字的 root 回覆。評分按鈕放在它上面，同 dsh 的
   * `TurnTailNodeView` 取收尾節點（`ddefc45`）。
   *
   * **「有文字」是正文去掉空白之後還有字，推理不算**（[#572](https://github.com/DemianLi/nexus-agent/issues/572)），
   * 同 dsh `conversation-nodes/turn-tail.ts` 的 `hasText`。模型呼叫工具之前常先吐一段 `"\n\n"`；web 把這種
   * 正文當成空的、整則不畫，收尾落在它上面的話，這一輪的讚踩就跟著不見。**續接不切輪**：停在核准點不是收尾，續接之後算的是整輪。
   * 判法見 {@link reduceConversation}，即時與歷史走同一條。
   */
  readonly turnTail?: true;
  /**
   * 這一輪撞到了模型的輸出上限（[#433](https://github.com/DemianLi/nexus-agent/issues/433)）：標在那一輪**最後一則
   * root 回覆**上，有沒有字都標。讀的是 root 那顆收尾 `lifecycle` 上 pump 補的 `maxTokens`，同 {@link AiEntry.stopped}
   * 讀 `aborted`。**一輪一格，不是一則一格**：日誌的 `turn/end` 是 sticky 的，前面某一步撞到、後面收掉也算。
   *
   * dsh 在收尾那則助手與輪尾之間畫一個提示節點（`ui-chat` 的 `conversation-nodes/turn-max-tokens.ts`，`477b4f4`）；
   * 畫法歸畫面那一側，這裡只帶資料。
   */
  readonly maxTokens?: true;
  /**
   * `message-start` 的時刻。**兩條路的意思差一段首字等待（TTFT）**：即時是第一個字到的那一刻（`message-start` 跟它一起到，
   * 同 dsh 的 `firstTokenTime`，不是 `stepStartTime`）；歷史重播是**這則回覆所屬那一次模型呼叫開始**的時刻（日誌
   * `model/start`，由 `assistant/message.modelCall` 指到，同 dsh 的 `stepStartTime`），所以重新整理之後它早於
   * {@link AiEntry.settledAt}、差的是整次呼叫的耗時（#1048；以前取落盤那一刻，兩格相等）。差距就是 TTFT，腳本模型
   * 的量測見 `wire-entry-timestamps.test.ts`。dsh 重新整理後還留得住 `firstTokenTime`，是因為它的日誌記了逐字的
   * `stream`；我們的日誌沒有（寫入點看不到逐字片段），所以歷史拿不到首字時刻。日誌沒有 `modelCall` 的舊回覆退回
   * 落盤的時刻（兩格相等）。見 {@link ConversationEntry} 的「時刻」。
   */
  readonly startedAt?: number;
  /** 講完的時刻：`message-finish`、`error`，或講到一半被停止時收尾那顆 `lifecycle` 的時刻。還在吐字就沒有。 */
  readonly settledAt?: number;
}

export interface ToolEntry {
  readonly kind: 'tool';
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  /** 參數照線上給的原樣留著（基座給的是 JSON 字串），不在這一層猜它的形狀。 */
  readonly input: string;
  /**
   * 這次呼叫走到哪裡了。
   *
   * **`suspended` 是「停下來等人」，不是一種失敗。** 中斷是用拋例外實作的，所以在基座
   * 眼裡它跟工具炸了走同一條路；分類做在 `thread-pump.ts` 的 `classifyToolData`，這一層
   * 收到的是已經分好的 `tool-suspended`。少了這一格，一顆還沒被回答的問題在畫面上是紅字
   * 「失敗」（[#239](https://github.com/DemianLi/nexus-agent/issues/239) 實測）。
   *
   * **只給本體拋了中斷的那顆**（問答；子代理照 dsh 不停下來等人，[#324](https://github.com/DemianLi/nexus-agent/issues/324)）。
   * 停在核准閘門上的那顆本體沒被呼叫到，照 dsh 是
   * `running`——dsh 的工具卡沒有「等人」那一格，等待由核准卡表示（[#317](https://github.com/DemianLi/nexus-agent/issues/317)）。
   *
   * **而 `done` 不等於「成功了」的那一半也一起收了**：一則 `status: 'error'` 的
   * ToolMessage 走的是 `tool-finished`，pump 會補一格 `failed`，這裡讀它。兩面不一起收的
   * 話，「掛著的不顯示失敗」單獨綠得起來——把全部都畫成「執行中」也會綠。
   */
  readonly status: 'running' | 'suspended' | 'done' | 'failed';
  /**
   * 這次呼叫的**結果文字**，成功與失敗都有
   * （[#439](https://github.com/DemianLi/nexus-agent/issues/439)）。
   *
   * 就是模型收到的那一段（harness 從會話日誌的 `tool/result` 抽，兩條路共用同一個規則），
   * 同 dsh：工具卡的內容是那則結果的 content，`isError` 只是另一個旗標。**內容不是剛好一塊
   * 文字時這一格不給**（照 dsh 的 `singleResultText`，不自己把幾塊拼起來）。**不截**：上限在模型面
   * （外溢層換成預覽加路徑，日誌記的就是那則），日誌到這裡照 dsh 原樣（[#736](https://github.com/DemianLi/nexus-agent/issues/736)）。
   *
   * **`tool-finished` 失敗的那些，{@link ToolEntry.error} 裝的是同一串字**：紅字那一格留給
   * 畫面，判斷畫哪一種看 {@link ToolEntry.status}。`tool-error`（本體炸了、基座那條路）只寫
   * `error`，那一顆線上本來就沒有結果訊息可抽。
   */
  readonly text?: string;
  readonly error?: string;
  /**
   * 失敗的**錯誤碼**（[#667](https://github.com/DemianLi/nexus-agent/issues/667)）：判斷「這張卡是怎麼失敗的」讀這一格，
   * 不讀 {@link ToolEntry.error} 的字。照 dsh，碼跨線、畫面比碼（`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:76`
   * 把 `data.error` 原樣交給 client，`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:289` 比
   * `error?.code`）。
   *
   * - 日誌 `tool/result.error.code` 的那個碼，由 harness 放在失敗的 `tool-finished` 上（例如停在核准點或提問時按了
   *   停止是 `ABORTED_BEFORE_DISPATCH`）；`tool-error` 帶了 `code` 也照抄。
   * - 一輪關掉時還沒有結果的卡，折疊器自己補 {@link UNFINISHED_TOOL_CODE}，同 dsh 替沒結果的卡合成的 `'interrupted'`。
   * - 線上沒有碼就是 `undefined`；成功的卡沒有這一格。
   */
  readonly errorCode?: string;
  /**
   * 給專屬卡畫的**結構化結果**（[#617](https://github.com/DemianLi/nexus-agent/issues/617)）：讀檔讀到
   * 哪幾行、搜尋命中什麼、改檔改了哪幾段。照 dsh 的 `tool/result.meta`，**對這一層不透明**——形狀歸
   * 工具，由畫面那一側的卡片模型自己驗，驗不過就走 generic。
   *
   * 只有成功的才有；模型看不到它。太大的由 harness 截過或整格拿掉：搜尋與改檔的上限是 harness `tool-text`
   * 那一列的 `maxBytes`，讀檔是它的兩倍（[#630](https://github.com/DemianLi/nexus-agent/issues/630)）。
   * 格式 16 以前的日誌接回來沒有這一格。
   */
  readonly meta?: unknown;
  /**
   * 這一顆委派呼叫派出的子代理是哪一份會話（[#1023](https://github.com/DemianLi/nexus-agent/issues/1023)）：`id` 是子會話
   * 日誌的 id，拿它去找那個子代理的軌跡與用量。前景與背景都有，來源是 root 日誌的 `subagent/catalog`（見 `subagent-catalog.ts`）。
   *
   * **沒有這一格不等於沒派出子代理**：格式 31 以前的日誌沒記，派出去但子代理一筆都沒寫就失敗的也沒有。
   */
  readonly subagentSession?: {
    readonly id: string;
    readonly mode: SubagentCatalogPayload['mode'];
  };
  readonly attribution: Attribution;
  /**
   * 這次呼叫**第一次**出現在線上的時刻（`tool-started`），同 dsh 結果節點的 `callTime`。
   *
   * **同一個 `tool_call_id` 再到一次不換**：即時那條本來就會到兩次（pump 從日誌 `tool/call` 開卡、基座的
   * `tool-started` 晚到），續接時（答了中斷、圖從 tools 節點重跑）基座與日誌也都再發一次。dsh 不重派，
   * `callTime` 就是那一顆 `tool/call` 的時刻，等核准、等回答的時間算在裡面；這裡取第一顆，意思相同。
   */
  readonly startedAt?: number;
  /**
   * 這張卡落定的時刻：最後一顆 `tool-finished`（pump 的更正幀照這一顆換掉，同 {@link ToolEntry.text}）、`tool-error`，或
   * 一輪關掉時還沒有結果、由收尾那顆 `lifecycle` 收成失敗的時刻（同 dsh 替沒結果的卡合成的那則用收尾邊界的時刻）。
   * 被翻回執行中（續接、晚到的 `tool-started`）就拿掉。執行中與等人回答時沒有。
   */
  readonly settledAt?: number;
}

/**
 * 人在核准點上按了什麼。
 *
 * **這一則只有本地記得：下行不回聲決定。** 被拒的那顆呼叫在下行上有卡——pump 從會話日誌的
 * `tool/call` 開、`tool/result` 收，畫成失敗、紅字是拒絕理由
 * （[#297](https://github.com/DemianLi/nexus-agent/issues/297)，`apps/harness/src/rejection-wire.test.ts`）
 * ——但卡說的是「這顆沒執行、模型看到了什麼」，**不說人按了什麼**：同一張失敗的卡也可能來自
 * 規則直接擋、或沒有核准管道。我們沒有 dsh 的 `approval/asked`／`approval/decided`
 * （[#220](https://github.com/DemianLi/nexus-agent/issues/220) 認帳不做），所以決定要跟
 * 所以決定要在送出的那一刻自己寫進來，與那張卡並存——那不是裝飾，是唯一的紀錄。
 */
export interface DecisionEntry {
  readonly kind: 'decision';
  readonly id: string;
  /** 詞彙由基座定（`approve` / `reject`），這一層不窄化它。 */
  readonly decision: string;
  /**
   * 這個決定套到哪幾筆工具呼叫上——**這一顆中斷的**全部，全有全無。
   *
   * 界線就在中斷上：同一輪的其他中斷各答各的，不會被這個決定碰到
   * （[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
   */
  readonly actions: readonly string[];
}

/**
 * 人回答了一顆**問答**中斷。
 *
 * 與 {@link DecisionEntry} **是兩個 kind 不是一個加寬的**：核准的紀錄是「一個決定套到
 * 哪幾筆工具呼叫上」，問答的紀錄是「哪一題選了什麼」——欄位不同、畫面畫法不同，加寬
 * 會讓兩邊的渲染與斷言都得先問「這一則到底是哪一種」。
 *
 * 理由與 {@link DecisionEntry} 同一條：**下行沒有一個欄位說「人答了什麼」**，所以送出的
 * 那一刻自己寫進來，那是唯一的紀錄。
 */
export interface AnswerEntry {
  readonly kind: 'answer';
  readonly id: string;
  /**
   * 人按了「放棄整組問題」。
   *
   * **這不是「每一題都跳過」**，兩者在模型那頭是不同的事：全跳過仍然是一份答案，
   * 工具正常回傳；放棄則讓工具**收到錯誤**，模型知道人不打算走這條路了
   * （dsh 的 `ASK_CANCELLED`）。所以它是同一個 kind 裡的一格，不是一則假答案。
   */
  readonly cancelled?: true;
  /**
   * 人按了「拒絕」（[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)，MCP elicitation）：**明確說不給**，
   * 不是放棄（`cancelled`）也不是每題跳過。三者在 MCP 那頭是三種動作——`accept`（有 `answers`）、`decline`（本欄）、`cancel`（`cancelled`）。
   * 只有 {@link PendingQuestion.origin} 是 MCP 反問時才會出現。
   */
  readonly declined?: true;
  /** 逐題的答案，順序同問題。空的 `selected` 且沒有 `custom` ＝ 那一題被跳過。 */
  readonly answers: readonly {
    readonly id: string;
    readonly selected: readonly string[];
    readonly custom?: string;
  }[];
}

/**
 * 一次成功的 `present` 宣告交付的檔案（[#441](https://github.com/DemianLi/nexus-agent/issues/441) 的第二刀）。
 * 來源是 `custom` frame，`data.name` 為 {@link DELIVERABLES_PRESENTED}，見 `deliverables.ts`。
 *
 * **它是獨立的一格，不掛在那張 `present` 工具卡上**：往前翻頁可能剛好切在工具卡與交付 frame 之間，卡在
 * 較早那一頁、frame 在較晚那一頁，折較晚那頁時找不到卡。獨立一格就沒有這個問題，
 * {@link prependEntries} 原樣接上。
 *
 * 落在串流裡的位置就是它在 `entries` 裡的位置。它不影響 `status`、`pendings`，也不會是
 * {@link AiEntry.turnTail}：畫面要按輪歸位時由 human 那一格切輪，不靠輪尾。
 */
export interface DeliverablesEntry {
  readonly kind: 'deliverables';
  /** `deliverables:<callId>`：確定值，當 React key。同一個 `callId` 第二次出現就忽略，同 harness 的配套入口。 */
  readonly id: string;
  /** 那次 `present` 呼叫的 `tool_call_id`。 */
  readonly callId: string;
  /** 那顆事件在 root 日誌裡的 `seq`，配上檔案在 {@link files} 裡的位置就是讀檔路由的座標（#452）。 */
  readonly seq: number;
  /** 交付的檔案，順序照模型給的。 */
  readonly files: readonly WirePresentedFile[];
  /** 這次交付出現在線上的時刻，見 {@link ConversationEntry} 的「時刻」。 */
  readonly startedAt?: number;
}

/**
 * 模型的歷史在這裡換成了一份摘要（[#896](https://github.com/DemianLi/nexus-agent/issues/896)）。來源是 `custom`
 * frame，`data.name` 為 {@link COMPACTION}，見 `compaction.ts`。
 *
 * 獨立的一格、落在它在串流裡的位置，跟 {@link WorkspaceChangesEntry} 同形：不影響 `status`、`pendings`，也不會是
 * {@link AiEntry.turnTail}；{@link prependEntries} 原樣接上。**不取代**被它蓋掉的那些列，畫面上的對話一則都沒少。
 */
export interface CompactionEntry {
  readonly kind: 'compaction';
  /** `compaction:<seq>`：確定值，當 React key。同一個 `seq` 第二次出現就忽略。 */
  readonly id: string;
  /** 那顆 `compaction/summary` 在 root 日誌裡的 `seq`。 */
  readonly seq: number;
  /** 前幾則原始訊息已被換成摘要，見 `compaction.ts`。 */
  readonly cutoff: number;
  /** 被壓掉的原文有沒有存成檔。 */
  readonly saved: boolean;
  /** 摘要全文，沒有就是沒有。 */
  readonly summary?: string;
  /** 這次壓縮出現在線上的時刻，見 {@link ConversationEntry} 的「時刻」。 */
  readonly startedAt?: number;
}

/**
 * 一輪改動了工作區哪些檔的指標（[#443](https://github.com/DemianLi/nexus-agent/issues/443)）。來源是 `custom`
 * frame，`data.name` 為 {@link WORKSPACE_CHANGES}，見 `workspace-changes.ts`。
 *
 * **只帶 `seq`**：摘要留在 server，web 拿它去 `changes/summary` 要，回 404 就不畫（serve 重開之後一定是 404）。
 * 它跟 {@link DeliverablesEntry} 一樣是獨立的一格、落在它在串流裡的位置：web 的對話狀態裡沒有 `turn/start`，
 * 「由 `seq` 往前找 `turn/start` 認輪」在那頭做不到，所以認輪交給這一格的位置，同交付卡由 human 那一格切輪。
 * 不影響 `status`、`pendings`，也不會是 {@link AiEntry.turnTail}；{@link prependEntries} 原樣接上。
 */
export interface WorkspaceChangesEntry {
  readonly kind: 'workspace-changes';
  /** `workspace-changes:<seq>`：確定值，當 React key。同一個 `seq` 第二次出現就忽略。 */
  readonly id: string;
  /** 那顆 `workspace/changes` 在 root 日誌裡的 `seq`，兩條路由拿它定位摘要。 */
  readonly seq: number;
  /** 這份改動紀錄出現在線上的時刻，見 {@link ConversationEntry} 的「時刻」。 */
  readonly startedAt?: number;
}

/**
 * 畫面上的一格。
 *
 * ## 時刻（[#1030](https://github.com/DemianLi/nexus-agent/issues/1030)）
 *
 * `startedAt`／`settledAt` 是 Unix epoch 毫秒，**取自長出（或收掉）那一格的 frame 的 `params.timestamp`**，折疊器自己
 * 不看時鐘。照 dsh：每種節點都帶來源事件的時刻（`ui-conversation` 的 `contract/records.ts`，`5badb15`）。
 *
 * - **一個時刻的**（人話、通知、子代理來信、交付、改動紀錄、壓縮）只帶 `startedAt`，同 dsh 那幾種節點只有一個 `time`。
 * - **有起訖的**（模型回覆、工具卡）兩格都帶：規則見 {@link AiEntry.startedAt}、{@link ToolEntry.startedAt}。
 * - **人按的決定與答案**（{@link DecisionEntry}、{@link AnswerEntry}）不帶：它們不是從線上來的，沒有 frame 可取，
 *   用瀏覽器的時鐘補會跟其餘的格混用兩個時鐘。
 *
 * **兩條路的時鐘不同**：歷史重播的 frame 帶的是日誌那一筆的 `time`；即時的是基座 frame 原帶的、或 pump 合成
 * 那一刻的 `Date.now()`。實測（`@nexus/harness` 的 `wire-entry-timestamps.test.ts`）只有模型回覆的 `startedAt` 不同：
 * 即時是第一個字到的那一刻、歷史是那一次模型呼叫開始（差一段首字等待，見 {@link AiEntry.startedAt}）；其餘的格兩條路只差幾毫秒。frame 沒帶可用的時刻（不是正的有限數字）就不給那一格，
 * 理由見 {@link wireTime}。
 */
export type ConversationEntry =
  | HumanEntry
  | AiEntry
  | ToolEntry
  | DecisionEntry
  | AnswerEntry
  | DeliverablesEntry
  | WorkspaceChangesEntry
  | NoticeEntry
  | AgentMessageEntry
  | CompactionEntry;

/**
 * 型別窄化：這一顆是核准請求嗎。
 *
 * 有這一對是因為**兩種中斷會同時掛在 `pendings` 裡**，而消費者幾乎都只關心其中一種
 * （狀態列列工具名、送出框判卡死、測試取那一顆核准）。少了它，每個消費點各自寫
 * `.kind === 'approval'` 的字串比對——比對錯了型別不會擋，因為那是一個字串。
 */
export function isApprovalPending(pending: PendingInput): pending is PendingApproval {
  return pending.kind === APPROVAL_PENDING_KIND;
}

/** 型別窄化：這一顆是問答請求嗎。見 {@link isApprovalPending}。 */
export function isQuestionPending(pending: PendingInput): pending is PendingQuestion {
  return pending.kind === QUESTION_PENDING_KIND;
}

/**
 * 這一輪的狀態。
 *
 * `awaiting-input` 是停在核准點——**不是結束**。基座在中斷時照樣發
 * `lifecycle completed / root`，所以那顆不能當「跑完了」用（決策 6 第 2 條）。
 *
 * `stopped` 是人按了停止、這一輪收了——**不是失敗**（[#276](https://github.com/DemianLi/nexus-agent/issues/276)）。
 * 它讀的是 root 那顆收尾 `lifecycle` 上的 `aborted`：那一格是 pump 補的分類，協定的 `AgentStatus`
 * 沒有「被中止」這一種（`interrupted` 是停下來等輸入），而被切斷的那一次基座發的是 `failed`。
 */
export type ConversationStatus = 'idle' | 'running' | 'awaiting-input' | 'failed' | 'stopped';

/** 判別式的值。**與 `@nexus/core` 的兩個常數是同一組字串**，見 {@link reduceInputRequested}。 */
export const APPROVAL_PENDING_KIND = 'approval';
export const QUESTION_PENDING_KIND = 'question';

/**
 * 問人的一題。形狀照抄 dsh 的 `AskUserQuestionItem`：模型面的五格，加上只有內部生產者會填的
 * `detail` 與 `intent`（[#652](https://github.com/DemianLi/nexus-agent/issues/652)：`exit_plan_mode`
 * 的計劃審核）。**兩格都原樣從中斷酬載帶過來**，`reduceInputRequested` 不挑欄位。
 *
 * 生產者那側的同一份形狀在 `@nexus/core` 的 `QuestionInterruptItem`（這個套件不相依 core，所以各寫一份）。
 */
export interface QuestionItem {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  /** 跟著這一題一起畫、但不進選項標籤的補充內容。計劃審核把計劃全文（Markdown）放在這裡。 */
  readonly detail?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
  /** 純呈現用：認得的 UI 照它畫，不認得的照一般提問畫。**答法兩邊一樣**，送回的都是選項標籤。 */
  readonly intent?: PlanReviewIntent;
}

/**
 * 這一題**就是**一次計劃審核。照 dsh 的 `AskUserQuestionIntent`。
 *
 * `approve` 是同意那個選項的**標籤**，其餘選項都是不同意——用名字不用位置。`callId` 是參數裡
 * 裝著這份計劃的那顆工具呼叫，歷史重播時計劃卡從那顆呼叫的參數畫。
 */
export interface PlanReviewIntent {
  readonly kind: 'plan-review';
  readonly approve: string;
  readonly callId?: string;
}

interface PendingCommon {
  readonly interruptId: string;
  /**
   * 這顆中斷掛在哪一層。回答時原樣送回去。
   *
   * 目前 handler 用不到它（`Command({ resume })` 直接接在 root 上），但協定的
   * `input.respond` 要它，而下行只發這一次——這裡丟掉就再也接不回來了。
   */
  readonly namespace: readonly string[];
}

/** 停在核准點：這一顆中斷的那批工具呼叫，等一個決定。 */
export interface PendingApproval extends PendingCommon {
  readonly kind: typeof APPROVAL_PENDING_KIND;
  readonly actions: readonly {
    readonly name: string;
    readonly args: unknown;
    readonly description?: string;
  }[];
  /**
   * 這一批**共同**允許的決定——逐筆 `allowedDecisions` 的交集。
   *
   * 交集而不是 `[0]`、也不是聯集：一個決定要套到**這一顆中斷的**整批上（全有全無，見
   * {@link DecisionEntry}），而基座對不在那一筆清單裡的決定是當場拋
   * （`langchain@1.5.10`，`hitl.js:407`）——多出來的那顆按鈕按下去是整場 run 死。
   */
  readonly allowedDecisions: readonly string[];
}

/**
 * 這組問題是哪裡問的（[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)）。省略＝模型自己問的（`ask_user_question`、計劃審核），
 * 畫面照舊。
 *
 * **超出 dsh**：dsh 的 `mcp-client` 宣告的 client capabilities 是 `{}`（`packages/mcp/mcp-client/src/connection.ts:261`，`5badb150`），
 * 沒有 elicitation，所以沒有對應物。做它的理由是 demian 2026-10-08 指示（見卡上的 PM 決策）：MCP server 執行到一半反問使用者，
 * 以前那一次呼叫會落成普通工具錯誤。形狀是我們定的，只加不減：舊 client 不認得這一格時把它當一般提問畫，答法不變。
 *
 * 畫面要讓人看得出**是哪台 server、哪支工具在問，用的是什麼有效參數**——一個不說來源的問答卡，讓人不知道自己在回答誰。
 */
export interface QuestionOrigin {
  readonly kind: 'mcp-elicitation';
  /** 反問的 MCP server 名（設定裡的名字）。 */
  readonly server: string;
  /** 那次呼叫的工具名。 */
  readonly tool: string;
  /** 那次呼叫的**有效參數**（經過模型與政策之後實際送出的）。純 JSON。 */
  readonly arguments: unknown;
}

/** 停在問答點：模型問了一組問題，等人填。 */
export interface PendingQuestion extends PendingCommon {
  readonly kind: typeof QUESTION_PENDING_KIND;
  readonly questions: readonly QuestionItem[];
  /** 這組問題是哪裡問的；省略是模型自己問的。見 {@link QuestionOrigin}。 */
  readonly origin?: QuestionOrigin;
}

/**
 * 掛著等人回答的一顆中斷。
 *
 * **判別聯集，不是一個型別加可選欄位。** 兩種的送出形狀完全不同
 * （`{decisions:[…]}` 對 `{answers:[…]}`），可選欄位會讓每一個消費者自己去猜哪些欄位
 * 這次有值——而猜錯的樣子是「把答案送給核准那條路」，沒有型別會擋。
 */
export type PendingInput = PendingApproval | PendingQuestion;

export interface ConversationState {
  readonly entries: readonly ConversationEntry[];
  readonly status: ConversationStatus;
  readonly error?: string;
  /**
   * 掛著等人回答的中斷，**逐顆並存**，發出的順序。
   *
   * 同一輪裡兩個工具都要核准時，閘門逐次呼叫各自 `interrupt()`，線上就是兩顆
   * `input.requested`（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
   * 這裡曾經是單一插槽，第二顆進來會把第一顆整個蓋掉——畫面少一張卡，而那顆看不見的
   * 中斷照樣被同一個決定套到。
   *
   * **用 `interruptId` 認人，重複的覆寫而不是追加**：答掉其中一顆之後，沒被答到的
   * 那些會**帶著原本那顆 id 再度中斷**（實測），所以同一顆會在線上出現不只一次。
   */
  readonly pendings: readonly PendingInput[];
  /** 收過的最大 seq。線上是單調的（server 端跨 run 重編過號），拿它擋重複與亂序。 */
  readonly lastSeq: number;
  /** `namespace[0]` → 那個 `task` 呼叫派出去的 subagent。 */
  readonly subagents: Readonly<Record<string, { readonly name: string; readonly callId: string }>>;
  /** 目前這一輪從 `entries` 的哪一格開始，見 {@link AiEntry.turnTail}。 */
  readonly turnStart: number;
  /**
   * 這條對話現在多大、離自動摘要還有多遠（#528）。**一顆都還沒收到就是 `null`**。只算 root；兩格各自是最新
   * 那一筆，規則見 `context-pressure.ts`。它是「現在」的事，所以 {@link prependEntries} 不動它。
   */
  readonly contextPressure: WireContextPressure | null;
  /**
   * 模型的待辦清單（#575）：root 最後一次寫的整份，**一輪開始時回到 `null`**，一輪結束時保留。規則與「一輪開始」
   * 為什麼不含 `resume` 見 `todos.ts`。它是「現在」的事，所以 {@link prependEntries} 不動它。
   */
  readonly todos: readonly WireTodoItem[] | null;
  /**
   * 計劃模式現在開著還是關著（#895）：最後一顆 `plan` frame 的整份值。**日誌上還沒有過 `plan/mode` 就是 `null`**，
   * 等同關著，不是「還沒收到」——理由與少了 dsh 的 `pending` 見 `plan-mode.ts`。只算 root。它是「現在」的事，所以
   * {@link prependEntries} 不動它。
   */
  readonly planMode: PlanModePayload | null;
  /**
   * 插件投影（#1026）：`key` → 最後一顆該 key 的 `projection` frame 的整份值。**所有插件共用這一格**，新增一個投影不改
   * 這個檔。沒有收到過的 key 就不在裡面；插件關掉（`disabled`）就不會有它的 key。往前翻頁不動它，規則見 `projection.ts`。
   */
  readonly projections: Readonly<Record<string, WireProjection>>;
  /**
   * 子代理自己的插件投影（#1028）：`runId` → `key` → 最後一顆的整份值，與 {@link projections} 同一種格子、同一套規則
   * （整份取代、不認得的 version 由渲染它的元件擋）。只有宣告 `children` 的單元會有；root 那一格不受影響。
   */
  readonly subagentProjections: Readonly<Record<string, Readonly<Record<string, WireProjection>>>>;
  /**
   * 會話目前的目標與階段（#897）：最後一顆 `goal` frame 的整份值。**沒有目標（從沒建立、或清掉了、或還沒收到）就是
   * `null`**，不分這幾種——理由與少了 dsh 的 activation 見 `goal.ts`。只算 root。它是「現在」的事，所以
   * {@link prependEntries} 不動它。
   */
  readonly goal: WireGoal | null;
  /**
   * 這條對話累計燒了多少 token（#574）：root 日誌每一次模型呼叫的帳加起來，**整份日誌的**，不是畫面上看得到的那幾輪。
   * 一顆都還沒收到就是 `null`；總量是兩格相加。規則見 `session-totals.ts`。它是「現在」的事，所以
   * {@link prependEntries} 不動它。
   */
  readonly tokenUsage: WireTokenUsage | null;
  /**
   * 這條對話的輪數、模型呼叫次數、模型與工具的耗時（#574），**整份 root 日誌的**。一顆都還沒收到就是 `null`。規則見
   * `session-totals.ts`。它是「現在」的事，所以 {@link prependEntries} 不動它。
   */
  readonly sessionStats: WireSessionStats | null;
  /**
   * 送出佇列（#637）：人送出、還沒開跑的那幾句，照開跑的先後。後到的 `inbox` frame 整份換掉，**沒收到過就是空的**
   * ——佇列從日誌開頭折起，不會在一輪開頭清空，所以沒有「還沒寫過」與「空」之分。規則見 `inbox.ts`。它是「現在」的事，
   * 所以 {@link prependEntries} 不動它。
   */
  readonly inbox: readonly WireQueuedInput[];
  /**
   * 插話（#710）：跑著的那一輪下一步就要送進模型、還沒被領走的那幾句，照送出的先後。規則同 {@link inbox}，由同一顆
   * `inbox` frame 的 `nextStep` 整份換掉；沒帶就是空的。
   */
  readonly inboxNextStep: readonly WireQueuedInput[];
  /**
   * 這條會話現在叫什麼（#647）：最後一顆 `title` frame 的。**還沒收到過就是 `null`**，同 dsh 投影的初值。規則見
   * `title.ts`。它是「現在」的事，所以 {@link prependEntries} 不動它。
   */
  readonly title: string | null;
  /**
   * 背景子代理現在的狀態（#867）：runId → `running`／`idle`，最後一顆 `subagent/status` frame 的整份。**還沒收到過就是
   * `null`**（不知道：歷史先到、快照還沒到的那一小段，或這份組裝根本沒有背景派出）；**收過而不在裡面＝收線**。規則見
   * `subagent-status.ts`。它是「現在」的事，所以 {@link prependEntries} 不動它。
   */
  readonly subagentStatus: Readonly<Record<string, SubagentRunStatus>> | null;
}

const ROOT: Attribution = { kind: 'root' };

export function emptyConversation(): ConversationState {
  return {
    entries: [],
    status: 'idle',
    pendings: [],
    lastSeq: -1,
    subagents: {},
    turnStart: 0,
    contextPressure: null,
    todos: null,
    planMode: null,
    projections: {},
    subagentProjections: {},
    goal: null,
    tokenUsage: null,
    sessionStats: null,
    inbox: [],
    inboxNextStep: [],
    title: null,
    subagentStatus: null,
  };
}

/** 一輪在跑或停下來等人：還沒收尾。 */
function isTurnActive(status: ConversationStatus): boolean {
  return status === 'running' || status === 'awaiting-input';
}

function isTailCandidate(entry: ConversationEntry): boolean {
  return (
    entry.kind === 'ai' &&
    entry.attribution.kind === 'root' &&
    entry.text.trim() !== '' &&
    !entry.streaming
  );
}

/**
 * 狀態每走一步，照輪的起訖標收尾那則（{@link AiEntry.turnTail}）。**要一步一步走**：一批 frame 裡
 * 「跑起來又收掉」只看頭尾的話，中間那次 `running` 會被吃掉——所以它住在折疊器裡，每一個改狀態的出口都過它，
 * 歷史一次折完（{@link reduceAll}）也是逐顆過。
 *
 * - **一輪從沒在跑走到 `running` 算起**：人送一句話、續行驅動器排了一輪，都是。從 `awaiting-input` 回到
 *   `running` 是續接，同一輪。
 * - **收尾是 `idle`、`stopped`、`failed`**。停在核准點不是收尾；停在核准點時按停止是。
 * - 子代理那幾則、串流中的、整輪只有工具的，都不標。
 */
function trackTurn(previous: ConversationState, next: ConversationState): ConversationState {
  if (next === previous) return next;
  const wasActive = isTurnActive(previous.status);
  if (!wasActive && next.status === 'running') {
    return { ...next, turnStart: previous.entries.length };
  }
  if (!wasActive || isTurnActive(next.status)) return next;
  for (let at = next.entries.length - 1; at >= next.turnStart; at -= 1) {
    const entry = next.entries[at];
    if (entry === undefined || !isTailCandidate(entry)) continue;
    const entries = [...next.entries];
    entries[at] = { ...entry, turnTail: true } as AiEntry;
    return { ...next, entries, turnStart: next.entries.length };
  }
  return { ...next, turnStart: next.entries.length };
}

/**
 * 把人剛按下去的那個決定放進來，並把核准請求收掉。
 *
 * **線上不回聲決定**，所以由這裡在按下去的那一刻補。被拒的那顆呼叫下行上有一張失敗的卡，
 * 但「是人按了拒絕」只有這一則說得出來，見 {@link DecisionEntry}。
 *
 * 認不得那顆 `interruptId` 時原樣回傳：重複按下去的第二次不該憑空長出一則紀錄。
 * **問答那一顆也不收**——那條路的紀錄是 {@link appendAnswers}，形狀不同。
 *
 * **只收掉被答的那一顆。** 同一輪的其他中斷還掛著，所以 `status` 只有在一顆都不剩時
 * 才回到 `running`——少了這一句，答完第一張卡的當下整條對話會看起來像跑起來了，
 * 而第二張卡還在等人。
 */
export function appendDecision(
  state: ConversationState,
  interruptId: string,
  decision: string,
): ConversationState {
  const pending = state.pendings.find((candidate) => candidate.interruptId === interruptId);
  if (pending === undefined || pending.kind !== APPROVAL_PENDING_KIND) {
    return state;
  }
  const entry: DecisionEntry = {
    kind: 'decision',
    id: `decision-${pending.interruptId}`,
    decision,
    actions: pending.actions.map((action) => action.name),
  };
  const rest = state.pendings.filter((candidate) => candidate.interruptId !== interruptId);
  return {
    ...state,
    entries: [...state.entries, entry],
    pendings: rest,
    status: rest.length > 0 ? 'awaiting-input' : 'running',
  };
}

/**
 * 把人剛填完的那組答案放進來，並把問答請求收掉。
 *
 * 與 {@link appendDecision} 對稱：認不得的 `interruptId` 原樣回傳，只收掉被答的那一顆，
 * 還有別的掛著時 `status` 留在 `awaiting-input`。
 *
 * **空的 `selected` 且沒有 `custom` ＝ 那一題被跳過**，不是「答了空字串」。這是照抄 dsh
 * 的編碼（`QuestionComposer.tsx`：`skipped` 送出的就是 `{ id, selected: [] }`），
 * 所以這一層不替它補預設值，原樣留著。
 */
export function appendAnswers(
  state: ConversationState,
  interruptId: string,
  answers: AnswerEntry['answers'],
): ConversationState {
  const pending = state.pendings.find((candidate) => candidate.interruptId === interruptId);
  if (pending === undefined || pending.kind !== QUESTION_PENDING_KIND) {
    return state;
  }
  const entry: AnswerEntry = { kind: 'answer', id: `answer-${pending.interruptId}`, answers };
  const rest = state.pendings.filter((candidate) => candidate.interruptId !== interruptId);
  return {
    ...state,
    entries: [...state.entries, entry],
    pendings: rest,
    status: rest.length > 0 ? 'awaiting-input' : 'running',
  };
}

/** 一組答案攤成 `ask_user_question` 要的那份回覆。 */
export function answerResponse(answers: AnswerEntry['answers']): unknown {
  return { answers: answers.map((a) => ({ ...a, selected: [...a.selected] })) };
}

/** 放棄整組問題時送回去的東西。工具據它拋錯，見 `@nexus/plugin-ask-user`。 */
export function cancelResponse(): unknown {
  return { cancelled: true };
}

/**
 * 拒絕整組問題時送回去的東西（[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)，只有 MCP 反問有這個動作）。
 * 與 {@link cancelResponse} 並列：沒有 `declined`／`cancelled` 的回覆就是接受（`{ answers }`），所以舊 client 與舊 server 照常運作。
 */
export function declineResponse(): unknown {
  return { declined: true };
}

/**
 * 人拒絕了整組問題。與 {@link appendQuestionCancel} 同一條路，只是留下的紀錄不同。
 */
export function appendQuestionDecline(
  state: ConversationState,
  interruptId: string,
): ConversationState {
  const pending = state.pendings.find((candidate) => candidate.interruptId === interruptId);
  if (pending === undefined || pending.kind !== QUESTION_PENDING_KIND) {
    return state;
  }
  const entry: AnswerEntry = {
    kind: 'answer',
    id: `answer-${pending.interruptId}`,
    answers: [],
    declined: true,
  };
  const rest = state.pendings.filter((candidate) => candidate.interruptId !== interruptId);
  return {
    ...state,
    entries: [...state.entries, entry],
    pendings: rest,
    status: rest.length > 0 ? 'awaiting-input' : 'running',
  };
}

/**
 * 人放棄了整組問題。與 {@link appendAnswers} 同一條路，只是留下的紀錄不同。
 */
export function appendQuestionCancel(
  state: ConversationState,
  interruptId: string,
): ConversationState {
  const pending = state.pendings.find((candidate) => candidate.interruptId === interruptId);
  if (pending === undefined || pending.kind !== QUESTION_PENDING_KIND) {
    return state;
  }
  const entry: AnswerEntry = {
    kind: 'answer',
    id: `answer-${pending.interruptId}`,
    answers: [],
    cancelled: true,
  };
  const rest = state.pendings.filter((candidate) => candidate.interruptId !== interruptId);
  return {
    ...state,
    entries: [...state.entries, entry],
    pendings: rest,
    status: rest.length > 0 ? 'awaiting-input' : 'running',
  };
}

/**
 * 一個決定攤成基座要的那份回覆。
 *
 * **`decisions` 是位置對應的，而且長度不符會殺掉整場 run**：基座逐 index 把決定配到
 * 被中斷的工具呼叫上，`decisions.length !== interruptToolCalls.length` 當場拋，線上
 * 就是一顆 `lifecycle failed / root`。全有全無的介面因此要送滿 `actions.length` 筆
 * 同型決定——這個攤平放在這裡，是為了讓「基座這一版的回覆長什麼樣」只有一個地方知道。
 */
export function uniformDecisions(pending: PendingApproval, decision: string): unknown {
  return { decisions: pending.actions.map(() => ({ type: decision })) };
}

export function reduceConversation(state: ConversationState, event: Event): ConversationState {
  return trackTurn(state, reduceFrame(state, event));
}

function reduceFrame(state: ConversationState, event: Event): ConversationState {
  const seq = event.seq;
  if (seq !== undefined && seq <= state.lastSeq) {
    // 重複或亂序——線上的 seq 是單調的，退回去的那些沒有新東西。
    return state;
  }
  const advanced = seq === undefined ? state : { ...state, lastSeq: seq };
  const namespace = event.params.namespace;
  const time = wireTime((event.params as { timestamp?: unknown }).timestamp);

  switch (event.method) {
    case 'messages':
      return reduceMessage(advanced, namespace, event.params.data, time);
    case 'tools':
      return reduceTool(advanced, namespace, event.params.data, time);
    case 'lifecycle':
      return reduceLifecycle(advanced, namespace, event.params.data, time);
    case 'input.requested':
      return reduceInputRequested(advanced, namespace, event.params.data);
    case 'custom':
      return reduceCustom(advanced, event.params.data, time);
    default:
      return advanced;
  }
}

/**
 * frame 的 `params.timestamp` 能不能當 entry 的時刻：正的有限數字才算，其餘當沒有（見 {@link ConversationEntry} 的「時刻」）。
 *
 * **0 也當沒有**：產品路徑上兩個生產者都給不出 0（即時是基座的時刻或 `Date.now()`，歷史是日誌寫入那一刻的
 * `Date.now()`），而現有的測試夾具一律拿 0 佔位；收下 0 的話，那些比整個 entry 的斷言會因為多一格而紅。
 */
function wireTime(timestamp: unknown): number | undefined {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0
    ? timestamp
    : undefined;
}

/** 有時刻才帶那一格：沒有時刻不留一個值是 `undefined` 的鍵。 */
function timeField<K extends 'startedAt' | 'settledAt'>(
  key: K,
  time: number | undefined,
): Partial<Record<K, number>> {
  return time === undefined ? {} : ({ [key]: time } as Record<K, number>);
}

/** `files` 裡的一格長得像不像一個交付的檔案。 */
function isPresentedFile(value: unknown): value is WirePresentedFile {
  if (typeof value !== 'object' || value === null) return false;
  const { path, description } = value as Record<string, unknown>;
  return typeof path === 'string' && (description === undefined || typeof description === 'string');
}

/**
 * `custom` frame：照 `data.name` 分派給那一格的折疊。**認得的名字就是 `custom-frame.ts` 那張名字→酬載表上的鍵**
 * （[#685](https://github.com/DemianLi/nexus-agent/issues/685)），這裡不另列一份。
 *
 * {@link CUSTOM_REDUCERS} 的型別對表上的鍵**窮舉**：表上多一格而這裡沒補分支，當場編不過。執行期遇到表上沒有的名字、
 * 或酬載不是物件，一律原樣回 state：這個 channel 上的東西由 pump 從日誌合成，認不得的不猜。各格的酬載形狀由各自的
 * `reduceX` 驗，不在這一層。
 */
function reduceCustom(
  state: ConversationState,
  data: unknown,
  time: number | undefined,
): ConversationState {
  const { name, payload } = (data ?? {}) as { name?: unknown; payload?: unknown };
  if (typeof payload !== 'object' || payload === null) return state;
  if (typeof name !== 'string' || !Object.hasOwn(CUSTOM_REDUCERS, name)) return state;
  return CUSTOM_REDUCERS[name as CustomFrameName](state, payload, time);
}

/** 一交付的那一格：`deliverables` 條目，同一個 `callId` 只長一次。 */
function reduceDeliverablesPresented(
  state: ConversationState,
  payload: object,
  time: number | undefined,
): ConversationState {
  const { callId, seq, files } = payload as { callId?: unknown; seq?: unknown; files?: unknown };
  if (
    typeof callId !== 'string' ||
    !isSeq(seq) ||
    !Array.isArray(files) ||
    !files.every(isPresentedFile)
  ) {
    return state;
  }
  const id = `deliverables:${callId}`;
  if (state.entries.some((entry) => entry.id === id)) return state;
  const entry: DeliverablesEntry = {
    kind: 'deliverables',
    id,
    callId,
    seq,
    files,
    ...timeField('startedAt', time),
  };
  return { ...state, entries: [...state.entries, entry] };
}

/**
 * 名字→那一格的折疊。**型別對 {@link CustomFrameName} 窮舉**（見 {@link reduceCustom}）。酬載收成 `object`：執行期的形狀
 * 驗證是各個 `reduceX` 的事，表上的型別只約束生產端。`time` 是那顆 frame 的時刻，只有長出 entry 的那幾格用得到。
 */
const CUSTOM_REDUCERS: {
  readonly [K in CustomFrameName]: (
    state: ConversationState,
    payload: object,
    time: number | undefined,
  ) => ConversationState;
} = {
  [DELIVERABLES_PRESENTED]: reduceDeliverablesPresented,
  [WORKSPACE_CHANGES]: reduceWorkspaceChanges,
  [MODEL_USAGE]: reduceModelUsage,
  [CONTEXT_MEASURE]: reduceContextMeasure,
  [TODOS]: reduceTodos,
  [PLAN_MODE]: reducePlanMode,
  [PROJECTION]: reduceProjection,
  [COMPACTION]: reduceCompaction,
  [GOAL]: reduceGoal,
  [TOKEN_USAGE]: reduceTokenUsage,
  [SESSION_STATS]: reduceSessionStats,
  [INBOX]: reduceInbox,
  [SETTLE_NOTICE]: reduceSettleNotice,
  [AGENT_MESSAGE]: reduceAgentMessage,
  [TITLE]: reduceTitle,
  [SUBAGENT_STATUS]: reduceSubagentStatus,
  [SUBAGENT_CATALOG]: reduceSubagentCatalog,
  [MESSAGE_DISCARD]: reduceMessageDiscard,
};

/**
 * 子代理目錄（#1023）：掛到 `callId` 那張工具卡上。卡不在（不該發生：目錄永遠在配對的呼叫之後、同一輪之內）就原樣回，
 * 不另開一張。任何一格不對就整顆不收。
 */
function reduceSubagentCatalog(state: ConversationState, payload: object): ConversationState {
  const { childId, callId, mode } = payload as {
    childId?: unknown;
    callId?: unknown;
    mode?: unknown;
  };
  if (
    typeof childId !== 'string' ||
    childId === '' ||
    typeof callId !== 'string' ||
    (mode !== 'one-shot' && mode !== 'continuable')
  ) {
    return state;
  }
  const id = `tool-${callId}`;
  if (!state.entries.some((entry) => entry.id === id && entry.kind === 'tool')) return state;
  const session: NonNullable<ToolEntry['subagentSession']> = {
    id: childId,
    mode: mode satisfies SubagentCatalogPayload['mode'],
  };
  return {
    ...state,
    entries: replace(state.entries, id, (entry) =>
      entry.kind === 'tool' ? { ...entry, subagentSession: session } : entry,
    ),
  };
}

/**
 * 日誌位置的形狀：非負安全整數。
 *
 * **兩種 `custom` frame 共用這一個**（#452）。各寫一份的話，其中一邊放寬了不會有任何東西紅——
 * 而兩邊的 `seq` 是同一份日誌上的同一種座標。
 */
function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 一個數量：非負安全整數。同 `@nexus/core` 的 `readModelUsage` 驗 `model/usage` 的那條。 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** `model/usage` 的 `payload`：只換 `inputTokens` 那一格，`measure` 照舊。 */
function reduceModelUsage(state: ConversationState, payload: object): ConversationState {
  const { inputTokens } = payload as { inputTokens?: unknown };
  if (!isCount(inputTokens)) return state;
  return { ...state, contextPressure: { ...state.contextPressure, inputTokens } };
}

/**
 * `context/measure` 的 `payload`：只換 `measure` 那一格。**任何一格不對就整顆不收**，不收一半——門檻少一道的
 * 話，環會量錯那一道，而且看起來正常。
 */
function reduceContextMeasure(state: ConversationState, payload: object): ConversationState {
  const { approxTokens, messageCount, thresholds } = payload as {
    approxTokens?: unknown;
    messageCount?: unknown;
    thresholds?: unknown;
  };
  // 空陣列也不收：`measure` 在就保證至少一道門檻，web 不必處理「有量測、沒分母」。摘要的設定本來就不准空陣列。
  if (!isCount(approxTokens) || !isCount(messageCount) || !Array.isArray(thresholds)) return state;
  if (thresholds.length === 0) return state;
  const parsed: WireContextMeasure['thresholds'][number][] = [];
  for (const threshold of thresholds as unknown[]) {
    const { type, value } = (threshold ?? {}) as { type?: unknown; value?: unknown };
    if (type !== 'messages' && type !== 'tokens') return state;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return state;
    parsed.push({ type, value });
  }
  const measure: WireContextMeasure = { approxTokens, messageCount, thresholds: parsed };
  return { ...state, contextPressure: { ...state.contextPressure, measure } };
}

/**
 * `subagent/status` 的 `payload`：整份換掉。`items` 不是陣列就整顆不收；陣列裡形狀不對的單項略過（同編號以後到的為準）。
 */
function reduceSubagentStatus(state: ConversationState, payload: object): ConversationState {
  const { items } = payload as { items?: unknown };
  if (!Array.isArray(items)) return state;
  const subagentStatus: Record<string, SubagentRunStatus> = {};
  for (const item of items) {
    const { runId, status } = (item ?? {}) as { runId?: unknown; status?: unknown };
    if (typeof runId !== 'string' || runId === '') continue;
    if (status !== 'running' && status !== 'idle') continue;
    subagentStatus[runId] = status;
  }
  return { ...state, subagentStatus };
}

/**
 * `title` 的 `payload`：換成這一個。不是非空字串就不收，同 dsh 投影的 `z.string().min(1)`。
 */
function reduceTitle(state: ConversationState, payload: object): ConversationState {
  const { title } = payload as { title?: unknown };
  if (typeof title !== 'string' || title === '') return state;
  return { ...state, title };
}

/**
 * `compaction` 的 `payload`：`seq` 與 `cutoff` 要是非負整數、`saved` 要是布林，同一個 `seq` 只長一格。
 * `summary` 不是字串就當沒有，不拿它擋整顆。
 */
function reduceCompaction(
  state: ConversationState,
  payload: object,
  time: number | undefined,
): ConversationState {
  const { seq, cutoff, saved, summary } = payload as {
    seq?: unknown;
    cutoff?: unknown;
    saved?: unknown;
    summary?: unknown;
  };
  if (!isSeq(seq) || !isSeq(cutoff) || typeof saved !== 'boolean') return state;
  const id = `compaction:${seq}`;
  if (state.entries.some((entry) => entry.id === id)) return state;
  const entry: CompactionEntry = {
    kind: 'compaction',
    id,
    seq,
    cutoff,
    saved,
    ...(typeof summary === 'string' ? { summary } : {}),
    ...timeField('startedAt', time),
  };
  return { ...state, entries: [...state.entries, entry] };
}

const PHASES: ReadonlySet<unknown> = new Set(GOAL_PHASES);

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** 一個目標長得對不對：每一格都驗，`blockedReason` 剛好在 `blocked` 時有。回傳乾淨的一份，多出來的欄位不收。 */
function toWireGoal(value: unknown): WireGoal | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const { id, revision, objective, phase, blockedReason, maxGoalRounds } = v;
  const { roundsStarted, createdAt, updatedAt } = v;
  if (typeof id !== 'string' || id === '' || typeof objective !== 'string') return undefined;
  if (!isPositiveSafeInteger(revision) || !isPositiveSafeInteger(maxGoalRounds)) return undefined;
  if (!PHASES.has(phase)) return undefined;
  if (!isSeq(roundsStarted) || !isSeq(createdAt) || !isSeq(updatedAt)) return undefined;
  let reason: { code: string; message: string } | undefined;
  if (phase === 'blocked') {
    const r = blockedReason as { code?: unknown; message?: unknown } | null | undefined;
    if (typeof r?.code !== 'string' || typeof r.message !== 'string') return undefined;
    reason = { code: r.code, message: r.message };
  } else if (blockedReason !== undefined) {
    return undefined;
  }
  return {
    id,
    revision,
    objective,
    phase: phase as WireGoalPhase,
    ...(reason === undefined ? {} : { blockedReason: reason }),
    maxGoalRounds,
    roundsStarted,
    createdAt,
    updatedAt,
  };
}

/**
 * `message-discard` 的 `payload`（#520）：把 `messageId` 對應的 AI 回覆整格拿掉。先比 `messageId`、再比串流的 `id`；
 * 找不到、重複送、或 `messageId` 不是非空字串，都是 no-op。只拿 AI 回覆，不碰同 id 的別種 entry。
 */
function reduceMessageDiscard(state: ConversationState, payload: object): ConversationState {
  const { messageId } = payload as { messageId?: unknown };
  if (typeof messageId !== 'string' || messageId === '') return state;
  const entries = state.entries.filter(
    (entry) => !(entry.kind === 'ai' && (entry.messageId === messageId || entry.id === messageId)),
  );
  return entries.length === state.entries.length ? state : { ...state, entries };
}

/** `goal` 的 `payload`：投影的整個值，整份換掉。`null` 是沒有目標；任何一格不對就整顆不收，留著前一份。 */
function reduceGoal(state: ConversationState, payload: object): ConversationState {
  const { goal } = payload as { goal?: unknown };
  if (goal === null) return { ...state, goal: null };
  const next = toWireGoal(goal);
  return next === undefined ? state : { ...state, goal: next };
}

/** `plan` 的 `payload`：投影的整個值，整份換掉。`active` 不是布林就整顆不收。 */
function reducePlanMode(state: ConversationState, payload: object): ConversationState {
  const { active } = payload as { active?: unknown };
  if (typeof active !== 'boolean') return state;
  return { ...state, planMode: { active } };
}

/**
 * `projection` 的 `payload`：一個插件投影的整份值，整份換掉（#1026）。`key` 不合格、`version` 不是非負整數、
 * `failed` 存在卻不是 `true`、或 `failed` 時 `view` 不是 `null`，整顆不收。`view` 是什麼由渲染它的元件驗，這一層不看。
 */
function reduceProjection(state: ConversationState, payload: object): ConversationState {
  const { key, version, view, failed, session } = payload as {
    key?: unknown;
    version?: unknown;
    view?: unknown;
    failed?: unknown;
    session?: unknown;
  };
  if (typeof key !== 'string' || !PROJECTION_KEY_PATTERN.test(key)) return state;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return state;
  if (failed !== undefined && (failed !== true || view !== null)) return state;
  // 酬載裡沒有 `view` 這個鍵（`undefined`）不是合法的 JSON 值，整顆不收。
  if (view === undefined) return state;
  const next: WireProjection =
    failed === true ? { version, view: null, failed: true } : { version, view };
  if (session === undefined) {
    return { ...state, projections: { ...state.projections, [key]: next } };
  }
  // 子代理自己的值（#1028）：`session` 要是非空字串，不然整顆不收（不退回寫進 root 那一格）。
  if (typeof session !== 'string' || session === '') return state;
  return {
    ...state,
    subagentProjections: {
      ...state.subagentProjections,
      [session]: { ...state.subagentProjections[session], [key]: next },
    },
  };
}

/** 清單裡的一項長得對不對：同 dsh 的 `todosProjectionSchema`。 */
function isTodoItem(value: unknown): value is WireTodoItem {
  if (typeof value !== 'object' || value === null) return false;
  const { content, status } = value as { content?: unknown; status?: unknown };
  return (
    typeof content === 'string' &&
    (status === 'pending' || status === 'in_progress' || status === 'completed')
  );
}

/**
 * `todos` 的 `payload`：投影的整個值，**整份換掉**。`null` 是「一輪剛開始、還沒寫過」。任何一項不對就整顆不收，
 * 不收一半——少一項的清單會把進度算錯，而且看起來正常。
 */
function reduceTodos(state: ConversationState, payload: object): ConversationState {
  const { todos } = payload as { todos?: unknown };
  if (todos === null) return { ...state, todos: null };
  if (!Array.isArray(todos) || !todos.every(isTodoItem)) return state;
  return { ...state, todos: todos.map(({ content, status }) => ({ content, status })) };
}

/**
 * `tokenUsage` 的 `payload`：投影的整個值，**整顆換掉**。任何一格不對就整顆不收，不收一半——只換輸入不換輸出的話，
 * 總量會是兩個不同時刻的數字加起來，而且看起來正常。
 */
function reduceTokenUsage(state: ConversationState, payload: object): ConversationState {
  const { inputTokens, outputTokens, uncachedInputTokens, cacheReadTokens, cacheWriteTokens } =
    payload as {
      inputTokens?: unknown;
      outputTokens?: unknown;
      uncachedInputTokens?: unknown;
      cacheReadTokens?: unknown;
      cacheWriteTokens?: unknown;
    };
  if (!isCount(inputTokens) || !isCount(outputTokens)) return state;
  // 快取分桶那三格（#724）選填，**缺席是「沒記」**；有就得是數量，有一格不對整顆不收（同上，不收一半）。
  for (const optional of [uncachedInputTokens, cacheReadTokens, cacheWriteTokens]) {
    if (optional !== undefined && !isCount(optional)) return state;
  }
  return {
    ...state,
    tokenUsage: {
      inputTokens,
      outputTokens,
      ...(isCount(uncachedInputTokens) ? { uncachedInputTokens } : {}),
      ...(isCount(cacheReadTokens) ? { cacheReadTokens } : {}),
      ...(isCount(cacheWriteTokens) ? { cacheWriteTokens } : {}),
    },
  };
}

/** `sessionStats` 的 `payload`：投影的整個值，**整顆換掉**。任何一格不對就整顆不收，理由同 {@link reduceTokenUsage}。 */
function reduceSessionStats(state: ConversationState, payload: object): ConversationState {
  const { turns, steps, llmMs, toolMs } = payload as Record<string, unknown>;
  if (!isCount(turns) || !isCount(steps) || !isCount(llmMs) || !isCount(toolMs)) return state;
  return { ...state, sessionStats: { turns, steps, llmMs, toolMs } };
}

/** 排著的一件長得對不對：`@nexus/core` 的 `QueuedInput`，`source` 是人或背景子代理的結算通知；帶了 `attachments` 就要形狀合格。 */
function isQueuedInput(value: unknown): value is WireQueuedInput {
  if (typeof value !== 'object' || value === null) return false;
  const { id, text, source, attachments } = value as {
    id?: unknown;
    text?: unknown;
    source?: unknown;
    attachments?: unknown;
  };
  return (
    typeof id === 'string' &&
    typeof text === 'string' &&
    isWireAttachments(attachments) &&
    typeof source === 'object' &&
    source !== null &&
    isQueuedSourceKind((source as { kind?: unknown }).kind)
  );
}

function isQueuedSourceKind(kind: unknown): kind is WireQueuedInputSource['kind'] {
  return kind === 'user' || kind === 'subagent-settled' || kind === 'agent-message';
}

/** 一句話 `@` 的會話長得對不對。沒給（`undefined`）合法，給了就每一條都要是兩個字串。 */
function isWireReferences(value: unknown): value is readonly WireSessionReference[] | undefined {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.every((reference: unknown) => {
      const { sessionId, label } = (reference ?? {}) as { sessionId?: unknown; label?: unknown };
      return typeof sessionId === 'string' && typeof label === 'string';
    })
  );
}

/** 有引用才帶這一格：空陣列與沒給是同一件事，不讓兩種長相並存。 */
function referencesField(
  references: readonly WireSessionReference[] | undefined,
): { readonly references: readonly WireSessionReference[] } | Record<string, never> {
  return references === undefined || references.length === 0
    ? {}
    : {
        references: references.map(({ sessionId, label }) => ({ sessionId, label })),
      };
}

/** 一份附件參照長得對不對（`@nexus/core` 的 `AttachmentRef` 另寫一份，同 `WireAttachmentRef`）。 */
function isWireAttachmentRef(value: unknown): value is WireAttachmentRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (typeof ref['attachmentId'] !== 'string' || ref['attachmentId'] === '') return false;
  if (!count(ref['bytes'])) return false;
  if (ref['type'] === 'file') return typeof ref['name'] === 'string' && ref['name'] !== '';
  if (ref['type'] === 'image') {
    return (
      typeof ref['mediaType'] === 'string' &&
      (IMAGE_MEDIA_TYPES as readonly string[]).includes(ref['mediaType']) &&
      count(ref['width']) &&
      count(ref['height']) &&
      (ref['name'] === undefined || typeof ref['name'] === 'string')
    );
  }
  return false;
}

/** 一句話帶的附件長得對不對。沒給（`undefined`）合法，給了就每一份都要合格。 */
function isWireAttachments(value: unknown): value is readonly WireAttachmentRef[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isWireAttachmentRef));
}

/** 有附件才帶這一格：空陣列與沒給是同一件事。只留認得的欄位，不把多出來的東西原樣轉手。 */
function attachmentsField(
  attachments: readonly WireAttachmentRef[] | undefined,
): { readonly attachments: readonly WireAttachmentRef[] } | Record<string, never> {
  if (attachments === undefined || attachments.length === 0) return {};
  return {
    attachments: attachments.map((ref): WireAttachmentRef => {
      const { attachmentId, bytes } = ref;
      return ref.type === 'file'
        ? { type: 'file', attachmentId, name: ref.name, bytes }
        : {
            type: 'image',
            attachmentId,
            mediaType: ref.mediaType,
            bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
          };
    }),
  };
}

/**
 * `inbox` 的 `payload`：兩條清單**整份換掉**。任何一件不對、`claimed`／`claimedNextStep` 不對，就整顆不收，不收一半——
 * 少一件的清單分不出是開跑了還是被刪了，而且看起來正常。
 *
 * 帶 `claimed` 的那一顆是某一件剛被領走開跑：多折一則人的話，文字用開跑用的那份（改過的就是改過的）。帶
 * `claimedNextStep` 的那一顆是整條插話剛被領走、送進模型（#710）：照先後各折一則人的話，規則相同。
 *
 * - **一律接在最後**：畫面不在送出當下先畫（#645），所以這一則就是人話在即時畫面上唯一的來處，沒有別的可以認領。
 *   插話也一樣：它被領走時，這一輪前面的回覆與工具卡都已經在畫面上了，它接在它們後面，同它在對話裡的位置。
 * - **id 是 `inbox:<項目 id>`**，跟歷史重播的人話（`message-start` 的 `run_id`）分得開；帶
 *   {@link HumanEntry.inboxId}，同一顆再到一次靠它認出來，不畫第二次。
 * - **`status` 不在這裡轉**：開跑由接著到的 `lifecycle` 說，理由同 `claimed` 的先後保證（見 `inbox.ts`）。插話被領走時
 *   這一輪本來就在跑。
 */
function reduceInbox(
  state: ConversationState,
  payload: object,
  time: number | undefined,
): ConversationState {
  const { items, nextStep, claimed, claimedNextStep } = payload as {
    items?: unknown;
    nextStep?: unknown;
    claimed?: unknown;
    claimedNextStep?: unknown;
  };
  if (!Array.isArray(items) || !items.every(isQueuedInput)) return state;
  if (nextStep !== undefined && (!Array.isArray(nextStep) || !nextStep.every(isQueuedInput))) {
    return state;
  }
  const claims: unknown[] = [];
  if (claimed !== undefined) claims.push(claimed);
  if (claimedNextStep !== undefined) {
    if (!Array.isArray(claimedNextStep)) return state;
    claims.push(...claimedNextStep);
  }
  const humans: (HumanEntry | NoticeEntry | AgentMessageEntry)[] = [];
  for (const claim of claims) {
    const { id, text, references, attachments, source } = (claim ?? {}) as {
      id?: unknown;
      text?: unknown;
      references?: unknown;
      attachments?: unknown;
      source?: unknown;
    };
    if (
      typeof id !== 'string' ||
      typeof text !== 'string' ||
      !isWireReferences(references) ||
      !isWireAttachments(attachments)
    ) {
      return state;
    }
    // 不是人送的（#840、#849）：執行期的記帳，不畫人的泡泡。認得的來源之外的一律當成人畫——舊的一側沒有這一格。
    // 結算通知（#851）長一格「通知」，子代理寄來的話（#863）長一格「某某說」，位置都是人話會出現的地方。
    const sourceKind = (source as { kind?: unknown } | undefined)?.kind;
    if (sourceKind === 'subagent-settled') {
      const reason = (source as { reason?: unknown }).reason;
      humans.push({
        kind: 'notice',
        id: `inbox:${id}`,
        source: 'subagent-settled',
        ...(isSettleReason(reason) ? { reason } : {}),
        inboxId: id,
        ...timeField('startedAt', time),
      });
      continue;
    }
    // 目標續行的預約開跑（#638）：給模型的提示詞，畫面不長任何一格。
    if (sourceKind === 'goal') continue;
    if (sourceKind === 'agent-message') {
      const { senderSessionId, runId } = source as { senderSessionId?: unknown; runId?: unknown };
      // 寄件人缺了就整顆不收：沒有寄件人的「某某說」畫不出來，又不能悄悄當成人話。
      if (typeof senderSessionId !== 'string' || typeof runId !== 'string') return state;
      humans.push({
        kind: 'agent-message',
        id: `inbox:${id}`,
        senderSessionId,
        runId,
        text,
        inboxId: id,
        ...timeField('startedAt', time),
      });
      continue;
    }
    humans.push({
      kind: 'human',
      id: `inbox:${id}`,
      text,
      inboxId: id,
      ...referencesField(references),
      ...attachmentsField(attachments),
      ...timeField('startedAt', time),
    });
  }
  const queued = (list: readonly WireQueuedInput[]) =>
    list.map(({ id, text, source, attachments }) => ({
      id,
      text,
      source:
        source.kind === 'subagent-settled' && isSettleReason(source.reason)
          ? { kind: source.kind, reason: source.reason }
          : { kind: source.kind },
      // 排著的件帶的附件（#732）：空陣列與沒給一樣不帶這一格。
      ...attachmentsField(attachments),
    }));
  const inbox = queued(items);
  const inboxNextStep = queued(nextStep ?? []);
  const fresh = humans.filter(
    (fresh) =>
      !state.entries.some(
        (entry) =>
          (entry.kind === 'human' || entry.kind === 'notice' || entry.kind === 'agent-message') &&
          entry.inboxId === fresh.inboxId,
      ),
  );
  if (fresh.length === 0) return { ...state, inbox, inboxNextStep };
  return { ...state, inbox, inboxNextStep, entries: [...state.entries, ...fresh] };
}

/** {@link SETTLE_NOTICE} 的 `payload`：`id` 是字串，同一個 `id` 只長一格。 */
function reduceSettleNotice(
  state: ConversationState,
  payload: object,
  time: number | undefined,
): ConversationState {
  const { id, reason } = payload as { id?: unknown; reason?: unknown };
  if (typeof id !== 'string' || id === '') return state;
  if (state.entries.some((entry) => entry.id === id)) return state;
  const entry: NoticeEntry = {
    kind: 'notice',
    id,
    source: 'subagent-settled',
    ...(isSettleReason(reason) ? { reason } : {}),
    ...timeField('startedAt', time),
  };
  return { ...state, entries: [...state.entries, entry] };
}

/** {@link AGENT_MESSAGE} 的 `payload`：三個字串欄位都要在，`id` 非空，同一個 `id` 只長一格。 */
function reduceAgentMessage(
  state: ConversationState,
  payload: object,
  time: number | undefined,
): ConversationState {
  const { id, senderSessionId, runId, text } = payload as {
    id?: unknown;
    senderSessionId?: unknown;
    runId?: unknown;
    text?: unknown;
  };
  if (typeof id !== 'string' || id === '') return state;
  if (
    typeof senderSessionId !== 'string' ||
    typeof runId !== 'string' ||
    typeof text !== 'string'
  ) {
    return state;
  }
  if (state.entries.some((entry) => entry.id === id)) return state;
  const entry: AgentMessageEntry = {
    kind: 'agent-message',
    id,
    senderSessionId,
    runId,
    text,
    ...timeField('startedAt', time),
  };
  return { ...state, entries: [...state.entries, entry] };
}

/** `workspace/changes` 的 `payload`：`seq` 要是非負整數，同一個 `seq` 只長一格。 */
function reduceWorkspaceChanges(
  state: ConversationState,
  payload: object,
  time: number | undefined,
): ConversationState {
  const { seq } = payload as { seq?: unknown };
  if (!isSeq(seq)) return state;
  const id = `workspace-changes:${seq}`;
  if (state.entries.some((entry) => entry.id === id)) return state;
  const entry: WorkspaceChangesEntry = {
    kind: 'workspace-changes',
    id,
    seq,
    ...timeField('startedAt', time),
  };
  return { ...state, entries: [...state.entries, entry] };
}

/** 一次折一整串。 */
export function reduceAll(state: ConversationState, events: Iterable<Event>): ConversationState {
  let next = state;
  for (const event of events) {
    next = reduceConversation(next, event);
  }
  return next;
}

/**
 * 把更早的一頁歷史接在最前面（往前翻，#306）。
 *
 * **只接條目**：狀態、掛著的中斷、`lastSeq` 都是「現在」的事，更早那一頁說不動它們。那一頁要自己從
 * {@link emptyConversation} 折好再交進來——折進現在這一份的話，它的 `lifecycle` 會把現在的狀態蓋掉。
 * 頁是在一輪的開頭切的（server 那側），所以同一顆工具呼叫不會一半在這頁、一半在下一頁。條目原樣接上，時刻
 * （{@link ConversationEntry} 的「時刻」）跟著留著。
 */
export function prependEntries(
  state: ConversationState,
  earlier: ConversationState,
): ConversationState {
  // 目前這一輪的起點跟著往後挪；不挪的話收尾時會往回找進接上來的那一頁（#382 順帶修的）。
  return {
    ...state,
    entries: [...earlier.entries, ...state.entries],
    turnStart: state.turnStart + earlier.entries.length,
  };
}

function attribute(state: ConversationState, namespace: readonly string[]): Attribution {
  if (namespace.length <= 1) {
    return ROOT;
  }
  const key = namespace[0];
  const found = key === undefined ? undefined : state.subagents[key];
  return found === undefined ? { kind: 'unattributed', namespace } : { kind: 'subagent', ...found };
}

function replace(
  entries: readonly ConversationEntry[],
  id: string,
  update: (entry: ConversationEntry) => ConversationEntry,
): readonly ConversationEntry[] {
  return entries.map((entry) => (entry.id === id ? update(entry) : entry));
}

interface MessageData {
  readonly event: string;
  /** `message-start` 的作者。**`human` 只有歷史送**：即時的人話走 `inbox` 的 `claimed`，見 {@link reduceInbox}。 */
  readonly role?: string;
  readonly id?: string;
  readonly run_id?: string;
  /** `text-delta` 帶 `text`，`reasoning-delta` 帶 `reasoning`（`@langchain/core` 的 `ContentBlockDelta`）。 */
  readonly delta?: { readonly type?: string; readonly text?: string; readonly reasoning?: string };
  readonly message?: string;
  /** 歷史重播的人話帶的 `@` 引用（#713），即時那條走 `inbox` 的 `claimed`。 */
  readonly references?: unknown;
  /** 歷史重播的人話帶的附件參照（#732），即時那條走 `inbox` 的 `claimed`。 */
  readonly attachments?: unknown;
}

function reduceMessage(
  state: ConversationState,
  namespace: readonly string[],
  raw: unknown,
  time: number | undefined,
): ConversationState {
  const data = raw as MessageData;
  // 一則訊息的 id 就是它的 entry key，所以交錯的 subagent 訊息天然分得開。
  //
  // **key 取 `run_id` 而不是 `id`**：`message-start` 兩個都有（`id` 是
  // `run-<uuid>`、`run_id` 是 `<uuid>`，差一個前綴），而 `content-block-delta` 與
  // `message-finish` **只有 `run_id`**。取錯的話 entry 建得出來、文字卻永遠是空的
  // ——而且不會有任何錯誤。
  const id = data.run_id ?? data.id;
  if (id === undefined) {
    return state;
  }

  switch (data.event) {
    case 'message-start': {
      if (data.role === 'human') {
        // **歷史才會送這一種**（`GET /threads/:id/history`，#306）：協定留給「整則重播的人話」的格。
        // `status` 不動——這一句已經說過了，不是剛開跑的那一句（那一句走 `inbox` 的 `claimed`）。
        // 引用長得不對就當沒有：這一則人話還是要畫，只是少了引用的標記。
        const references = isWireReferences(data.references) ? data.references : undefined;
        const attachments = isWireAttachments(data.attachments) ? data.attachments : undefined;
        const entry: HumanEntry = {
          kind: 'human',
          id,
          text: '',
          ...referencesField(references),
          ...attachmentsField(attachments),
          ...timeField('startedAt', time),
        };
        return { ...state, entries: [...state.entries, entry] };
      }
      // **同一則回覆已經在畫面上就不再長一格**（[#953](https://github.com/DemianLi/nexus-agent/issues/953) 第二刀）：
      // 重新整理時下行補送進行中的那則（它的 `id` 就是日誌記的訊息 id），歷史是另一個請求、晚一步才拿——
      // 兩者之間回覆落盤了的話，歷史已經有它，補送再長一格就是畫面上同一則出現兩次。之後這一則的
      // `content-block-delta` 與 `message-finish` 對不到 entry，`replace` 找不到就是不動。
      if (typeof data.id === 'string' && data.id !== '') {
        const messageId = data.id;
        if (state.entries.some((entry) => entry.kind === 'ai' && entry.messageId === messageId)) {
          return state;
        }
      }
      const entry: AiEntry = {
        kind: 'ai',
        id,
        text: '',
        streaming: true,
        attribution: attribute(state, namespace),
        ...(typeof data.id === 'string' && data.id !== '' && { messageId: data.id }),
        ...timeField('startedAt', time),
      };
      return { ...state, entries: [...state.entries, entry] };
    }
    case 'content-block-delta': {
      if (data.delta?.type === 'reasoning-delta') {
        // **正面比對**：推理簽章走的是 `block-delta`（`fields.type: 'reasoning'`），寫成「不是 text 就收」
        // 會把它一起收進來。工具參數同樣走 `block-delta`，而工具有自己的 `tools` channel。
        const reasoning = data.delta.reasoning ?? '';
        return {
          ...state,
          entries: replace(state.entries, id, (entry) =>
            entry.kind === 'ai'
              ? { ...entry, reasoning: (entry.reasoning ?? '') + reasoning }
              : entry,
          ),
        };
      }
      if (data.delta?.type !== 'text-delta') {
        // 其餘的 delta（工具參數、推理簽章）不呈現；工具走 `tools` channel。
        return state;
      }
      const text = data.delta.text ?? '';
      return {
        ...state,
        entries: replace(state.entries, id, (entry) =>
          entry.kind === 'ai' || entry.kind === 'human'
            ? { ...entry, text: entry.text + text }
            : entry,
        ),
      };
    }
    case 'message-finish':
      return {
        ...state,
        entries: replace(state.entries, id, (entry) =>
          entry.kind === 'ai'
            ? { ...entry, streaming: false, ...timeField('settledAt', time) }
            : entry,
        ),
      };
    case 'error':
      return {
        ...state,
        entries: replace(state.entries, id, (entry) =>
          entry.kind === 'ai'
            ? {
                ...entry,
                streaming: false,
                error: data.message ?? '未指名的錯誤',
                ...timeField('settledAt', time),
              }
            : entry,
        ),
      };
    default:
      return state;
  }
}

interface ToolData {
  readonly event: string;
  readonly tool_call_id: string;
  readonly tool_name?: string;
  readonly input?: string;
  /**
   * 這次呼叫的結果文字（#439）。`tool-finished` 成功與失敗都帶，`tool-error` 是錯誤那一句。
   * 由 pump 從日誌抽，見 harness 的 `tool-result-text.ts`。
   */
  readonly message?: string;
  /** `tool-finished` 專用：那則 ToolMessage 自己說它失敗了。由 pump 分類，見它的檔頭。 */
  readonly failed?: boolean;
  /** `tool-finished` 專用：給專屬卡的結構化結果（#617），見 {@link ToolEntry.meta}。 */
  readonly meta?: unknown;
  /**
   * 失敗的錯誤碼（#667），見 {@link ToolEntry.errorCode}。`tool-finished` 由 pump 在失敗那一支放，
   * `tool-error` 是協定 `ToolErrorData` 本來就有的 `code`。
   */
  readonly code?: string;
}

/**
 * 派子代理的工具名：基座的 `task`，與背景選項開啟時模型看到的 `subagent`
 * （[#831](https://github.com/DemianLi/nexus-agent/issues/831)）。
 *
 * 前景的 `subagent` 內部仍派給 `task`，所以歸屬的鑰匙（`task` 的 `tool-started`）不變；這個集合給認名字的地方
 * 用——harness 的收回、web 的卡片——免得各自寫死一個。
 */
export const DELEGATION_TOOL_NAMES: readonly string[] = ['task', 'subagent'];

/**
 * 背景子代理的歸屬鑰匙，放在 `subagent` 那顆 `tool-finished` 的 `meta` 裡
 * （[#832](https://github.com/DemianLi/nexus-agent/issues/832)）。
 *
 * 前景的子代理由基座的 `task` 那顆 `tool-started` 帶 `subagent_type`，之後掛在同一個 namespace 底下的
 * 東西都是它的；背景的沒有那一顆——host 自己丟掉子代理的串流，線上只有從日誌開的卡，namespace 是
 * `[runId, 'tools']`。**編號只有派出去那一刻的呼叫知道**，所以由那顆呼叫的結果告訴折疊器：`runId` 就是
 * namespace 的第一段。
 */
export interface BackgroundSubagentMeta {
  readonly kind: 'background-subagent';
  readonly runId: string;
  readonly subagentType: string;
  /**
   * 這個子代理被指定跑哪一顆模型（型錄 id；[#889](https://github.com/DemianLi/nexus-agent/issues/889)，卡 #709 的後續）。
   * **只有這次派出帶了 `model` 或 `reasoning_effort` 才有**；沒有＝跟著主對話。一個編號從派出到收線不換模型（#876），
   * 所以這是派出那一刻就定的事實，跟 `runId` 一樣放在結果的 `meta` 裡、隨日誌落盤，重新整理之後還在。
   * 只給推理等級時，這裡是主對話目前那一顆。
   */
  readonly model?: string;
  /** 被指定的推理等級（型錄條目宣告過的名字，今天是 `off`）；沒指定就沒有這一格。 */
  readonly reasoningEffort?: string;
}

/** `meta` 是不是背景子代理的鑰匙；形狀歸產生者，這裡只認得出來就好，認不得的一律當沒有。 */
export function isBackgroundSubagentMeta(meta: unknown): meta is BackgroundSubagentMeta {
  if (typeof meta !== 'object' || meta === null) return false;
  const candidate = meta as Partial<Record<keyof BackgroundSubagentMeta, unknown>>;
  return (
    candidate.kind === 'background-subagent' &&
    typeof candidate.runId === 'string' &&
    candidate.runId !== '' &&
    typeof candidate.subagentType === 'string' &&
    (candidate.model === undefined || typeof candidate.model === 'string') &&
    (candidate.reasoningEffort === undefined || typeof candidate.reasoningEffort === 'string')
  );
}

/** `task` 的參數裡才有 subagent 的名字，而它是一段 JSON 字串。 */
function subagentTypeOf(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(input);
    const value = (parsed as { subagent_type?: unknown }).subagent_type;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 派子代理的那顆呼叫帶著背景鑰匙收尾：從此 `namespace[0] === runId` 的東西是那個子代理的，
 * **而且已經到了的也追溯過去**（#832）。
 *
 * 追溯不是裝飾：背景那一輪從日誌開的卡和派出去的那顆呼叫收尾誰先到，取決於 pump 怎麼排，
 * 先到的卡若永遠停在「未歸屬」，畫面就取決於一個沒人保證的順序。歷史重播的順序另有一套（背景卡
 * 在重播裡會不會出現見卡 [#737](https://github.com/DemianLi/nexus-agent/issues/737) 的第 7 張），
 * 但歸屬一樣只由這顆的 meta 決定，與到達順序無關。
 */
function attributeBackground(state: ConversationState, data: ToolData): ConversationState {
  const entry = state.entries.find((candidate) => candidate.id === `tool-${data.tool_call_id}`);
  if (entry?.kind !== 'tool' || !DELEGATION_TOOL_NAMES.includes(entry.name)) return state;
  if (!isBackgroundSubagentMeta(data.meta)) return state;
  const { runId, subagentType } = data.meta;
  const found = { name: subagentType, callId: data.tool_call_id };
  return {
    ...state,
    subagents: { ...state.subagents, [runId]: found },
    entries: state.entries.map((candidate) =>
      (candidate.kind === 'tool' || candidate.kind === 'ai') &&
      candidate.attribution.kind === 'unattributed' &&
      candidate.attribution.namespace[0] === runId
        ? { ...candidate, attribution: { kind: 'subagent', ...found } }
        : candidate,
    ),
  };
}

function reduceTool(
  state: ConversationState,
  namespace: readonly string[],
  raw: unknown,
  time: number | undefined,
): ConversationState {
  const data = raw as ToolData;
  const id = `tool-${data.tool_call_id}`;

  if (data.event === 'tool-started') {
    const name = data.tool_name ?? '(未指名的工具)';
    const subagent = name === 'task' ? subagentTypeOf(data.input) : undefined;
    const key = namespace[0];
    // 這一顆就是歸屬的鑰匙：之後掛在同一個 namespace 底下的東西都是這個 subagent 的。
    const subagents =
      subagent !== undefined && key !== undefined
        ? { ...state.subagents, [key]: { name: subagent, callId: data.tool_call_id } }
        : state.subagents;
    const entry: ToolEntry = {
      kind: 'tool',
      id,
      callId: data.tool_call_id,
      name,
      input: data.input ?? '',
      status: 'running',
      attribution: attribute(state, namespace),
      ...timeField('startedAt', time),
    };
    // **同一個 `tool_call_id` 會來第二次**：人回答了中斷之後圖從 tools 節點重跑，基座
    // 再發一顆 `tool-started`（實測）。無條件 append 的話，畫面上同一顆呼叫長出兩個條目
    // ——而 `id` 是一樣的，所以連「哪一個是真的」都分不出來。第二次是**同一次呼叫的續行**，
    // 更新那一格；`error` 要一起清掉，不然中斷那段留下的字會跟著新狀態一起顯示。`text`、`meta` 同理。
    // 時刻：`startedAt` 留第一顆的，`settledAt` 拿掉——卡又在跑了（見 {@link ToolEntry.startedAt}）。
    if (state.entries.some((existing) => existing.id === id)) {
      return {
        ...state,
        subagents,
        entries: replace(state.entries, id, (existing) => {
          if (existing.kind !== 'tool') return existing;
          const { settledAt: _settled, ...rest } = existing;
          return {
            ...rest,
            status: 'running',
            error: undefined,
            errorCode: undefined,
            text: undefined,
            meta: undefined,
            ...(rest.startedAt === undefined ? timeField('startedAt', time) : {}),
          };
        }),
      };
    }
    return { ...state, subagents, entries: [...state.entries, entry] };
  }

  if (data.event === 'tool-suspended') {
    return {
      ...state,
      entries: replace(state.entries, id, (entry) =>
        // **`error` 不放東西**：那顆中斷的酬載是給折疊器與卡片用的，不是給人看的錯誤字。
        entry.kind === 'tool' ? { ...entry, status: 'suspended', error: undefined } : entry,
      ),
    };
  }

  if (data.event === 'tool-finished') {
    const failed = data.failed === true;
    const settled = {
      ...state,
      entries: replace(state.entries, id, (entry) => {
        if (entry.kind !== 'tool') return entry;
        // 碼同 `text`：照這一顆換掉（pump 的更正幀只差碼時也會來，#667）。沒有碼就不留這一格。
        const { errorCode: _previous, ...rest } = entry;
        return {
          ...rest,
          status: failed ? 'failed' : 'done',
          text: data.message,
          // 同 `text`：照這一顆換掉。pump 的更正幀只差 meta 時也會來（#617）。
          meta: failed ? undefined : data.meta,
          ...(failed ? { error: data.message ?? '未指名的錯誤' } : {}),
          ...(failed && data.code !== undefined ? { errorCode: data.code } : {}),
          ...timeField('settledAt', time),
        };
      }),
    };
    return failed ? settled : attributeBackground(settled, data);
  }

  if (data.event === 'tool-error') {
    return {
      ...state,
      entries: replace(state.entries, id, (entry) =>
        entry.kind === 'tool'
          ? {
              ...entry,
              status: 'failed',
              error: data.message ?? '未指名的錯誤',
              ...(data.code === undefined ? {} : { errorCode: data.code }),
              ...timeField('settledAt', time),
            }
          : entry,
      ),
    };
  }

  return state;
}

interface LifecycleData {
  readonly event: string;
  readonly graph_name?: string;
  readonly error?: string;
  /** 人按了停止。pump 在 root 那顆收尾的 frame 上補的，見 {@link ConversationStatus}。 */
  readonly aborted?: boolean;
  /** 這一輪撞到了輸出上限。同 `aborted` 由 pump 補，見 {@link AiEntry.maxTokens}。 */
  readonly maxTokens?: boolean;
}

/**
 * 這一輪最後一則 root 回覆標上 {@link AiEntry.maxTokens}。一則 root 回覆都沒有就原樣。
 *
 * @param entries - 目前的條目。
 * @param turnStart - 這一輪從哪一格開始。
 * @returns 標過的條目。
 */
function markMaxTokens(
  entries: readonly ConversationEntry[],
  turnStart: number,
): readonly ConversationEntry[] {
  for (let at = entries.length - 1; at >= turnStart; at -= 1) {
    const entry = entries[at];
    if (entry?.kind !== 'ai' || entry.attribution.kind !== 'root') continue;
    const next = [...entries];
    next[at] = { ...entry, maxTokens: true };
    return next;
  }
  return entries;
}

/** 一輪收掉時還沒有結果的那次呼叫，卡上的紅字。 */
export const UNFINISHED_TOOL_TEXT = '這一輪已經結束，這次呼叫沒有結果';

/**
 * 一輪收掉時還沒有結果的那次呼叫，卡上的錯誤碼（[#667](https://github.com/DemianLi/nexus-agent/issues/667)）。
 * 值照 dsh 替沒結果的卡合成的那個（`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:217`），
 * 畫面比它判 stopped（`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:289`）。
 */
export const UNFINISHED_TOOL_CODE = 'interrupted';

/**
 * 這一輪關了（停止、失敗、或不是停在等人的收尾），還在執行中或掛著的工具卡收成失敗。
 *
 * 照 dsh：一輪或一步關閉時沒有 `tool/result` 的呼叫，畫成一則 `Interrupted` 的錯誤結果
 * （`packages/client/ui-chat/src/client/conversation-nodes/tool.ts` 的 `projectBlock` 與
 * `interruption`，`c291e79`）——關閉的原因不分。有結果的那些 pump 已經照日誌收了；產品路徑上會走到
 * 這裡的是停在核准點時按了停止、等核准的在子代理裡（pump 只替 root 懸著的那幾顆寫結果）。正常收尾
 * 的那一支今天沒有生產者：圍堵記了 `tool/call` 之後，`tool/result` 只有日誌寫不進去時才會缺。
 *
 * 收掉的那幾張的 {@link ToolEntry.settledAt} 是收尾那顆 `lifecycle` 的時刻，同 dsh 合成的那則用收尾邊界的 `time`。
 */
function settleUnfinishedTools(
  entries: readonly ConversationEntry[],
  time: number | undefined,
): readonly ConversationEntry[] {
  return entries.map((entry) =>
    entry.kind === 'tool' && (entry.status === 'running' || entry.status === 'suspended')
      ? {
          ...entry,
          status: 'failed',
          error: UNFINISHED_TOOL_TEXT,
          errorCode: UNFINISHED_TOOL_CODE,
          ...timeField('settledAt', time),
        }
      : entry,
  );
}

function reduceLifecycle(
  state: ConversationState,
  namespace: readonly string[],
  raw: unknown,
  time: number | undefined,
): ConversationState {
  const data = raw as LifecycleData;
  if (namespace.length > 0 || data.graph_name !== 'root') {
    // 只有 root 那一層在講「這一輪」；子圖的起訖是它自己的事。
    return state;
  }
  if (data.aborted === true) {
    // **人按了停止**（#276）。先於 `failed`／`completed` 判：被切斷的那一次基座發的是 `failed`，
    // 那不是失敗。停在核准點時的收回也走這裡，所以掛著的卡片一起收掉——伺服器那側已經收回了。
    // 還在吐字的那幾則標成被打斷，還沒有結果的工具卡收成失敗。
    return {
      ...state,
      status: 'stopped',
      error: undefined,
      pendings: [],
      entries: settleUnfinishedTools(state.entries, time).map((entry) =>
        entry.kind === 'ai' && entry.streaming
          ? { ...entry, streaming: false, stopped: true, ...timeField('settledAt', time) }
          : entry,
      ),
    };
  }
  if (data.event === 'running') {
    // **順帶把掛著的核准請求收掉。** 按下去的那一端在 `appendDecision` 就清掉了，
    // 這裡收的是**沒按的那一端**：同一條 thread 上的另一條下行也看得到這顆 running，
    // 那張卡片因此不會留在畫面上等一個已經被別人回答掉的問題。
    //
    // **僅止於此。** 決定本身是本地的（見 {@link appendDecision}），所以旁觀的那一端
    // 看得到被拒那顆的失敗卡（pump 從日誌開、收，#297），不知道是人按了拒絕——它的
    // transcript 上沒有那一則。這條線不回聲決定，這一層補不出來。
    // **清空全部，靠再度中斷把沒答的那些接回來。** 同一輪多顆時這一顆 `running` 是答完
    // 其中一顆之後那個新 run 發的，而沒被答到的中斷會在同一個 run 裡帶著原本那顆 id
    // 再度發一次 `input.requested`（實測），上面的覆寫因此是冪等的。留著不清的話，
    // 旁觀的那一端會抱著一張已經被別人答掉、永遠回答不了的卡片。
    return { ...state, pendings: [], status: 'running', error: undefined };
  }
  if (data.event === 'failed') {
    return {
      ...state,
      status: 'failed',
      error: data.error ?? '未指名的錯誤',
      entries: settleUnfinishedTools(state.entries, time),
    };
  }
  if (data.event === 'completed') {
    // **中斷時 root 照樣發 completed**，所以停在核准點的那一輪不能被它翻成 idle，卡也不收——
    // 那一輪還沒關，卡還在等人。
    if (state.status === 'awaiting-input') return state;
    const settled = settleUnfinishedTools(state.entries, time);
    return {
      ...state,
      status: 'idle',
      entries: data.maxTokens === true ? markMaxTokens(settled, state.turnStart) : settled,
    };
  }
  return state;
}

interface InputRequestedData {
  readonly interrupt_id: string;
  readonly payload?: {
    /** 判別式。**缺席與認不得是兩件事**，見 {@link reduceInputRequested}。 */
    readonly kind?: string;
    readonly actionRequests?: readonly { name: string; args: unknown; description?: string }[];
    readonly reviewConfigs?: readonly { actionName: string; allowedDecisions: string[] }[];
    readonly questions?: readonly QuestionItem[];
    /** 問答卡的來源（#1098）；省略是模型自己問的。 */
    readonly origin?: QuestionOrigin;
  };
}

/**
 * 一顆中斷折成一張待答的卡。
 *
 * ## 三支，不是兩支
 *
 * - `kind` **缺席** 且酬載帶 `actionRequests` 陣列 → 當核准。這是向後相容：五個既有測試檔用基座的 `interruptOn` 造
 *   payload，那條路發的中斷沒有這個欄位。**缺席又沒有 `actionRequests` 的不是核准**，明著壞掉（#1098）。
 * - `kind` 是**認得的值** → 照它折。
 * - `kind` **有值但認不得** → **明著壞掉**（`status: 'failed'`）。
 *
 * **第三支是這一刀最容易寫錯的地方。** 寫成 `kind === 'question' ? 問答 : 核准` 的兩支
 * 三元式，第三種中斷會靜靜地變成一張核准卡——按鈕是 `approve`／`reject`，送出去的是
 * `{decisions:[…]}`，而對面等的是別的東西。那是誤放行，不是漏放行，而**誤放行不會有人
 * 來報錯**（[#231](https://github.com/DemianLi/nexus-agent/issues/231) 的驗收句之一）。
 *
 * ## 判別式的字串為什麼在這裡又寫了一次
 *
 * `@nexus/wire` 不相依 `@nexus/core`（它要在瀏覽器裡跑），所以 `APPROVAL_INTERRUPT_KIND`
 * 與 `QUESTION_INTERRUPT_KIND` 這兩個常數在兩邊各有一份。**兩份對不上是這個設計唯一的
 * 失效模式**，所以 `apps/harness`（唯一同時相依兩邊的地方）有一條測試逐字比對它們。
 */
function reduceInputRequested(
  state: ConversationState,
  namespace: readonly string[],
  raw: unknown,
): ConversationState {
  const data = raw as InputRequestedData;
  const kind = data.payload?.kind;
  const common = { interruptId: data.interrupt_id, namespace };
  let incoming: PendingInput;
  // **缺席即核准只收基座 HITL 的形狀**（有 `actionRequests` 陣列）。沒有 `kind` 也沒有 `actionRequests` 的酬載（例如 adapter 的
  // `type: 'mcp_elicitation'`，#1098）不是核准，畫成核准卡會讓按鈕送出對面不等的形狀；落到下面「認不得」那一支明著壞掉。
  const hitlShaped = Array.isArray(data.payload?.actionRequests);
  if (kind === APPROVAL_PENDING_KIND || (kind === undefined && hitlShaped)) {
    incoming = {
      ...common,
      kind: APPROVAL_PENDING_KIND,
      actions: data.payload?.actionRequests ?? [],
      allowedDecisions: intersectDecisions(data.payload?.reviewConfigs ?? []),
    };
  } else if (kind === QUESTION_PENDING_KIND) {
    incoming = {
      ...common,
      kind: QUESTION_PENDING_KIND,
      questions: data.payload?.questions ?? [],
      ...(data.payload?.origin === undefined ? {} : { origin: data.payload.origin }),
    };
  } else if (kind === undefined) {
    return {
      ...state,
      status: 'failed',
      error:
        '這顆中斷沒有 kind，酬載裡也沒有 actionRequests（核准的形狀），這一版認不得它是什麼。' +
        '把它當核准畫出來會讓人按到送錯形狀的按鈕，所以這裡停下來。',
    };
  } else {
    return {
      ...state,
      status: 'failed',
      error:
        `這顆中斷的 kind 是 ${JSON.stringify(kind)}，這一版認不得。` +
        `認得的是 ${JSON.stringify(APPROVAL_PENDING_KIND)} 與 ${JSON.stringify(QUESTION_PENDING_KIND)}` +
        `（缺席即前者）。把它當核准畫出來會讓人按到送錯形狀的按鈕，所以這裡停下來。`,
    };
  }
  // **同 id 覆寫，不追加。** 答掉一顆之後沒被答到的那些會帶著原本那顆 id 再度中斷
  // （實測），追加的話同一顆中斷會長出第二張卡片，而其中一張永遠回答不了。
  const others = state.pendings.filter(
    (candidate) => candidate.interruptId !== incoming.interruptId,
  );
  return { ...state, status: 'awaiting-input', pendings: [...others, incoming] };
}

/**
 * 逐筆 `allowedDecisions` 的交集。
 *
 * `reviewConfigs` 與 `actionRequests` 是平行陣列，**逐筆詞彙真的分得開**（實測同一顆
 * 中斷上一筆是 `["approve","reject"]`、另一筆是 `["approve"]`）。這一批共用一個決定，
 * 所以只有每一筆都允許的那些才按得下去。
 *
 * 經由我們的組裝這種分歧到不了 —— `packages/nexus-core` 的 fold 對每個 gated tool
 * 固定發 `["approve","reject"]`。**那正是這裡要交集而不是讀 `[0]` 的理由**：那是一個
 * 別處維持著的不變量，這一層不該把它當前提。
 */
function intersectDecisions(
  configs: readonly { readonly allowedDecisions: readonly string[] }[],
): readonly string[] {
  const first = configs[0];
  if (first === undefined) {
    return [];
  }
  return first.allowedDecisions.filter((decision) =>
    configs.every((config) => config.allowedDecisions.includes(decision)),
  );
}
