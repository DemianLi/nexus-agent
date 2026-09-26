/**
 * 會話標題的退回規則：第一則人打的字截出來的那個（[#647](https://github.com/DemianLi/nexus-agent/issues/647)，
 * 規則本身來自 [#302](https://github.com/DemianLi/nexus-agent/issues/302)）。
 *
 * 照 dsh `session-title` 的 `ensureFallback`（`packages/session/session-title/src/index.ts`，`477b4f4`）：第一則合格的
 * 人話進來之後，這條會話還沒有標題的話，從**第一則**合格的人話推一個，記成一顆只進日誌的 `session/title`
 * （`source: fallback`）。讀的人拿最後一顆（dsh 的 `title` 投影，latest-wins）。
 *
 * ## 規則
 *
 * 照 dsh 的 `fallbackSessionTitle`（`normalize.ts`）：去掉控制字元與方向控制字元、空白收成一格，取前 `maxWords` 個詞、
 * 再截到 `maxBytes` 個 UTF-8 位元組。**方向控制字元那一條不是裝飾**：標題是使用者的原文，畫在瀏覽器上，dsh 明說
 * 它們會讓顯示出來的標題騙人。**詞數對中文不起作用**（沒有空白，一整句就是一個詞），真正咬得住的是位元組上限。
 *
 * 人打的字＝`turn/start` 的 `kind: 'message'`；`goal` 那一種是機器排的，對到 dsh 那一側 `source.kind` 不是 `user` 的
 * `user/message`，不算。清完是空的那則也不算，同 dsh 的 `sessionTitleUserMessageOf`：第一則**合格的**才是第一則。
 *
 * **兩個上限都是必填參數，沒有預設值**——照 dsh「所有上限都是必填項」。值由清單上 `#settings/thread-title` 那一列講
 * （[#531](https://github.com/DemianLi/nexus-agent/pull/531)），兩個入口在起動期解一次、往下傳進來。
 *
 * ## 誰寫、什麼時候寫
 *
 * web 的 pump 與 CLI 的 `runTurn`，**在自己寫下 `turn/start {kind:'message'}` 的那一段裡接著寫**
 * （{@link ensureFallbackTitle}）。pump 那條是「領走開跑」的那一刻，不是送出的那一刻：送出佇列（#637）之後這兩個時刻
 * 分開了，而 dsh 的 `user/message` 也是開跑時才落。
 *
 * **寫不進去只講一聲，那一輪照跑**，同 dsh `onUserMessage` 的 catch。叫的人各自包一層：寫在那一輪自己的 try 裡面，
 * 拋出來的東西就算漏接也不會留下一顆沒有結尾的 `turn/start`。
 *
 * **對 dsh 的偏離：同步寫，不延到微任務。** dsh 的 `onUserMessage` 跑在 `session/event` 的訂閱者裡，那裡不能重入寫日誌，
 * 所以 `defer` 到下一個微任務、再重查一次「還活著、還沒有標題」。我們寫的位置不是訂閱者，是寫 `turn/start` 的那一段
 * 程式自己，沒有那個成因；同步寫也就不需要 dsh 那一層「延後期間被別人搶先」的重查。
 *
 * ## 18 以前的日誌
 *
 * 一顆 `session/title` 都沒有。讀的人（列表、歷史）照同一條規則當場推（{@link threadTitleOf}），寫的人在下一則人話開跑
 * 時補寫——那時推的仍然是**整份日誌裡第一則**合格的人話，所以兩邊一字不差。**這是偏離**：dsh 的 `session/title` 從
 * v0 就有，沒有「日誌裡沒有標題事件」這種狀態。
 *
 * @module
 */

import type { SessionEvent, SessionLog } from '@nexus/core';

/** 標題的兩個上限。見檔頭「規則」。 */
export interface ThreadTitleLimits {
  /** 取前幾個以空白分開的詞。 */
  readonly maxWords: number;
  /** UTF-8 位元組上限，不會切在一個字的中間。 */
  readonly maxBytes: number;
}

/* eslint-disable no-control-regex -- 以下五條要擋的正是控制字元 */
/** Operating-system-command 跳脫序列，含沒收尾的。以下五條逐字抄 dsh `normalize.ts`。 */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu;
/** CSI 跳脫序列，例如 SGR 顏色碼。 */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
/** 其餘兩位元組的 ESC 序列。 */
const ESC_SEQUENCE = /\u001B[@-_]/gu;
/** 空白以外的 C0／C1 控制字元。 */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
/** 會讓顯示出來的標題騙人的方向控制與不可見字元。 */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;
/* eslint-enable no-control-regex */

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 要是正整數，收到 ${String(value)}`);
  }
}

/**
 * 兩個上限都是正整數，否則拋。**寫的人在起動期就叫它**：到了寫標題的那一刻已經在一輪裡面，那時才發現設定是壞的，
 * 只剩一行 warn，而且每一輪都一樣、標題永遠寫不出來。
 *
 * @throws 任一個不是正整數。
 */
export function assertThreadTitleLimits(limits: ThreadTitleLimits): void {
  assertPositiveInteger('maxWords', limits.maxWords);
  assertPositiveInteger('maxBytes', limits.maxBytes);
}

function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function truncateUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let used = 0;
  let output = '';
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

/**
 * 一則人打的字變成標題。同 dsh 的 `fallbackSessionTitle`。
 *
 * @returns 標題；清完或截完是空的就是空字串。
 * @throws 上限不是正整數。
 */
export function fallbackThreadTitle(input: string, limits: ThreadTitleLimits): string {
  assertThreadTitleLimits(limits);
  const words = cleanTitleText(input).split(' ').filter(Boolean).slice(0, limits.maxWords);
  return truncateUtf8(words.join(' '), limits.maxBytes).trimEnd();
}

/**
 * 任何來源的標題正規化：清掉控制字元、空白收成一格、截到 `maxBytes` 個 UTF-8 位元組。同 dsh 的
 * `normalizeSessionTitle`。跟 {@link fallbackThreadTitle} 差在沒有詞數上限——模型產生的標題（#650）走這一支。
 *
 * @returns 標題；清完或截完是空的就是空字串。
 * @throws `maxBytes` 不是正整數。
 */
export function normalizeThreadTitle(input: string, maxBytes: number): string {
  assertPositiveInteger('maxBytes', maxBytes);
  return truncateUtf8(cleanTitleText(input), maxBytes).trimEnd();
}

/** 第一則合格的人話推出來的標題，與那一顆 `turn/start` 的 `seq`。一則都沒有是 `undefined`。 */
function firstFallback(
  events: readonly SessionEvent[],
  limits: ThreadTitleLimits,
): { readonly title: string; readonly seq: number } | undefined {
  for (const event of events) {
    if (event.type !== 'turn/start' || event.data.kind !== 'message') continue;
    const title = fallbackThreadTitle(event.data.text, limits);
    if (title !== '') return { title, seq: event.seq };
  }
  return undefined;
}

/**
 * 這份日誌現在的標題：最後一顆 `session/title` 的；一顆都沒有（18 以前的日誌，或還沒寫）就照規則當場推。
 *
 * @param events - root 那一份，從頭開始（或它的開頭一段）。
 * @returns 標題；沒有合格的人話是 `undefined`。
 */
export function threadTitleOf(
  events: readonly SessionEvent[],
  limits: ThreadTitleLimits,
): string | undefined {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at]!;
    if (event.type === 'session/title') return event.data.title;
  }
  return firstFallback(events, limits)?.title;
}

/**
 * 這條會話還沒有標題的話，從整份日誌裡第一則合格的人話推一個，寫進去。已經有了、或還沒有合格的人話，就不寫。
 *
 * 叫的人在剛寫下一顆 `turn/start {kind:'message'}` 之後叫，見檔頭「誰寫、什麼時候寫」。
 *
 * @param log - root 那一份。
 * @throws 上限不是正整數——叫的人應該已經在起動期驗過（{@link assertThreadTitleLimits}）。
 */
export function ensureFallbackTitle(log: SessionLog, limits: ThreadTitleLimits): void {
  if (log.events.some((event) => event.type === 'session/title')) return;
  const first = firstFallback(log.events, limits);
  if (first === undefined) return;
  log.append('session/title', {
    title: first.title,
    messageSeqs: [first.seq],
    source: { kind: 'fallback' },
  });
}
