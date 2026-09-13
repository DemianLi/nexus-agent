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
 * 2. 重連之後才接上——`tools` frame 早就過去了，而這條線沒有重播也沒有歷史重抓
 *    （見開發計劃第 7 節決策 6）。
 *
 * 協定其實留了位子給這件事（`LifecycleData.cause`，註解明寫「Populated by …
 * deepagents' SubagentTransformer」），但 `deepagents@1.13.1` 沒填。哪天它填了，
 * 這個 join 就可以退休——`subagent-cause` 那條測試會是第一個發現的人。
 */

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
   * **而 `done` 不等於「成功了」的那一半也一起收了**：一則 `status: 'error'` 的
   * ToolMessage 走的是 `tool-finished`，pump 會補一格 `failed`，這裡讀它。兩面不一起收的
   * 話，「掛著的不顯示失敗」單獨綠得起來——把全部都畫成「執行中」也會綠。
   */
  readonly status: 'running' | 'suspended' | 'done' | 'failed';
  readonly output?: unknown;
  readonly error?: string;
  readonly attribution: Attribution;
}

/**
 * 人在核准點上按了什麼。
 *
 * **這一則只有本地記得：下行不回聲決定。** 當初的實測是在**基座機制**上做的——中斷
 * 發生在 `afterModel`，tools node 從沒跑，而拒絕產生的那則 error ToolMessage 走
 * `updates`（白名單外），「全拒絕」與「一核准一拒絕」在下行上一模一樣。**那個機制在
 * [#112](https://github.com/DemianLi/nexus-agent/pull/112) 之後不是產品路徑了**（中斷改
 * 在 `wrapToolCall` 裡，拒絕會產生一則 `status` 為 error 的 ToolMessage）。
 *
 * **產品路徑 2026-09-09 量了，答案是它不會變成任何一顆 `tools` frame**
 * （`apps/harness/src/rejection-wire.test.ts`）：閘門的 `interrupt()` 與 `denial()` 都在
 * `handler(request)` **之前**，那一格從頭到尾沒進到基座發生命週期事件的那一段，所以連
 * `tool-started` 都沒有；同一份檔案裡核准那條是對照組，證明線本身收得到 `tools` frame。
 * **別把 `ask_user_question` 那條的測量套過來**——那顆的 `interrupt()` 在工具本體裡，
 * `tool-started` 早就發過了，掛著那段看得到 `tool-error`（`tool-frame-classify.test.ts`）。
 *
 * 結論因此比原本寫的更強：不是「不靠那個機制」，是**兩個機制都量過，下行都沒有一個欄位
 * 說「人按了什麼」**。所以決定要跟 {@link appendHumanTurn} 一樣在送出的那一刻自己寫進來，
 * 那不是裝飾，是唯一的紀錄。
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

export type ConversationEntry = HumanEntry | AiEntry | ToolEntry | DecisionEntry | AnswerEntry;

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
}

const ROOT: Attribution = { kind: 'root' };

export function emptyConversation(): ConversationState {
  return { entries: [], status: 'idle', pendings: [], lastSeq: -1, subagents: {} };
}

/**
 * 把使用者剛送出去的那句話放進來。
 *
 * **線上不會回聲它**：`run.start` 的 input 不會變成下行的 frame，而 `input` channel
 * 上只有核准請求。所以送出的那一刻由這裡補，不是等它回來。
 */
export function appendHumanTurn(state: ConversationState, text: string): ConversationState {
  const entry: HumanEntry = { kind: 'human', id: `human-${state.entries.length}`, text };
  return { ...state, entries: [...state.entries, entry], status: 'running' };
}

/**
 * 把人剛按下去的那個決定放進來，並把核准請求收掉。
 *
 * 跟 {@link appendHumanTurn} 同一個理由：**線上不回聲**。差別在這件事更嚴重——
 * 使用者說的話至少還會以模型的回應間接留下痕跡，而一個被拒絕的工具呼叫在下行上
 * 一顆 frame 都沒有（實測），這則 entry 是它存在過的唯一證據。
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
    default:
      return advanced;
  }
}

/** 一次折一整串。 */
export function reduceAll(state: ConversationState, events: Iterable<Event>): ConversationState {
  let next = state;
  for (const event of events) {
    next = reduceConversation(next, event);
  }
  return next;
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
  readonly id?: string;
  readonly run_id?: string;
  readonly delta?: { readonly type?: string; readonly text?: string };
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
      const entry: AiEntry = {
        kind: 'ai',
        id,
        text: '',
        streaming: true,
        attribution: attribute(state, namespace),
      };
      return { ...state, entries: [...state.entries, entry] };
    }
    case 'content-block-delta': {
      if (data.delta?.type !== 'text-delta') {
        // reasoning 與工具參數的 delta 這一版不呈現；工具走 `tools` channel。
        return state;
      }
      const text = data.delta.text ?? '';
      return {
        ...state,
        entries: replace(state.entries, id, (entry) =>
          entry.kind === 'ai' ? { ...entry, text: entry.text + text } : entry,
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
  readonly output?: unknown;
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
            ? { ...existing, status: 'running', error: undefined, output: undefined }
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
              output: data.output,
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
    // 還在吐字的那幾則標成被打斷。
    return {
      ...state,
      status: 'stopped',
      error: undefined,
      pendings: [],
      entries: state.entries.map((entry) =>
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
    // 只知道「不必再問了」，不知道人按了什麼——它的 transcript 上沒有那一則。這條線
    // 不回聲決定，這一層補不出來。
    // **清空全部，靠再度中斷把沒答的那些接回來。** 同一輪多顆時這一顆 `running` 是答完
    // 其中一顆之後那個新 run 發的，而沒被答到的中斷會在同一個 run 裡帶著原本那顆 id
    // 再度發一次 `input.requested`（實測），上面的覆寫因此是冪等的。留著不清的話，
    // 旁觀的那一端會抱著一張已經被別人答掉、永遠回答不了的卡片。
    return { ...state, pendings: [], status: 'running', error: undefined };
  }
  if (data.event === 'failed') {
    return { ...state, status: 'failed', error: data.error ?? '未指名的錯誤' };
  }
  if (data.event === 'completed') {
    // **中斷時 root 照樣發 completed**，所以停在核准點的那一輪不能被它翻成 idle。
    return state.status === 'awaiting-input' ? state : { ...state, status: 'idle' };
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
