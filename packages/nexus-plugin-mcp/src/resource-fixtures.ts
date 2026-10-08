/**
 * 測試用 MCP server 的指引與資源（[#430](https://github.com/DemianLi/nexus-agent/issues/430)、
 * [#431](https://github.com/DemianLi/nexus-agent/issues/431)）。
 *
 * 兩台假 server（舊協議 [`fixture-server.ts`](./fixture-server.ts)、新協議
 * [`modern-stdio-server.ts`](./modern-stdio-server.ts)）都靠環境變數決定要不要宣告這兩樣：
 *
 * - `FIXTURE_INSTRUCTIONS`：整段當作 `initialize` 回的 `instructions`；沒設就不回。
 * - `FIXTURE_PAGED=1`（只有舊協議那台）：宣告 `resources` 能力，`resources/list` 分兩頁，用來量「沒帶 cursor 由 SDK 收齊、
 *   帶了 cursor 只回那一頁」。
 * - `FIXTURE_RESOURCES=1`：宣告 `resources` 能力，掛一份文字、一份二進位、一個模板。沒設就**沒有**這個能力。
 *
 * 不進 `index.ts` 的匯出——它是測試素材。
 */

/** 文字資源。 */
export const MEMO_URI = 'memo://readme';
export const MEMO_TEXT = '備忘錄：這是資源的全文。';

/** 文字資源實際回的內容：`FIXTURE_MEMO_TEXT` 有設就用它（真模型實跑用來放暗號），沒設是 {@link MEMO_TEXT}。 */
export function memoText(): string {
  return process.env['FIXTURE_MEMO_TEXT'] ?? MEMO_TEXT;
}
/** 二進位資源；blob 是這幾個位元組的 base64。 */
export const LOGO_URI = 'memo://logo';
export const LOGO_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const LOGO_BASE64 = Buffer.from(LOGO_BYTES).toString('base64');
/** 模板，`{id}` 展開之後讀得到 {@link noteText}。 */
export const NOTE_TEMPLATE = 'memo://note/{id}';

/** 模板展開之後那份資源的文字。 */
export function noteText(id: string): string {
  return `筆記 ${id}`;
}

/** 分頁夾具：`FIXTURE_PAGED=1` 時 `resources/list` 分兩頁，第二頁的 cursor 是 {@link PAGE_2_CURSOR}。 */
export const PAGED_FIRST_URI = 'page://one';
export const PAGED_SECOND_URI = 'page://two';
export const PAGE_2_CURSOR = 'p2';

/** 這個環境變數有沒有要求分頁的資源清單。 */
export function pagedRequested(): boolean {
  return process.env['FIXTURE_PAGED'] === '1';
}

/** 這個環境變數有沒有要求宣告資源。 */
export function resourcesRequested(): boolean {
  return process.env['FIXTURE_RESOURCES'] === '1';
}

/** 這個環境變數要求的指引；沒設是 `undefined`。 */
export function instructionsRequested(): string | undefined {
  return process.env['FIXTURE_INSTRUCTIONS'];
}
