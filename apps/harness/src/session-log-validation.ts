/**
 * 會話日誌的形狀驗證，照 dsh `session-format-v3-to-v4/src/validation.ts`（`687f282e`）。
 *
 * 獨立成一個模組、不逐行插進讀檔的迴圈裡（[#1549](https://github.com/DemianLi/nexus-agent/issues/1549) 做法 1）：
 * 建立（[#1559](https://github.com/DemianLi/nexus-agent/issues/1559) N0622）與讀盤（#1549）共用同一支 header 驗證，
 * 兩邊才不會各說各話。事件之間的關係（{@link assertStoredRelationships}）也在這裡，讀完已接受的前綴之後跑。
 * 事件信封與單筆資料規則不在這裡：信封是 core 的 `assertSessionEventEnvelope`，seed 與讀盤逐行判壞行
 * （`jsonl-session-store.ts` 的 `parseJsonlSessionBody`）共用；資料規則是 core 的 `validateSessionEventData`，寫入、seed、
 * 讀盤三處共用。
 *
 * header 驗證拋的是 `TypeError`，訊息說哪一格：建立那一側原樣交給呼叫方（同 dsh `materializeCreateHeader` 拋 `TypeError`），
 * 讀盤那一側由讀方換成 `SessionCorruptionError`。
 */

import { isAbsolute } from 'node:path';

import { SessionCorruptionError, validateSessionEventData } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';

/**
 * 這一版寫得出來的 header 鍵（`@nexus/core` 的 `StoredSessionHeader`），照 dsh 的精確鍵白名單
 * （`validation.ts:19-42` 的 `required` 與 `allowed`）。
 */
const REQUIRED_HEADER_KEYS = ['version', 'id', 'createdAt'] as const;
const ALLOWED_HEADER_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_HEADER_KEYS,
  'cwd',
  'workspaceRoot',
  'parentSession',
  'build',
  'plugins',
  'configHash',
  'modelEntryId',
  'origin',
  'isSeeded',
]);
/** 有的話要是字串的那幾格。 */
const OPTIONAL_STRING_KEYS = [
  'workspaceRoot',
  'parentSession',
  'configHash',
  'modelEntryId',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非負的安全整數，同 dsh 的 `sessionFormatCount`。 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * header 各格的形狀，照 dsh 的 `assertReleasedV4Header`（`validation.ts:19-42`）：缺必填的、多出這一版不寫的鍵、
 * 某一格型別不對，都拒。**版本是哪一版不在這裡判**：建立時要等於這一版（同 dsh 的 `encodeCurrentHeader`），讀盤時
 * 由版本邊目錄判，兩邊規則不同。讀盤那一側對到 dsh 讀 header 時的精確鍵與型別檢查（`session-format-v1-to-v2/src/codec.ts:40-75`）。
 *
 * **白名單讀盤也能用同一份**（#1549）：它是任何一版寫過的鍵的聯集。`StoredSessionHeader` 從第一版起只加不減，50 以前是
 * 10 個鍵（#1549 對 `session-store.ts` 的歷次 commit 逐版核過），51 加了 `origin`、`isSeeded`（#1579；升版的理由正是 50 的這份白名單
 * 會把它們判成壞檔）。之後加鍵要升版或過同版相容審查，比這一版新的檔在版本那一格就被擋下
 * （讀方開了 `acceptNewer` 讀比這一版新的，整支不跑，見 `parseHeader`）。
 *
 * `origin` 只准 `'subagent'`，同 dsh。`isSeeded` 只准 `true`：dsh 是必填的 boolean，我們只在 true 時寫（`StoredSessionHeader.isSeeded`），
 * 落盤的 `false` 不是任何一版寫得出來的。nexus 的 header 沒有 dsh 的 `delegationDepth`、`agentPreset`（#1567 重核判不成立），
 * 多了 `workspaceRoot`、`build`、`plugins`、`configHash`、`modelEntryId`，各照 `StoredSessionHeader` 的宣告驗。
 *
 * @param header - 還沒驗過的 header。
 * @throws `TypeError` 哪一格不對。
 */
export function assertStoredHeaderFields(header: unknown): void {
  if (!isRecord(header)) throw new TypeError('session header 不是一個物件');
  const missing = REQUIRED_HEADER_KEYS.find((key) => !Object.hasOwn(header, key));
  if (missing !== undefined) throw new TypeError(`session header 少了 ${missing}`);
  const unexpected = Object.keys(header).find((key) => !ALLOWED_HEADER_KEYS.has(key));
  if (unexpected !== undefined) {
    throw new TypeError(`session header 有這一版不寫的鍵 ${JSON.stringify(unexpected)}`);
  }
  if (typeof header['id'] !== 'string') throw new TypeError('session header 的 id 要是字串');
  if (!isCount(header['createdAt'])) {
    throw new TypeError('session header 的 createdAt 要是非負的安全整數');
  }
  const { cwd } = header;
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) {
    throw new TypeError('session header 的 cwd 要是絕對路徑');
  }
  for (const key of OPTIONAL_STRING_KEYS) {
    if (header[key] !== undefined && typeof header[key] !== 'string') {
      throw new TypeError(`session header 的 ${key} 要是字串`);
    }
  }
  if (header['origin'] !== undefined && header['origin'] !== 'subagent') {
    throw new TypeError('session header 的 origin 只能是 "subagent"');
  }
  if (header['isSeeded'] !== undefined && header['isSeeded'] !== true) {
    throw new TypeError('session header 的 isSeeded 只能是 true');
  }
  const { build } = header;
  if (build !== undefined) {
    if (
      !isRecord(build) ||
      Object.keys(build).some((key) => key !== 'commit' && key !== 'dirty') ||
      !(build['commit'] === null || typeof build['commit'] === 'string') ||
      !(build['dirty'] === null || typeof build['dirty'] === 'boolean')
    ) {
      throw new TypeError(
        'session header 的 build 要是 {commit: string|null, dirty: boolean|null}',
      );
    }
  }
  const { plugins } = header;
  if (plugins !== undefined) {
    if (!Array.isArray(plugins)) throw new TypeError('session header 的 plugins 要是陣列');
    plugins.forEach((row: unknown, index) => {
      if (
        !isRecord(row) ||
        Object.keys(row).some((key) => key !== 'name' && key !== 'id' && key !== 'disabled') ||
        typeof row['name'] !== 'string' ||
        (row['id'] !== undefined && typeof row['id'] !== 'string') ||
        typeof row['disabled'] !== 'boolean'
      ) {
        throw new TypeError(
          `session header 的 plugins[${index}] 要是 {name: string, id?: string, disabled: boolean}`,
        );
      }
    });
  }
}

/**
 * 分叉前綴與 header 對不對得上，讀完已接受的前綴之後跑一次，回傳切點（[#1579](https://github.com/DemianLi/nexus-agent/issues/1579)）。
 *
 * 照 dsh 讀盤的兩條（`session-format-v3-to-v4/src/validation.ts:52-76`、`session-format-v1-to-v2/src/codec.ts:114-127`，`687f282e`）：
 * 帶 `isSeeded` 的要有 inherited 標記；沒帶的不能有。切點不另外落盤，取最後一顆標記的 `seq`（core 的 `inheritedEventCount`），
 * 所以 dsh 的「切點超過事件數」「seeded 而切點不等於最後一顆標記」在這裡收成同一條「seeded 卻沒有標記」：切點本來就是從標記推出來的。
 *
 * **放在尾端復原之後**（卡面做法 4 要先定）：同 dsh，codec 只數已接受的事件（`codec.ts:104-117`），驗證在 `finish()` 跑。
 * 被丟掉的尾巴不在 `events` 裡，切點取自已接受的前綴，所以不會有「標記位置對不上繼承長度」的誤判；標記本身被當成壞尾巴丟掉時，
 * 這份 seeded 檔就拋損壞，同 dsh（`codec.ts:121-123`）——繼承前綴的切點不能靠猜。
 *
 * @param id - 這份會話的 id，放進錯誤裡。
 * @param header - 已過 {@link assertStoredHeaderFields} 的 header。
 * @param events - 已接受的前綴，依 `seq` 排好。
 * @returns 切點；不是分叉來的是 0。
 * @throws {@link SessionCorruptionError} header 與標記對不上。
 */
export function assertStoredInheritance(
  id: string,
  header: { readonly isSeeded?: true },
  events: readonly SessionEvent[],
): number {
  // 不拿 core 的 `inheritedEventCount`：它沒有標記時回 0，分不出「沒有」與「標記在第 0 顆」。
  let marker: number | undefined;
  for (const event of events) {
    if (event.type === 'session/end-seed' && event.data.inherited === true) marker = event.seq;
  }
  if (header.isSeeded === true && marker === undefined) {
    throw new SessionCorruptionError(
      id,
      'header 標了 isSeeded，日誌裡卻沒有 inherited 的 session/end-seed',
    );
  }
  if (header.isSeeded !== true && marker !== undefined) {
    throw new SessionCorruptionError(
      id,
      `header 沒標 isSeeded，第 ${marker + 1} 行卻是 inherited 的 session/end-seed`,
    );
  }
  return marker ?? 0;
}

/**
 * 讀回來的事件之間的關係，讀完已接受的前綴之後跑一次。照 dsh 的 `assertReleasedV4Relationships`
 * （`session-format-v3-to-v4/src/validation.ts:110-130`；呼叫點是讀檔器收尾的 `finish()`，`session-persistence-jsonl/src/format.ts:468`）。
 *
 * **今天只有一條**（#1549 N0603）：同一個子代理的 `subagent/catalog` 只能登記一次（dsh `:122-127`）。兩個寫入點都在派出的
 * 當下各寫一次、寫不進去就不落盤，重複只可能是寫壞或拼接出錯；讀方（`subagentLinkOf`）只取第一筆，後一筆會被靜靜忽略。
 * turn、tool、模型呼叫、重試的配對由 [#1597](https://github.com/DemianLi/nexus-agent/issues/1597) 加進這一支。
 *
 * `childId` 不是字串（或 `data` 不是物件）也拒，照 dsh 的 `catalogFact`（`session-format-v3-to-v4/src/facts.ts:72-84`）。
 * dsh 那一支還驗 `version`、`mode` 列舉、`label`、`childCreatedAt`，nexus 的 `SubagentCatalogData` 沒有那些格的對應，只驗
 * 這條規則要用到的 `childId`。
 *
 * **只掃切點之後（含）的**，同 dsh（`validation.ts:122`，整段 `catalogFact` 都在 `event.seq >= inheritedEventCount` 底下）：繼承來的前綴
 * 是父會話的登記，分叉之後自己的區段可以再派一個同 id 的子代理，前綴裡那一筆不算重複（[#1579](https://github.com/DemianLi/nexus-agent/issues/1579)
 * 撤掉 #1549 的過渡）。
 *
 * @param id - 這份會話的 id，放進錯誤裡。
 * @param events - 已接受的前綴，依 `seq` 排好。
 * @param cut - 切點，{@link assertStoredInheritance} 回的那個。
 * @throws {@link SessionCorruptionError} 同一個 `childId` 登記了兩次，或某一筆的 `childId` 不是字串，訊息帶第幾行。
 */
export function assertStoredRelationships(
  id: string,
  events: readonly SessionEvent[],
  cut: number,
): void {
  const children = new Set<string>();
  for (const event of events) {
    if (event.type !== 'subagent/catalog' || event.seq < cut) continue;
    const data: unknown = event.data;
    const childId = isRecord(data) ? data['childId'] : undefined;
    if (typeof childId !== 'string') {
      throw new SessionCorruptionError(
        id,
        `第 ${event.seq + 1} 行的 subagent/catalog 沒有字串的 childId`,
      );
    }
    if (children.has(childId)) {
      throw new SessionCorruptionError(
        id,
        `第 ${event.seq + 1} 行的 subagent/catalog 又登記了一次子代理 ${JSON.stringify(childId)}`,
      );
    }
    children.add(childId);
  }
}

/**
 * 讀回來的每一筆跑 core 的單筆資料規則（`validateSessionEventData`），照 dsh 後端讀盤的 `validateStoredEvents`
 * （`session-persistence/src/storage-contract.ts:69-104`，逐筆 `adoptSessionEvent` → `validateSessionEventData`，
 * 不過就包成損壞錯誤；呼叫點 `session-persistence-jsonl/src/index.ts:860`，續接與唯讀打開共用）。
 * 不認得的必需種類在解析本文時已經拒了（`SessionEventUnsupportedError`），這裡不重做。
 *
 * @param id - 這份會話的 id，放進錯誤裡。
 * @param events - 已接受的前綴，依 `seq` 排好。
 * @throws {@link SessionCorruptionError} 某一筆不過，訊息帶第幾行與哪一格。
 */
export function assertStoredEventData(id: string, events: readonly SessionEvent[]): void {
  for (const event of events) {
    try {
      validateSessionEventData(event, `第 ${event.seq + 1} 行的 ${event.type}`);
    } catch (error: unknown) {
      throw new SessionCorruptionError(id, error instanceof Error ? error.message : String(error));
    }
  }
}
