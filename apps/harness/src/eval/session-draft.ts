/**
 * 離線起草負向案例：從會話日誌撈出該補進題庫的那幾輪、排序、印成 `BenchmarkCase` 的殼。
 * [#280](https://github.com/DemianLi/nexus-agent/issues/280)。進入點是 `sessions-cli.ts` 的 `draft`。
 *
 * ## 只做到半自動
 *
 * 地圖 #263 拍板：撈出、排序、起草，**不寫進題庫**——「該怎麼做才對」只有人知道。所以草稿能填的
 * 只有 `id` 與 `prompt`，`expected` 是空殼；那一輪實際發生的工具呼叫印在註解裡當參考，人要看
 * 模型做錯了什麼才填得出對的，而它**不是答案**。只印終端、不寫檔，同 `scan`（#280 拍板）。
 *
 * 整份輸出除了草稿本身都是 `//` 註解，所以**整段貼進陣列就是合法的程式碼**——要挑哪幾塊由人決定，
 * 但貼錯不會讓 `dataset.ts` 壞掉。
 *
 * ## 單位是輪，不是份
 *
 * 四個信號裡三個本來就歸得到輪上（點踩的那則回覆所屬那一輪、`turn/end` 的中止、`turn/failed`；
 * 點踩怎麼歸見 `session-scan.ts` 的 `ratingsByTurn`），打轉在 `scan`
 * 裡卻是逐份的最長串。這裡把它也收到輪上，而且**不必另訂規則**：提醒器那條鏈清零的地方（不是
 * `resume` 的 `turn/start`、`session/end-seed`，見 `session-scan.ts` 檔頭）恰好就是輪的邊界，所以
 * 「一輪裡的最長串」就是那條鏈在這一輪裡走到的最長。測試拿 `scan` 的逐份最長串對過。
 *
 * 輪＝起頭那顆**不是 `resume`** 的 `turn/start`，`resume` 那一段併回去——同 `@nexus/core` 的
 * `currentMessageFeedback` 把回覆歸到輪的算法（格式 10 以前點踩直接綁這個輪，
 * [#267](https://github.com/DemianLi/nexus-agent/issues/267)）。
 * `session/end-seed` 收掉當下那一輪：之後、下一顆起頭之前的事件沒有輪可歸，略過。
 *
 * ## 排序
 *
 * 先比命中幾種，多的在前；同數時照 點踩 > 取消 > 失敗 > 打轉 逐位比（#280 拍板）。
 *
 * ## 不起草的
 *
 * - **子代理那幾份**（header 有 `parentSession`）：沒有 `turn/start`，也就沒有「使用者那句話」。
 *   它的打轉照樣在 `scan` 裡看得到，root 那一輪也看得到它那顆 `task`。
 * - **`/feedback`**：沒綁輪，不參與排序，印在該會話第一份草稿的前面；會話裡一輪都沒入選的另列最後。
 *
 * 舊版格式沒記的信號照 `scan` 的規矩講明：沒入選不代表沒發生。
 *
 * @module
 */

import {
  repeatCallKey,
  repeatReminderTracks,
  resolveRepeatReminderSettings,
  SESSION_LOG_FORMAT_VERSION,
} from '@nexus/core';
import type { RepeatReminderSettings, SessionEventMap } from '@nexus/core';
import {
  CANCEL_SINCE,
  displayPath,
  FEEDBACK_SINCE,
  loopingThreshold,
  parseArguments,
  preview,
  ratingsByTurn,
  TOOL_EVENTS_SINCE,
  UNCODED_ERROR,
} from './session-scan.js';
import type { LoadedSessionLog, RepeatRun, UnreadableSessionLog } from './session-scan.js';

/** 讓一輪入選的信號。 */
export type DraftSignal = 'negative' | 'aborted' | 'failed' | 'looping';

/** 排序的位次，也是印出來的順序。 */
export const DRAFT_SIGNALS: readonly DraftSignal[] = ['negative', 'aborted', 'failed', 'looping'];

const SIGNAL_LABEL: Readonly<Record<DraftSignal, string>> = {
  negative: '點踩',
  aborted: '取消',
  failed: '失敗',
  looping: '打轉',
};

/** 各信號從哪一版格式開始記。`turn/failed` 一開始就在。 */
const RECORDED_SINCE: Readonly<Record<DraftSignal, number>> = {
  negative: FEEDBACK_SINCE,
  aborted: CANCEL_SINCE,
  failed: 1,
  looping: TOOL_EVENTS_SINCE,
};

type Rating = SessionEventMap['feedback/message-put']['item'];
type FeedbackRecord = SessionEventMap['feedback/record'];

/** 一輪裡的一次工具呼叫，同一個 `callId` 只算一次。 */
export interface DraftToolCall {
  readonly name: string;
  /** 日誌上的 `arguments`，原樣。 */
  readonly arguments: string;
  /** 落定的結果；沒有這一格是沒落定（停在核准點沒回，或日誌在那之前就斷了）。 */
  readonly result?: { readonly isError: boolean; readonly code?: string };
}

/** 一輪。**每一輪都在**，`signals` 空的就是沒入選。 */
export interface DraftTurn {
  /** 起頭那顆 `turn/start` 的 `seq`。點踩綁的是這一輪裡的回覆（格式 10 以前綁的是它）。 */
  readonly seq: number;
  /** 這份日誌裡的第幾輪，從 1 起算，給人看的。 */
  readonly ordinal: number;
  /** `goal` 是續行輪次：`text` 是機器排的，不是人說的話。 */
  readonly kind: 'message' | 'goal';
  readonly text: string;
  readonly toolCalls: readonly DraftToolCall[];
  /** 這一輪裡最長的那一段同工具同參數；一次受追蹤的呼叫都沒有時是 `null`。 */
  readonly longestRun: RepeatRun | null;
  /** `turn/failed` 的訊息，照順序。 */
  readonly failures: readonly string[];
  /** 這一輪的評分（一輪有幾則被評時點踩優先，見 `ratingsByTurn`）；被收回的就沒有。 */
  readonly rating?: Rating;
  /** 命中的信號，照 {@link DRAFT_SIGNALS} 的順序。 */
  readonly signals: readonly DraftSignal[];
}

/** 一份日誌起草出來的東西。 */
export interface SessionDrafts {
  readonly file: string;
  readonly sessionId: string;
  readonly parentSession?: string;
  readonly version: number;
  readonly turns: readonly DraftTurn[];
  readonly feedbackRecords: readonly FeedbackRecord[];
  /** 這一版格式沒記的信號：它們不會讓這份的輪入選，不代表沒發生。 */
  readonly unrecorded: readonly DraftSignal[];
}

interface OpenTurn {
  readonly seq: number;
  readonly kind: 'message' | 'goal';
  readonly text: string;
  readonly calls: Map<
    string,
    { name: string; arguments: string; result?: DraftToolCall['result'] }
  >;
  aborted: boolean;
  readonly failures: string[];
  chain: (RepeatRun & { readonly key: string }) | undefined;
  longest: RepeatRun | null;
}

/**
 * 起草一份。
 *
 * @param log - 讀進來的那一份。
 * @param override - 提醒器設定要蓋上去的格子，省略即產品路徑上的預設。
 * @returns 每一輪與它命中的信號。
 * @throws 設定不合法，或只有一道門檻。
 */
export function draftSessionLog(
  log: LoadedSessionLog,
  override?: Partial<RepeatReminderSettings>,
): SessionDrafts {
  const settings = resolveRepeatReminderSettings(override);
  const threshold = loopingThreshold(settings);
  const tracks = repeatReminderTracks(settings);

  const turns: OpenTurn[] = [];
  let current: OpenTurn | undefined;
  // callId → 它落在哪一輪。結果可能在 resume 之後才到，要回到呼叫那一輪。
  const callTurn = new Map<string, OpenTurn>();
  const ratings = ratingsByTurn(log.events);
  const feedbackRecords: FeedbackRecord[] = [];

  for (const event of log.events) {
    switch (event.type) {
      case 'turn/start':
        if (event.data.kind === 'resume') break;
        current = {
          seq: event.seq,
          kind: event.data.kind,
          text: event.data.text,
          calls: new Map(),
          aborted: false,
          failures: [],
          chain: undefined,
          longest: null,
        };
        turns.push(current);
        break;
      case 'session/end-seed':
        current = undefined;
        break;
      case 'turn/end':
        if (current !== undefined && event.data.reason?.kind === 'aborted') current.aborted = true;
        break;
      case 'turn/failed':
        current?.failures.push(event.data.message);
        break;
      case 'tool/call': {
        const { callId, name } = event.data;
        if (current === undefined || callTurn.has(callId)) break;
        callTurn.set(callId, current);
        current.calls.set(callId, { name, arguments: event.data.arguments });
        if (!tracks(name)) break;
        const key = repeatCallKey(name, parseArguments(event.data.arguments));
        const count = current.chain?.key === key ? current.chain.count + 1 : 1;
        current.chain = { key, tool: name, count, arguments: event.data.arguments };
        if (current.longest === null || count > current.longest.count) {
          current.longest = { tool: name, count, arguments: event.data.arguments };
        }
        break;
      }
      case 'tool/result': {
        const { callId, isError } = event.data;
        const call = callTurn.get(callId)?.calls.get(callId);
        if (call === undefined) break;
        const code = event.data.error?.code;
        call.result = { isError, ...(code !== undefined && { code }) };
        break;
      }
      case 'feedback/record':
        feedbackRecords.push(event.data);
        break;
      default:
        break;
    }
  }

  const { version } = log.header;
  return {
    file: log.file,
    sessionId: log.header.id,
    ...(log.header.parentSession !== undefined && { parentSession: log.header.parentSession }),
    version,
    turns: turns.map((turn, index) => {
      const rating = ratings.get(turn.seq);
      const hit: Readonly<Record<DraftSignal, boolean>> = {
        negative: rating?.rating === 'negative',
        aborted: turn.aborted,
        failed: turn.failures.length > 0,
        looping: turn.longest !== null && turn.longest.count >= threshold,
      };
      return {
        seq: turn.seq,
        ordinal: index + 1,
        kind: turn.kind,
        text: turn.text,
        toolCalls: [...turn.calls.values()],
        longestRun: turn.longest,
        failures: turn.failures,
        ...(rating !== undefined && { rating }),
        signals: DRAFT_SIGNALS.filter((signal) => hit[signal]),
      };
    }),
    feedbackRecords,
    unrecorded: DRAFT_SIGNALS.filter((signal) => version < RECORDED_SINCE[signal]),
  };
}

/** 一塊候選：哪一份的哪一輪。 */
export interface RankedDraft {
  readonly session: SessionDrafts;
  readonly turn: DraftTurn;
}

/**
 * 把入選的輪排好。見檔頭「排序」。同樣命中時照路徑、再照輪，排出來是穩定的。
 *
 * @param sessions - 每一份起草的結果。**子代理那幾份照樣收**，它們沒有輪，自然不出現。
 * @returns 命中至少一種信號的輪，排好。
 */
export function rankDrafts(sessions: readonly SessionDrafts[]): RankedDraft[] {
  const ranked = sessions.flatMap((session) =>
    session.turns.filter((turn) => turn.signals.length > 0).map((turn) => ({ session, turn })),
  );
  return ranked.sort((a, b) => {
    const bySize = b.turn.signals.length - a.turn.signals.length;
    if (bySize !== 0) return bySize;
    for (const signal of DRAFT_SIGNALS) {
      const bySignal =
        Number(b.turn.signals.includes(signal)) - Number(a.turn.signals.includes(signal));
      if (bySignal !== 0) return bySignal;
    }
    return a.session.file.localeCompare(b.session.file) || a.turn.seq - b.turn.seq;
  });
}

/** 註解裡的一行不能真的換行，不然下半截就不是註解了。 */
function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n|\u2028|\u2029/g, ' ⏎ ');
}

function labels(signals: readonly DraftSignal[], separator: string): string {
  return signals.map((signal) => SIGNAL_LABEL[signal]).join(separator);
}

/** `dataset.ts` 的 id 慣例是 kebab-case，這裡只保證合法，名字要人改。 */
function draftId(session: SessionDrafts, turn: DraftTurn): string {
  return `draft-${session.sessionId}-${turn.seq}`.replace(/[^A-Za-z0-9-]+/g, '-');
}

function feedbackLine(record: FeedbackRecord): string {
  const category = record.category === undefined ? '' : `〔${record.category}〕`;
  return `// /feedback：${category}${record.text === undefined ? '（沒寫內容）' : oneLine(record.text)}`;
}

function sessionHeader(session: SessionDrafts, shown: (file: string) => string): string[] {
  return [
    `// ── 會話 ${session.sessionId}  ${shown(session.file)}`,
    ...session.feedbackRecords.map(feedbackLine),
  ];
}

function callMark(call: DraftToolCall): string {
  if (call.result === undefined) return ' …未落定';
  return call.result.isError ? ` ✗ ${call.result.code ?? UNCODED_ERROR}` : '';
}

/** 實際呼叫照順序列，連續同一顆（同名、同參數、同結果）摺成 `× n`——打轉那一輪才讀得完。 */
function callLines(calls: readonly DraftToolCall[]): string[] {
  const rows: { text: string; count: number }[] = [];
  for (const call of calls) {
    const text = `${call.name} ${oneLine(preview(call.arguments))}${callMark(call)}`;
    const last = rows.at(-1);
    if (last?.text === text) last.count += 1;
    else rows.push({ text, count: 1 });
  }
  if (rows.length === 0) return ['//   （這一輪沒有工具呼叫）'];
  return rows.map(
    (row, index) => `//   ${index + 1}. ${row.text}${row.count > 1 ? ` × ${row.count}` : ''}`,
  );
}

function draftBlock(session: SessionDrafts, turn: DraftTurn): string[] {
  const { rating, longestRun } = turn;
  const lines = [`// [${labels(turn.signals, '＋')}] 第 ${turn.ordinal} 輪（seq ${turn.seq}）`];
  if (turn.kind === 'goal') {
    lines.push('// goal 續行輪次：prompt 是機器排的，不是人說的話。');
  }
  if (turn.signals.includes('negative') && rating !== undefined) {
    const category = rating.category === undefined ? '' : `〔${rating.category}〕`;
    lines.push(
      `// 點踩${category}：${rating.note === undefined ? '（沒寫備註）' : oneLine(rating.note)}`,
    );
  }
  if (turn.signals.includes('aborted')) lines.push('// 取消：這一輪被人中止。');
  for (const failure of turn.failures) lines.push(`// 失敗：${oneLine(failure.trim())}`);
  if (turn.signals.includes('looping') && longestRun !== null) {
    lines.push(
      `// 打轉：${longestRun.tool} × ${longestRun.count} ${oneLine(preview(longestRun.arguments))}`,
    );
  }
  lines.push(
    '// 實際呼叫（參考，不是答案）：',
    ...callLines(turn.toolCalls),
    '{',
    `  id: '${draftId(session, turn)}', // 改成說得出這題在考什麼的名字`,
    `  prompt: ${JSON.stringify(turn.text)},`,
    '  expected: {',
    '    toolCalls: [], // TODO：人填正確的呼叫序列，見 dataset.ts 的「加題目的規矩」',
    '    // mentions: [],',
    '  },',
    '},',
  );
  return lines;
}

/**
 * 印成草稿。**整份貼進一個陣列是合法的程式碼**：除了草稿本身，每一行都是 `//` 註解。
 *
 * @param sessions - 每一份起草的結果，子代理那幾份也收（只拿來報份數）。
 * @param unreadable - 讀不懂的那幾份。
 * @param options - `threshold` 印在說明裡；`base` 同 `formatScanReport`。
 * @returns 整份輸出，一行一個元素。
 */
export function formatDraftReport(
  sessions: readonly SessionDrafts[],
  unreadable: readonly UnreadableSessionLog[],
  options: { readonly threshold: number; readonly base?: string },
): readonly string[] {
  const shown = (file: string): string => displayPath(file, options.base);
  const roots = sessions.filter((session) => session.parentSession === undefined);
  const ranked = rankDrafts(roots);

  const lines: string[] = [
    `// 起草：${sessions.length} 份日誌（子代理 ${sessions.length - roots.length} 份不起草），` +
      `候選 ${ranked.length} 輪。`,
    `// 排序：命中幾種多的在前；同數時 ${labels(DRAFT_SIGNALS, ' > ')}。` +
      `打轉＝一輪裡同工具同參數連續 ${options.threshold} 次（提醒器的第二道門檻）。`,
    '// 人補上 expected 之後，手抄進 src/eval/dataset.ts 的 BENCHMARK 尾端——往後面加，不要插在中間。',
  ];
  if (ranked.length === 0) lines.push('', '// 沒有命中任何信號的輪。');

  const introduced = new Set<SessionDrafts>();
  for (const { session, turn } of ranked) {
    lines.push('');
    if (!introduced.has(session)) {
      introduced.add(session);
      lines.push(...sessionHeader(session, shown), '//');
    }
    lines.push(...draftBlock(session, turn));
  }

  const quiet = roots.filter(
    (session) => !introduced.has(session) && session.feedbackRecords.length > 0,
  );
  if (quiet.length > 0) {
    lines.push('', '// ── 有 /feedback、但沒有候選輪的會話');
    for (const session of quiet) lines.push(...sessionHeader(session, shown));
  }

  const old = roots.filter((session) => session.unrecorded.length > 0);
  if (old.length > 0) {
    lines.push('', '// 舊版格式：底下這幾份沒記某些信號，那幾種不會讓它們的輪入選，不是沒發生。');
    for (const session of old) {
      lines.push(
        `//   ${session.sessionId}（格式版本 ${session.version}）：沒記 ${labels(session.unrecorded, '、')}`,
      );
    }
  }
  for (const session of roots) {
    if (session.version > SESSION_LOG_FORMAT_VERSION) {
      lines.push(
        `// ${session.sessionId} 的格式版本 ${session.version} 比這一版（${SESSION_LOG_FORMAT_VERSION}）` +
          '新：認不得的事件略過了，候選可能不全。',
      );
    }
  }
  if (unreadable.length > 0) {
    lines.push('', `// 讀不懂的 ${unreadable.length} 份（其餘照起草）：`);
    for (const entry of unreadable)
      lines.push(`//   ${shown(entry.file)}：${oneLine(entry.reason)}`);
  }
  return lines;
}
