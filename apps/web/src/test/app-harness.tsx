/**
 * `App` 的畫面測試（`src/App*.test.tsx`）共用的東西：假的 `WireClient`、幀的 helper、每條測試的隔離 hook。
 * 每個測試檔 import 這裡時各自登記一組 `beforeEach`／`afterEach`。`vi.mock` 只對寫它的檔生效，所以附件開關的 mock 留在各測試檔，這裡只放它讀的 `attachmentGate`。
 */
import type { Event, SlashDescriptor, SlashRunOutcome, WireClient } from '@nexus/wire';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { CLEAR_SEARCH_LABEL } from '@/components/sidebar/thread-list';
import { ABORTED_BEFORE_DISPATCH_CODE } from '@/lib/question-view';
import { fakeDownlink } from '@/test/downlink';
import { UNWIRED_WIRE_CONTRACT } from '@/test/wire-contract';

/**
 * 等換手層面板出現或收掉的上限（#1643）。面板要等 150ms 的換手計時器跑完才換上或拿掉，機器負載一高，渲染加上
 * 計時器會超過 testing-library 預設的 1 秒。元素一到位就返回，平常不會多等。
 */
export const PANEL_WAIT = { timeout: 5_000 };

/** 換手層上的面板（核准、提問、計劃審核），名稱與狀態列同一句。 */
export const findPanel = (name: string) => screen.findByRole('region', { name }, PANEL_WAIT);

/**
 * 一份活在記憶體裡的 `Storage`。
 *
 * Node 25 自帶的全域 `localStorage` 蓋住 jsdom 那一份的問題，已由 `vitest.shared.ts` 統一關掉（`--no-webstorage`，
 * #1602）；這份 stub 留著是為了每條測試之間隔離，上一條寫進去的不會留到下一條。
 */
/** 側欄清單裡的會話列。搜尋框有字時的 ×（#1307）也是按鈕，不是列。 */
export function threadRows(list: HTMLElement): HTMLElement[] {
  return within(list)
    .queryAllByRole('button')
    .filter((button) => button.getAttribute('aria-label') !== CLEAR_SEARCH_LABEL);
}

export function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, String(value)),
  };
}

// 測試檔的 `vi.mock` 讀這個開關（#733）：預設關著，整條送出路徑的測試才打開。
export const attachmentGate = { on: false };

// App 會把 thread id 記進 `localStorage`；每條一份新的，不然下一條測試就成了「接回上一次」。
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  attachmentGate.on = false;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * 畫面這一層。
 *
 * **折疊的正確性不在這裡驗**——那在 `@nexus/wire`（單元）與 `@nexus/harness`
 * （對著真的 agent 跑過真的線）。這裡只驗「折出來的東西有沒有畫出來」，所以 client
 * 是假的、frame 是手餵的。
 */

/** 列檔（`@` 引用，#651）這一檔沒有接：`@` 的選單查一次就收起來。要它的測試自己換掉這一格。 */
export const UNWIRED_FILE_REFERENCES: Pick<WireClient, 'fileReferences'> = {
  fileReferences: async () => ({ kind: 'rejected', message: '這一檔沒有接列檔' }),
};

/** 全部會話共用的那條下行（#632）：預設開不起來也不失敗，側欄就跟沒有這條線一樣。要它的測試自己換掉這一格。 */
export const SILENT_THREAD_FEED: Pick<WireClient, 'openThreadFeed'> = {
  openThreadFeed: () => new Promise<never>(() => undefined),
};

/** 按內容搜尋（#631）這一檔沒有接：開不起來也不失敗。 */
export const UNWIRED_THREAD_SEARCH: Pick<WireClient, 'searchThreads'> = {
  searchThreads: () => new Promise<never>(() => undefined),
};

/** 列會話候選（`@` 引用別的會話，#713）這一檔沒有接。 */
export const UNWIRED_SESSION_REFERENCES: Pick<WireClient, 'sessionReferences'> = {
  sessionReferences: async () => ({ kind: 'rejected', message: '這一檔沒有接列會話' }),
};

let seq = 0;

/** 下一幀的序號從 `value` 起算。 */
export function setSeq(value: number): void {
  seq = value;
}

export function frame(method: string, namespace: readonly string[], data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `t:${current}`,
    method,
    params: { namespace, timestamp: 0, data },
  } as Event;
}

export function textFrames(id: string, namespace: readonly string[], body: string): Event[] {
  return [
    frame('messages', namespace, { event: 'message-start', id: `run-${id}`, run_id: id }),
    ...[...body].map((character) =>
      frame('messages', namespace, {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: character },
        run_id: id,
      }),
    ),
    frame('messages', namespace, { event: 'message-finish', reason: 'stop', run_id: id }),
  ];
}

/**
 * 回饋那四個 method 在這一檔裡一律「收不了」。**評分的畫面驗在 `feedback-ui.test.tsx`**；這裡的測試
 * 不碰它們，碰到就是測試寫錯了，所以回拒絕而不是回成功。
 */
export const UNWIRED_FEEDBACK: Pick<
  WireClient,
  'feedbackPut' | 'feedbackDelete' | 'feedbackList' | 'feedbackRecord'
> = {
  feedbackPut: async () => ({ kind: 'rejected', message: '這一檔沒有接回饋' }),
  feedbackDelete: async () => ({ kind: 'rejected', message: '這一檔沒有接回饋' }),
  feedbackList: async () => ({ kind: 'rejected', message: '這一檔沒有接回饋' }),
  feedbackRecord: async () => ({ kind: 'rejected', message: '這一檔沒有接回饋' }),
};

/**
 * 送出佇列的改與刪同一條理由：這一檔的測試不碰它，碰到就是測試寫錯了，所以回拒絕。
 */
export const UNWIRED_QUEUE: Pick<WireClient, 'queueUpdate'> = {
  queueUpdate: async () => ({
    type: 'error',
    id: 0,
    error: 'not_supported',
    message: '這一檔沒有接送出佇列',
  }),
};

/** 對單一背景子代理傳話、單獨停（#865）同一條理由：這一檔的測試不碰它。 */
export const UNWIRED_SUBAGENT: Pick<
  WireClient,
  'subagentSend' | 'subagentInterrupt' | 'subagentHistory' | 'trajectoryTurn'
> = {
  subagentSend: async () => ({
    type: 'error',
    id: 0,
    error: 'not_supported',
    message: '這一檔沒有接背景子代理',
  }),
  subagentInterrupt: async () => ({
    type: 'error',
    id: 0,
    error: 'not_supported',
    message: '這一檔沒有接背景子代理',
  }),
  subagentHistory: async () => ({ kind: 'rejected', message: '這一檔沒有接背景子代理' }),
  trajectoryTurn: async () => ({
    kind: 'rejected',
    code: 'not_supported',
    message: '這一檔沒有接軌跡細節',
  }),
};

/**
 * 「以前的會話」同一條理由：要清單的測試自己換掉這一格。**歷史回一份空的、不是拒絕**：每一條 thread 開起來都會
 * 拿歷史，拒絕的話畫面上多一行「拿不回來」，跟這一條測試要驗的東西無關。要歷史的測試自己換掉。
 */
export const UNWIRED_THREAD_LIST: Pick<WireClient, 'listThreads' | 'threadHistory'> = {
  listThreads: async () => ({ kind: 'rejected', message: '這一條測試沒有接清單' }),
  threadHistory: async () => ({
    kind: 'ok',
    result: { events: [], firstSeq: 0, throughSeq: -1, hasMore: false, legacy: false },
  }),
};

/** 一個可以隨時推 frame 進去的假 client。 */
export function fakeClient(
  events: readonly Event[],
  slash: {
    readonly commands?: readonly SlashDescriptor[];
    readonly run?: (line: string) => SlashRunOutcome | Promise<SlashRunOutcome>;
  } = {},
) {
  const sent: string[] = [];
  const responded: unknown[] = [];
  const slashed: string[] = [];
  const opened: string[] = [];
  const cancels: string[] = [];
  /** 收過的請求編號（thread＋編號）→ 那一件的 `run_id`。 */
  const requested = new Map<string, string>();
  const downlink = fakeDownlink();
  const client: WireClient = {
    ...UNWIRED_WIRE_CONTRACT,
    ...UNWIRED_FILE_REFERENCES,
    ...SILENT_THREAD_FEED,
    ...UNWIRED_THREAD_SEARCH,
    ...UNWIRED_SESSION_REFERENCES,
    ...UNWIRED_SUBAGENT,
    slashList: async () => ({ kind: 'ok', commands: slash.commands ?? [] }),
    slashRun: async (_threadId, line) => {
      slashed.push(line);
      return slash.run?.(line) ?? { kind: 'unknown' };
    },
    openEvents: async (threadId) => {
      opened.push(threadId);
      return downlink.open(threadId, events);
    },
    // 收下就照伺服器的順序推「排著」與「領走」，人的話由後者畫（#645）。
    // 認得收過的請求編號（#1335，照 harness 的 `findPromptRequest`）：只比編號，回原本那一件的 `run_id`，不再排。
    runStart: async (threadId, text, options) => {
      const key =
        options?.requestId === undefined ? undefined : `${threadId}\n${options.requestId}`;
      const seen = key === undefined ? undefined : requested.get(key);
      if (seen !== undefined) return { type: 'success', id: 1, result: { run_id: seen } };
      sent.push(text);
      const runId = downlink.accept(threadId, text);
      if (key !== undefined) requested.set(key, runId);
      return { type: 'success', id: 1, result: { run_id: runId } };
    },
    inputRespond: async (_threadId, params) => {
      responded.push(params);
      return { type: 'success', id: 2, result: {} };
    },
    runCancel: async (threadId) => {
      cancels.push(threadId);
      return { type: 'success', id: 3, result: { accepted: true } };
    },
    ...UNWIRED_FEEDBACK,
    ...UNWIRED_QUEUE,
    ...UNWIRED_THREAD_LIST,
  };
  return { client, sent, responded, slashed, opened, cancels, downlink };
}

/** 一顆核准請求。逐筆詞彙照基座的形狀給——`reviewConfigs` 與 `actionRequests` 平行。 */
export function approvalFrame(
  actions: readonly { name: string; allowed: readonly string[] }[],
  interruptId = 'int-1',
): Event {
  return frame('input.requested', [], {
    interrupt_id: interruptId,
    payload: {
      actionRequests: actions.map((action) => ({ name: action.name, args: { n: action.name } })),
      reviewConfigs: actions.map((action) => ({
        actionName: action.name,
        allowedDecisions: [...action.allowed],
      })),
    },
  });
}

/**
 * 說明是 `text` 的那一條 toast。sonner 的 toast 是全域的、跨測試留著，所以 `text` 要是這一條測試才有的字；同一句也可能畫在
 * 狀態列上，只取 toast 裡的那一個。
 */
export async function toastWith(text: string): Promise<Element> {
  return waitFor(() => {
    const card = screen
      .getAllByText(text)
      .map((element) => element.closest('[data-sonner-toast]'))
      .find((found) => found !== null);
    if (card === undefined || card === null) throw new Error(`沒有說明是「${text}」的 toast`);
    return card;
  });
}

/** 一顆問答請求的 frame。 */
export function questionFrame(interruptId = 'q-1'): Event {
  return frame('input.requested', ['tools:a'], {
    interrupt_id: interruptId,
    payload: {
      kind: 'question',
      questions: [
        { id: 'name', question: '訪客姓名？', header: '姓名' },
        { id: 'day', question: '哪一天？', options: [{ label: '週一' }, { label: '週二' }] },
      ],
    },
  });
}

/** 這兩題的提問面板（#409）：換手層的 region，名稱與狀態列同一句。 */
export const questionPanel = () => findPanel('有 2 個問題要你回答');

/** 當前這一題的自由作答列。其他題的 fieldset 是 `hidden`，`getByRole` 不會抓到。 */
export const freeAnswer = (panel: HTMLElement) =>
  within(panel).getByRole('textbox', { name: '輸入你的答案' });

/** pump 收回時卡上的那一句（紅字是給模型看的英文）；碼才是 web 比的東西。 */
export const WITHDRAWN_TEXT = 'Error: tool call aborted before dispatch';

/** 停在提問時按了停止：這一輪的 frame 照 pump 收回時發的順序（`ThreadPump.#withdraw`）。 */
export function stoppedQuestionFrames(): Event[] {
  const input = JSON.stringify({
    questions: [
      { id: 'day', question: '哪一天？', options: [{ label: '週一', description: '早上' }] },
    ],
  });
  return [
    frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    frame('tools', ['tools:a'], {
      event: 'tool-started',
      tool_call_id: 'ask-1',
      tool_name: 'ask_user_question',
      input,
    }),
    frame('tools', ['tools:a'], { event: 'tool-suspended', tool_call_id: 'ask-1' }),
    questionFrame('q-s'),
    frame('tools', ['tools:a'], {
      event: 'tool-finished',
      tool_call_id: 'ask-1',
      failed: true,
      message: WITHDRAWN_TEXT,
      code: ABORTED_BEFORE_DISPATCH_CODE,
    }),
    frame('lifecycle', [], { event: 'completed', graph_name: 'root', aborted: true }),
  ];
}

/** 子代理歷史的 frame：不帶 seq，同 server 那側。 */
export const historyFrame = (method: string, data: unknown): Event =>
  ({ type: 'event', method, params: { namespace: [], timestamp: 0, data } }) as Event;

export const historySaid = (role: 'human' | 'ai', id: string, text: string): Event[] => [
  historyFrame('messages', { event: 'message-start', role, id }),
  historyFrame('messages', {
    event: 'content-block-delta',
    index: 0,
    delta: { type: 'text-delta', text },
    id,
  }),
  historyFrame('messages', { event: 'message-finish', reason: 'stop', id }),
];
