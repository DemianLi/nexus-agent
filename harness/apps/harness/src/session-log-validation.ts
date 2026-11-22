/**
 * 會話日誌的形狀驗證。
 *
 * 獨立成一個模組、不逐行插進讀檔的迴圈裡（[#1549](https://github.com/DemianLi/nexus-agent/issues/1549) 做法 1）：
 * 建立（[#1559](https://github.com/DemianLi/nexus-agent/issues/1559) N0622）與讀盤（#1549）共用同一支 header 驗證，
 * 兩邊才不會各說各話。事件之間的關係（{@link assertStoredRelationships}）也在這裡，讀完已接受的前綴之後跑。
 * 事件信封與單筆資料規則不在這裡：信封是 core 的 `assertSessionEventEnvelope`，seed 與讀盤逐行判壞行
 * （`jsonl-session-store.ts` 的 `parseJsonlSessionBody`）共用；資料規則是 core 的 `validateSessionEventData`，寫入、seed、
 * 讀盤三處共用。
 *
 * header 驗證拋的是 `TypeError`，訊息說哪一格：建立那一側原樣交給呼叫方，讀盤那一側由讀方換成 `SessionCorruptionError`。
 */

import { isAbsolute } from 'node:path';

import {
  createSessionRelationshipChecker,
  SessionCorruptionError,
  validateSessionEventData,
} from '@nexus/core';
import type { SessionEvent } from '@nexus/core';

/**
 * 這一版寫得出來的 header 鍵（`@nexus/core` 的 `StoredSessionHeader`）：必填的與允許的精確鍵白名單。
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
  'profile',
  'owner',
  'embedOrigin',
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

/** 非負的安全整數。 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * header 各格的形狀：缺必填的、多出這一版不寫的鍵、某一格型別不對，都拒。**版本是哪一版不在這裡判**：建立時要等於這一版，
 * 讀盤時由版本邊目錄判，兩邊規則不同。
 *
 * **白名單讀盤也能用同一份**（#1549）：它是任何一版寫過的鍵的聯集。`StoredSessionHeader` 從第一版起只加不減，50 以前是
 * 10 個鍵（#1549 對 `session-store.ts` 的歷次 commit 逐版核過），51 加了 `origin`、`isSeeded`（#1579；升版的理由正是 50 的這份白名單
 * 會把它們判成壞檔），53 加了 `profile`（#2367，只准 `'embed'`），54 加了 `owner`、`embedOrigin`（#2370，兩格同進同出、只跟 `profile: 'embed'` 一起）。之後加鍵要升版或過同版相容審查，比這一版新的檔在版本那一格就被擋下
 * （讀方開了 `acceptNewer` 讀比這一版新的，整支不跑，見 `parseHeader`）。
 *
 * `origin` 只准 `'subagent'`。`isSeeded` 只准 `true`：只在 true 時寫（`StoredSessionHeader.isSeeded`），落盤的 `false` 不是任何一版
 * 寫得出來的。其餘各格照 `StoredSessionHeader` 的宣告驗。
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
  if (header['profile'] !== undefined && header['profile'] !== 'embed') {
    throw new TypeError('session header 的 profile 只能是 "embed"');
  }
  assertOwnerFields(header);
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

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** `owner` 與 `embedOrigin`（#2370）：兩格同進同出，只跟 `profile: 'embed'` 一起；形狀照 `StoredSessionOwner`、`StoredSessionEmbedOrigin`。 */
function assertOwnerFields(header: Record<string, unknown>): void {
  const { owner, embedOrigin } = header;
  if (owner === undefined && embedOrigin === undefined) return;
  if (owner === undefined || embedOrigin === undefined) {
    throw new TypeError('session header 的 owner 與 embedOrigin 要一起出現');
  }
  if (header['profile'] !== 'embed') {
    throw new TypeError('session header 帶 owner 就要帶 profile: "embed"');
  }
  if (
    !isRecord(owner) ||
    Object.keys(owner).length !== 1 ||
    typeof owner['userId'] !== 'string' ||
    owner['userId'] === ''
  ) {
    throw new TypeError('session header 的 owner 要是 {userId: 非空字串}');
  }
  if (
    !isRecord(embedOrigin) ||
    Object.keys(embedOrigin).length !== 2 ||
    typeof embedOrigin['embedder'] !== 'string' ||
    embedOrigin['embedder'] === '' ||
    typeof embedOrigin['loginSessionSha256'] !== 'string' ||
    !SHA256_HEX.test(embedOrigin['loginSessionSha256'])
  ) {
    throw new TypeError(
      'session header 的 embedOrigin 要是 {embedder: 非空字串, loginSessionSha256: 64 個小寫十六進位字元}',
    );
  }
}

/**
 * 分叉前綴與 header 對不對得上，讀完已接受的前綴之後跑一次，回傳切點（[#1579](https://github.com/DemianLi/nexus-agent/issues/1579)）。
 *
 * 兩條：帶 `isSeeded` 的要有 inherited 標記；沒帶的不能有。切點不另外落盤，取最後一顆標記的 `seq`（core 的 `inheritedEventCount`），
 * 所以切點必然落在標記上、不會超過事件數，header 與標記一致與否就是上面兩條。
 *
 * **放在尾端復原之後**（#1579 做法第 4 步）：只看已接受的事件，交出前綴之前跑（`jsonl-session-store.ts` 的 `validateStoredLog`）。
 * 被丟掉的尾巴不在 `events` 裡，切點取自已接受的前綴，所以不會有「標記位置對不上繼承長度」的誤判；標記本身被當成壞尾巴丟掉時，
 * 這份 seeded 檔就拋損壞——繼承前綴的切點不能靠猜。
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
 * 讀回來的事件之間的關係，讀完已接受的前綴之後跑一次，三件：
 *
 * 1. 同一個子代理的 `subagent/catalog` 只能登記一次（#1549 N0603）。兩個寫入點都在派出的當下各寫一次、寫不進去
 *    就不落盤，重複只可能是寫壞或拼接出錯；讀方（`subagentLinkOf`）只取第一筆，後一筆會被靜靜忽略。
 * 2. turn、工具、模型呼叫、重試、送出佇列的配對（[#1597](https://github.com/DemianLi/nexus-agent/issues/1597)）：逐顆餵 core 的
 *    `createSessionRelationshipChecker`，跟執行期的配套入口同一支，第一筆違規就拒開。規則與為舊形狀留的分支（end-seed 時輪還開著的
 *    `carried`）寫在那一支裡。
 * 3. 標題的來源（#1597）：見 {@link titleSourceProblem}。`session/title` 與 `session/title-llm-request` 是 harness 用 `declare module`
 *    補進的詞彙（`session-title.ts`），core 那一支不解讀，由擁有者在這裡驗。
 *
 * 第 1 件先掃完；第 2、3 件同一趟逐顆跑，哪一件先撞到就拒在那一行。
 *
 * `childId` 不是字串（或 `data` 不是物件）也拒。`SubagentCatalogData` 的其他格不在這裡驗，只驗這條規則要用到的 `childId`。
 *
 * 第 1 件**只掃切點之後（含）的**：繼承來的前綴是父會話的登記，分叉之後自己的區段可以再派一個同 id 的子代理，
 * 前綴裡那一筆不算重複（[#1579](https://github.com/DemianLi/nexus-agent/issues/1579) 撤掉 #1549 的過渡）。第 2、3 件掃整份：前綴結尾是 inherited 的 `session/end-seed`，狀態在那裡照一般的 end-seed 重設或帶過去。
 *
 * @param id - 這份會話的 id，放進錯誤裡。
 * @param events - 已接受的前綴，依 `seq` 排好。
 * @param cut - 切點，{@link assertStoredInheritance} 回的那個。
 * @throws {@link SessionCorruptionError} 同一個 `childId` 登記了兩次、某一筆的 `childId` 不是字串，或某一顆違反事件之間的關係，
 *   訊息帶第幾行（與哪一條規則）。
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
  const checker = createSessionRelationshipChecker();
  const humanMessages = new Set<number>();
  for (const event of events) {
    if (event.type === 'session/title' || event.type === 'session/title-llm-request') {
      const problem = titleSourceProblem(event, humanMessages);
      if (problem !== undefined) {
        throw new SessionCorruptionError(id, `第 ${event.seq + 1} 行的 ${event.type} ${problem}`);
      }
    }
    if (event.type === 'turn/start' && dataField(event, 'kind') === 'message') {
      humanMessages.add(event.seq);
    }
    const [violation] = checker.accept(event);
    if (violation !== undefined) {
      throw new SessionCorruptionError(
        id,
        `第 ${violation.seq + 1} 行不合事件之間的關係（${violation.rule}）：${violation.message}`,
      );
    }
  }
}

/**
 * 標題的 `messageSeqs` 哪裡不對，沒問題回 `undefined`：`session/title` 的 `messageSeqs` 恰好在使用者改名時是空的；它與
 * `session/title-llm-request` 的每一格都指到更早、不重複的一顆人話（`turn/start {kind:'message'}`，見 `session-title.ts` 的 `messageSeqs`），
 * 模型標題的請求至少指一顆。
 */
function titleSourceProblem(
  event: SessionEvent,
  humanMessages: ReadonlySet<number>,
): string | undefined {
  const seqs = dataField(event, 'messageSeqs');
  if (!Array.isArray(seqs)) return '的 messageSeqs 不是陣列';
  if (event.type === 'session/title') {
    const source = dataField(event, 'source');
    const byUser = isRecord(source) && source['kind'] === 'user';
    if ((seqs.length === 0) !== byUser) return '的 messageSeqs 要恰好在使用者改名時是空的';
  } else if (seqs.length === 0) {
    return '的 messageSeqs 是空的';
  }
  const seen = new Set<unknown>();
  for (const value of seqs) {
    if (seen.has(value) || typeof value !== 'number' || !humanMessages.has(value)) {
      return `的 messageSeqs 有一格 ${String(value)} 不是更早、不重複的人話`;
    }
    seen.add(value);
  }
  return undefined;
}

/** `event.data[key]`；`data` 不是物件就是 `undefined`。 */
function dataField(event: SessionEvent, key: string): unknown {
  const data: unknown = event.data;
  return isRecord(data) ? data[key] : undefined;
}

/**
 * 讀回來的每一筆跑 core 的單筆資料規則（`validateSessionEventData`），不過就包成損壞錯誤。跑在 `jsonl-session-store.ts` 的 `validateStoredLog` 裡，續接、唯讀打開、遷移都走。
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
