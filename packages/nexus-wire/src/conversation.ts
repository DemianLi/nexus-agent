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
import { DELIVERABLES_PRESENTED } from './deliverables.js';
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
   * 文字時這一格不給**（照 dsh 的 `singleResultText`，不自己把幾塊拼起來），太長的那幾段由
   * harness 取頭尾各半、中間放一行說明。
   *
   * **`tool-finished` 失敗的那些，{@link ToolEntry.error} 裝的是同一串字**：紅字那一格留給
   * 畫面，判斷畫哪一種看 {@link ToolEntry.status}。`tool-error`（本體炸了、基座那條路）只寫
   * `error`，那一顆線上本來就沒有結果訊息可抽。
   */
  readonly text?: string;
  readonly error?: string;
  readonly attribution: Attribution;
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
 * {@link appendHumanTurn} 一樣在送出的那一刻自己寫進來，與那張卡並存——那不是裝飾，是唯一的紀錄。
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
}

export type ConversationEntry =
  | HumanEntry
  | AiEntry
  | ToolEntry
  | DecisionEntry
  | AnswerEntry
  | DeliverablesEntry
  | WorkspaceChangesEntry;

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

/** 問人的一題。形狀照抄 dsh 的 `AskUserQuestionItem` 在**模型面**的那五格。 */
export interface QuestionItem {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
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

/** 停在問答點：模型問了一組問題，等人填。 */
export interface PendingQuestion extends PendingCommon {
  readonly kind: typeof QUESTION_PENDING_KIND;
  readonly questions: readonly QuestionItem[];
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
  };
}

/**
 * 把使用者剛送出去的那句話放進來。
 *
 * **線上不會回聲它**：`run.start` 的 input 不會變成下行的 frame，而 `input` channel
 * 上只有核准請求。所以送出的那一刻由這裡補，不是等它回來。
 */
export function appendHumanTurn(state: ConversationState, text: string): ConversationState {
  const entry: HumanEntry = { kind: 'human', id: `human-${state.entries.length}`, text };
  return trackTurn(state, { ...state, entries: [...state.entries, entry], status: 'running' });
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
 * 跟 {@link appendHumanTurn} 同一個理由：**線上不回聲**。被拒的那顆呼叫下行上有一張失敗的卡，
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

  switch (event.method) {
    case 'messages':
      return reduceMessage(advanced, namespace, event.params.data);
    case 'tools':
      return reduceTool(advanced, namespace, event.params.data);
    case 'lifecycle':
      return reduceLifecycle(advanced, namespace, event.params.data);
    case 'input.requested':
      return reduceInputRequested(advanced, namespace, event.params.data);
    case 'custom':
      return reduceCustom(advanced, event.params.data);
    default:
      return advanced;
  }
}

/** `files` 裡的一格長得像不像一個交付的檔案。 */
function isPresentedFile(value: unknown): value is WirePresentedFile {
  if (typeof value !== 'object' || value === null) return false;
  const { path, description } = value as Record<string, unknown>;
  return typeof path === 'string' && (description === undefined || typeof description === 'string');
}

/**
 * `custom` frame。**只認 {@link DELIVERABLES_PRESENTED}、{@link WORKSPACE_CHANGES}、{@link MODEL_USAGE} 與
 * {@link CONTEXT_MEASURE}**，其他名字、形狀不對的一律略過：這個 channel 上的東西由 pump 從日誌合成，認不得的不猜。
 */
function reduceCustom(state: ConversationState, data: unknown): ConversationState {
  const { name, payload } = (data ?? {}) as { name?: unknown; payload?: unknown };
  if (typeof payload !== 'object' || payload === null) return state;
  if (name === WORKSPACE_CHANGES) return reduceWorkspaceChanges(state, payload);
  if (name === MODEL_USAGE) return reduceModelUsage(state, payload);
  if (name === CONTEXT_MEASURE) return reduceContextMeasure(state, payload);
  if (name !== DELIVERABLES_PRESENTED) return state;
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
  const entry: DeliverablesEntry = { kind: 'deliverables', id, callId, seq, files };
  return { ...state, entries: [...state.entries, entry] };
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

/** `workspace/changes` 的 `payload`：`seq` 要是非負整數，同一個 `seq` 只長一格。 */
function reduceWorkspaceChanges(state: ConversationState, payload: object): ConversationState {
  const { seq } = payload as { seq?: unknown };
  if (!isSeq(seq)) return state;
  const id = `workspace-changes:${seq}`;
  if (state.entries.some((entry) => entry.id === id)) return state;
  const entry: WorkspaceChangesEntry = { kind: 'workspace-changes', id, seq };
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
 * 頁是在一輪的開頭切的（server 那側），所以同一顆工具呼叫不會一半在這頁、一半在下一頁。
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
  /** `message-start` 的作者。**`human` 只有歷史送**：線上不回聲人打的字，見 {@link appendHumanTurn}。 */
  readonly role?: string;
  readonly id?: string;
  readonly run_id?: string;
  /** `text-delta` 帶 `text`，`reasoning-delta` 帶 `reasoning`（`@langchain/core` 的 `ContentBlockDelta`）。 */
  readonly delta?: { readonly type?: string; readonly text?: string; readonly reasoning?: string };
  readonly message?: string;
}

function reduceMessage(
  state: ConversationState,
  namespace: readonly string[],
  raw: unknown,
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
        // `status` 不動——這一句已經說過了，不是剛送出去的那一句（那一句走 `appendHumanTurn`）。
        const entry: HumanEntry = { kind: 'human', id, text: '' };
        return { ...state, entries: [...state.entries, entry] };
      }
      const entry: AiEntry = {
        kind: 'ai',
        id,
        text: '',
        streaming: true,
        attribution: attribute(state, namespace),
        ...(typeof data.id === 'string' && data.id !== '' && { messageId: data.id }),
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
          entry.kind === 'ai' ? { ...entry, streaming: false } : entry,
        ),
      };
    case 'error':
      return {
        ...state,
        entries: replace(state.entries, id, (entry) =>
          entry.kind === 'ai'
            ? { ...entry, streaming: false, error: data.message ?? '未指名的錯誤' }
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

function reduceTool(
  state: ConversationState,
  namespace: readonly string[],
  raw: unknown,
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
    };
    // **同一個 `tool_call_id` 會來第二次**：人回答了中斷之後圖從 tools 節點重跑，基座
    // 再發一顆 `tool-started`（實測）。無條件 append 的話，畫面上同一顆呼叫長出兩個條目
    // ——而 `id` 是一樣的，所以連「哪一個是真的」都分不出來。第二次是**同一次呼叫的續行**，
    // 更新那一格；`error` 要一起清掉，不然中斷那段留下的字會跟著新狀態一起顯示。
    if (state.entries.some((existing) => existing.id === id)) {
      return {
        ...state,
        subagents,
        entries: replace(state.entries, id, (existing) =>
          existing.kind === 'tool'
            ? { ...existing, status: 'running', error: undefined, text: undefined }
            : existing,
        ),
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
    return {
      ...state,
      entries: replace(state.entries, id, (entry) =>
        entry.kind === 'tool'
          ? {
              ...entry,
              status: failed ? 'failed' : 'done',
              text: data.message,
              ...(failed ? { error: data.message ?? '未指名的錯誤' } : {}),
            }
          : entry,
      ),
    };
  }

  if (data.event === 'tool-error') {
    return {
      ...state,
      entries: replace(state.entries, id, (entry) =>
        entry.kind === 'tool'
          ? { ...entry, status: 'failed', error: data.message ?? '未指名的錯誤' }
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
}

/** 一輪收掉時還沒有結果的那次呼叫，卡上的紅字。 */
export const UNFINISHED_TOOL_TEXT = '這一輪已經結束，這次呼叫沒有結果';

/**
 * 這一輪關了（停止、失敗、或不是停在等人的收尾），還在執行中或掛著的工具卡收成失敗。
 *
 * 照 dsh：一輪或一步關閉時沒有 `tool/result` 的呼叫，畫成一則 `Interrupted` 的錯誤結果
 * （`packages/client/ui-chat/src/client/conversation-nodes/tool.ts` 的 `projectBlock` 與
 * `interruption`，`c291e79`）——關閉的原因不分。有結果的那些 pump 已經照日誌收了；產品路徑上會走到
 * 這裡的是停在核准點時按了停止、等核准的在子代理裡（pump 只替 root 懸著的那幾顆寫結果）。正常收尾
 * 的那一支今天沒有生產者：圍堵記了 `tool/call` 之後，`tool/result` 只有日誌寫不進去時才會缺。
 */
function settleUnfinishedTools(
  entries: readonly ConversationEntry[],
): readonly ConversationEntry[] {
  return entries.map((entry) =>
    entry.kind === 'tool' && (entry.status === 'running' || entry.status === 'suspended')
      ? { ...entry, status: 'failed', error: UNFINISHED_TOOL_TEXT }
      : entry,
  );
}

function reduceLifecycle(
  state: ConversationState,
  namespace: readonly string[],
  raw: unknown,
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
      entries: settleUnfinishedTools(state.entries).map((entry) =>
        entry.kind === 'ai' && entry.streaming
          ? { ...entry, streaming: false, stopped: true }
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
      entries: settleUnfinishedTools(state.entries),
    };
  }
  if (data.event === 'completed') {
    // **中斷時 root 照樣發 completed**，所以停在核准點的那一輪不能被它翻成 idle，卡也不收——
    // 那一輪還沒關，卡還在等人。
    return state.status === 'awaiting-input'
      ? state
      : { ...state, status: 'idle', entries: settleUnfinishedTools(state.entries) };
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
  };
}

/**
 * 一顆中斷折成一張待答的卡。
 *
 * ## 三支，不是兩支
 *
 * - `kind` **缺席** → 當核准。這是向後相容：五個既有測試檔用基座的 `interruptOn` 造
 *   payload，那條路發的中斷沒有這個欄位。
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
  if (kind === undefined || kind === APPROVAL_PENDING_KIND) {
    incoming = {
      ...common,
      kind: APPROVAL_PENDING_KIND,
      actions: data.payload?.actionRequests ?? [],
      allowedDecisions: intersectDecisions(data.payload?.reviewConfigs ?? []),
    };
  } else if (kind === QUESTION_PENDING_KIND) {
    incoming = { ...common, kind: QUESTION_PENDING_KIND, questions: data.payload?.questions ?? [] };
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
