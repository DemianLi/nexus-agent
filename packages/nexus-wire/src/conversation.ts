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
}

export interface ToolEntry {
  readonly kind: 'tool';
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  /** 參數照線上給的原樣留著（基座給的是 JSON 字串），不在這一層猜它的形狀。 */
  readonly input: string;
  readonly status: 'running' | 'done' | 'failed';
  readonly output?: unknown;
  readonly error?: string;
  readonly attribution: Attribution;
}

/**
 * 人在核准點上按了什麼。
 *
 * **這一則只有本地記得。** 實測下行完全不回聲決定：中斷發生在 `afterModel`，
 * tools node 從沒跑，而拒絕產生的那則 error ToolMessage 走 `updates`（白名單外）。
 * 「全拒絕」與「一核准一拒絕」在下行上一模一樣——都只有模型再講一輪話。所以決定
 * 要跟 {@link appendHumanTurn} 一樣在送出的那一刻自己寫進來，那不是裝飾，是唯一的紀錄。
 */
export interface DecisionEntry {
  readonly kind: 'decision';
  readonly id: string;
  /** 詞彙由基座定（`approve` / `reject`），這一層不窄化它。 */
  readonly decision: string;
  /** 這個決定套到哪幾筆工具呼叫上——全有全無，所以是全部。 */
  readonly actions: readonly string[];
}

export type ConversationEntry = HumanEntry | AiEntry | ToolEntry | DecisionEntry;

/**
 * 這一輪的狀態。
 *
 * `awaiting-input` 是停在核准點——**不是結束**。基座在中斷時照樣發
 * `lifecycle completed / root`，所以那顆不能當「跑完了」用（決策 6 第 2 條）。
 */
export type ConversationStatus = 'idle' | 'running' | 'awaiting-input' | 'failed';

export interface PendingInput {
  readonly interruptId: string;
  /**
   * 這顆中斷掛在哪一層。回答時原樣送回去。
   *
   * 目前 handler 用不到它（`Command({ resume })` 直接接在 root 上），但協定的
   * `input.respond` 要它，而下行只發這一次——這裡丟掉就再也接不回來了。
   */
  readonly namespace: readonly string[];
  readonly actions: readonly {
    readonly name: string;
    readonly args: unknown;
    readonly description?: string;
  }[];
  /**
   * 這一批**共同**允許的決定——逐筆 `allowedDecisions` 的交集。
   *
   * 交集而不是 `[0]`、也不是聯集：一個決定要套到整批上（全有全無，見
   * {@link DecisionEntry}），而基座對不在那一筆清單裡的決定是當場拋
   * （`langchain@1.5.10`，`hitl.js:407`）——多出來的那顆按鈕按下去是整場 run 死。
   */
  readonly allowedDecisions: readonly string[];
}

export interface ConversationState {
  readonly entries: readonly ConversationEntry[];
  readonly status: ConversationStatus;
  readonly error?: string;
  readonly pending?: PendingInput;
  /** 收過的最大 seq。線上是單調的（server 端跨 run 重編過號），拿它擋重複與亂序。 */
  readonly lastSeq: number;
  /** `namespace[0]` → 那個 `task` 呼叫派出去的 subagent。 */
  readonly subagents: Readonly<Record<string, { readonly name: string; readonly callId: string }>>;
}

const ROOT: Attribution = { kind: 'root' };

export function emptyConversation(): ConversationState {
  return { entries: [], status: 'idle', lastSeq: -1, subagents: {} };
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
 * 沒有掛著的核准請求時原樣回傳：重複按下去的第二次不該憑空長出一則紀錄。
 */
export function appendDecision(state: ConversationState, decision: string): ConversationState {
  const pending = state.pending;
  if (pending === undefined) {
    return state;
  }
  const entry: DecisionEntry = {
    kind: 'decision',
    id: `decision-${pending.interruptId}`,
    decision,
    actions: pending.actions.map((action) => action.name),
  };
  const { pending: _cleared, ...rest } = state;
  return { ...rest, entries: [...state.entries, entry], status: 'running' };
}

/**
 * 一個決定攤成基座要的那份回覆。
 *
 * **`decisions` 是位置對應的，而且長度不符會殺掉整場 run**：基座逐 index 把決定配到
 * 被中斷的工具呼叫上，`decisions.length !== interruptToolCalls.length` 當場拋，線上
 * 就是一顆 `lifecycle failed / root`。全有全無的介面因此要送滿 `actions.length` 筆
 * 同型決定——這個攤平放在這裡，是為了讓「基座這一版的回覆長什麼樣」只有一個地方知道。
 */
export function uniformDecisions(pending: PendingInput, decision: string): unknown {
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
    return { ...state, subagents, entries: [...state.entries, entry] };
  }

  if (data.event === 'tool-finished') {
    return {
      ...state,
      entries: replace(state.entries, id, (entry) =>
        entry.kind === 'tool' ? { ...entry, status: 'done', output: data.output } : entry,
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
  if (data.event === 'running') {
    // **順帶把掛著的核准請求收掉。** 按下去的那一端在 `appendDecision` 就清掉了，
    // 這裡收的是**沒按的那一端**：同一條 thread 上的另一條下行也看得到這顆 running，
    // 那張卡片因此不會留在畫面上等一個已經被別人回答掉的問題。
    //
    // **僅止於此。** 決定本身是本地的（見 {@link appendDecision}），所以旁觀的那一端
    // 只知道「不必再問了」，不知道人按了什麼——它的 transcript 上沒有那一則。這條線
    // 不回聲決定，這一層補不出來。
    const { pending: _answered, ...rest } = state;
    return { ...rest, status: 'running', error: undefined };
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
    readonly actionRequests?: readonly { name: string; args: unknown; description?: string }[];
    readonly reviewConfigs?: readonly { actionName: string; allowedDecisions: string[] }[];
  };
}

function reduceInputRequested(
  state: ConversationState,
  namespace: readonly string[],
  raw: unknown,
): ConversationState {
  const data = raw as InputRequestedData;
  const actions = data.payload?.actionRequests ?? [];
  return {
    ...state,
    status: 'awaiting-input',
    pending: {
      interruptId: data.interrupt_id,
      namespace,
      actions,
      allowedDecisions: intersectDecisions(data.payload?.reviewConfigs ?? []),
    },
  };
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
