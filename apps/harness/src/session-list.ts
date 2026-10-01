/**
 * 列出這台 serve 以前的 thread——[#302](https://github.com/DemianLi/nexus-agent/issues/302)。
 *
 * 照 dsh 的 `ApiSessionList.list()`（`packages/api/session-controller/src/list.ts`，SHA `c291e79`）：
 * **不啟動任何 agent**，讀持久化的會話，跳過 `header.cwd` 沒記的，照 `updatedAt` 由新到舊排。
 * `updatedAt = max(header.createdAt, 最後一則人類提示的時間)`，`blank` 是「還沒有任何 `turn/start`」
 * （`applySessionListMetadata`）。`running` 不在這裡：它來自活著的 agent，歸 `wire-handler.ts`。
 *
 * ## 唯讀，經過 `SessionStore`
 *
 * 列走 `list`、讀本文走 `open(id, 'read')`，同 dsh 的列表走 `persistence.list`、冷讀走 `open(sessionId, 'read')`
 * （[#665](https://github.com/DemianLi/nexus-agent/issues/665)）。**不拿寫租約、不截撕裂的尾巴、不動 header**：別的行程
 * 握著的那一條也要列得出來，而且列一次不能改到任何一個位元組。檔名與 header 的規則只在後端
 * （`jsonl-session-store.ts`），這裡一個都不認。
 *
 * **本文整份讀、整份解析**，不再逐行篩：dsh 的冷列讀投影快取，我們沒有那一層（[#725](https://github.com/DemianLi/nexus-agent/issues/725)），
 * 讀的是日誌本身。#665 量過整份解析不比逐行篩慢（見 PR），換到的是標題規則只剩一份（{@link threadTitleOf}）。
 *
 * ## 列出來的每一列都要切得過去
 *
 * 切換走的是 serve 的續接路徑，所以會在那裡被擋的，這裡就不列（{@link isListedThread}）：
 *
 * - **header 帶 `parentSession` 的不列**：subagent 的 id 是 `<thread>/<task>`，不是一條 thread。dsh 會列、
 *   標 `origin: 'subagent'`；我們切不進去（#302 拍板的第 3 件）。
 * - **`header.cwd` 不等於這一次的 `cwd` 就不列**，沒記的也不列。**不是按目錄判**：`projectKey` 是有損的，
 *   兩個目錄可能落在同一格，header 的 `cwd` 才是唯一分得開的東西（`resume-guards.ts` 的 `assertSameCwd`，
 *   續接時一樣比它）。dsh 只擋沒記的，因為它的列表跨專案。
 * - **header 讀不懂、版本比這一版新的不列，但數出來**（`unreadable`，後端的 `list` 數的）。續接會拒絕這兩種；
 *   不數的話，畫面上「少了一條」跟「本來就沒有」分不出來。
 *
 * **日誌本文壞在中間不在這裡擋**：讀的時候開撿回模式（`salvage`），讀得懂的照算。那一列照樣列出來，點下去由續接
 * 那條路講出原因（`wire-handler.ts` 的 `threadOrError`）。
 *
 * ## 標題
 *
 * {@link threadTitleOf}：最後一顆 `session/title`（[#647](https://github.com/DemianLi/nexus-agent/issues/647)），同 dsh 列表讀的
 * `title` 投影（latest-wins）；一顆都沒有才照規則推。規則與偏離見 `session-title.ts`。
 *
 * @module
 */

import {
  SessionCorruptionError,
  SessionFormatUnsupportedError,
  SessionNotFoundError,
} from '@nexus/core';
import type {
  SessionEvent,
  SessionStore,
  StoredSessionHeader,
  StoredSessionSnapshot,
} from '@nexus/core';
import type { ThreadSummary } from '@nexus/wire';

import { assertThreadTitleLimits, threadTitleOf } from './session-title.js';
import type { ThreadTitleLimits } from './session-title.js';

/** 從磁碟讀得出來的那一列：線上那一列少掉 `running`（它來自活著的 agent）。 */
export type StoredThreadSummary = Omit<ThreadSummary, 'running'>;

export interface StoredThreadList {
  /** 由新到舊；`updatedAt` 一樣時照 id。 */
  readonly items: readonly StoredThreadSummary[];
  /** header 讀不懂或版本比這一版新而沒列的份數。 */
  readonly unreadable: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 一份列得出來嗎：root、`cwd` 對得上。判準見檔頭的「列出來的每一列都要切得過去」。
 *
 * 列表與內容搜尋（`thread-search.ts`，[#631](https://github.com/DemianLi/nexus-agent/issues/631)）共用這一支：
 * **搜得到的一定列得出來**，同 dsh 的搜尋先拿列表的可見集合過濾（`packages/api/session-controller/src/list.ts:179-183`）。
 */
export function isListedThread(header: StoredSessionHeader, cwd: string): boolean {
  return header.parentSession === undefined && header.cwd === cwd;
}

/**
 * `store` 裡**列得出來**的那幾份（{@link isListedThread}），照 `list` 的順序，與沒列的份數。
 *
 * @param store - serve 的那一個（`<會話根>/<projectKey(cwd)>` 那一格）。
 * @param cwd - 這台 server 的工作目錄。
 * @throws 存放處存在但讀不到；`signal` 中止時拋它的 `reason`。
 */
export async function listVisibleThreads(
  store: SessionStore,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ readonly items: readonly StoredSessionSnapshot[]; readonly unreadable: number }> {
  const { sessions, unreadable } = await store.list(signal === undefined ? {} : { signal });
  return { items: sessions.filter(({ header }) => isListedThread(header, cwd)), unreadable };
}

/**
 * 形狀對得上列表要的那幾格的事件。**`read` 只驗 `type`、`seq`、`time`**，`data` 長怎樣沒人擋，而一份壞掉的日誌
 * 撿回來的更是什麼都有：{@link threadTitleOf} 直接讀 `data`，形狀不對的在這裡先濾掉，同以前逐行篩時的判斷。
 */
function listable(event: SessionEvent): boolean {
  const data: unknown = event.data;
  if (!isRecord(data)) return false;
  if (event.type === 'session/title') return typeof data['title'] === 'string';
  if (event.type === 'turn/start')
    return data['kind'] !== 'message' || typeof data['text'] === 'string';
  return true;
}

/** 一份日誌裡列表要的東西。 */
export interface PromptScan {
  readonly blank: boolean;
  readonly title?: string;
  readonly lastPromptAt?: number;
}

export function scanPrompts(
  events: readonly SessionEvent[],
  limits: ThreadTitleLimits,
): PromptScan {
  // `blank` 看的是有沒有任何一顆 `turn/start`，形狀對不對都算；其餘只看形狀對的。
  const blank = !events.some((event) => event.type === 'turn/start');
  const usable = events.filter(listable);
  let lastPromptAt: number | undefined;
  for (const event of usable) {
    if (event.type === 'turn/start' && event.data.kind === 'message') lastPromptAt = event.time;
  }
  const title = threadTitleOf(usable, limits);
  return {
    blank,
    ...(title !== undefined && { title }),
    ...(lastPromptAt !== undefined && { lastPromptAt }),
  };
}

/**
 * 讀一個背景子代理自己落盤的日誌（[#871](https://github.com/DemianLi/nexus-agent/issues/871)）：唯讀冷讀，`<thread>/<runId>`。
 * 經 `open(id, 'read')`，同列表，不拿租約、不動檔。
 *
 * **header 的 `parentSession` 必須是這條 thread**：id 是照 thread 組出來的所以本來就在它底下，這一道是萬一檔案被手動改名搬走時的
 * 第二層。沒有這一份、或不屬於這條 thread：`undefined`。其他失敗（壞檔、版本太新）照拋，由呼叫端決定怎麼講。
 */
export async function readStoredSubagentSession(
  store: SessionStore,
  threadId: string,
  runId: string,
): Promise<readonly SessionEvent[] | undefined> {
  try {
    const stored = await store.open(`${threadId}/${runId}`, 'read');
    if (stored.header.parentSession !== threadId) return undefined;
    return await stored.read();
  } catch (error: unknown) {
    if (error instanceof SessionNotFoundError) return undefined;
    throw error;
  }
}

/**
 * 列出 `store` 裡屬於 `cwd` 的 root thread。
 *
 * **列與讀之間那一份變了**（別的行程刪掉、或以更新的版本續接過）：刪掉的不列，header 讀不懂了的算進 `unreadable`。
 *
 * @param store - serve 的那一個（`<會話根>/<projectKey(cwd)>` 那一格）。
 * @param options - `cwd` 是這台 server 的工作目錄；`title` 的兩個上限必填。
 * @returns 由新到舊的列，與沒列的份數。
 * @throws 上限不是正整數；存放處存在但讀不到。
 */
export async function listStoredThreads(
  store: SessionStore,
  options: { readonly cwd: string; readonly title: ThreadTitleLimits },
): Promise<StoredThreadList> {
  // 先驗，不等到第一則人打的字：一份空的存放處不該讓錯的設定看起來是對的。
  assertThreadTitleLimits(options.title);
  const visible = await listVisibleThreads(store, options.cwd);
  const items: StoredThreadSummary[] = [];
  let { unreadable } = visible;
  for (const { header } of visible.items) {
    let events: readonly SessionEvent[];
    try {
      events = await (await store.open(header.id, 'read')).read({ salvage: true });
    } catch (error: unknown) {
      if (error instanceof SessionNotFoundError) continue;
      if (
        error instanceof SessionCorruptionError ||
        error instanceof SessionFormatUnsupportedError
      ) {
        unreadable += 1;
        continue;
      }
      throw error;
    }
    const scan = scanPrompts(events, options.title);
    items.push({
      threadId: header.id,
      updatedAt: Math.max(header.createdAt, scan.lastPromptAt ?? 0),
      blank: scan.blank,
      ...(scan.title !== undefined && { title: scan.title }),
    });
  }
  items.sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      (left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0),
  );
  return { items, unreadable };
}
