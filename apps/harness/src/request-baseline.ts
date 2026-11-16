/**
 * 請求基準檔的錄製器：把假端點收到的每一份請求 body 逐個測試記下來，正規化之後寫成檔。
 *
 * 只在設了 `NEXUS_REQUEST_BASELINE_OUT` 時動作；沒設就什麼都不做，所以掛在夾具與 setup 檔上不影響任何既有測試。
 * 錄製用 `request-baseline-refresh.ts` 驅動：同一批測試在 `shadow`（線上送的是 state 那條）與 `log` 各跑兩次、
 * 各錄到一個目錄，再逐案比對。
 *
 * @module
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 錄製的輸出目錄；沒設就不錄。 */
export const BASELINE_OUT_ENV = 'NEXUS_REQUEST_BASELINE_OUT';

/** 一個測試案例收到的請求，每個假端點一組，照假端點建立的順序。端點要在案例裡面建立：每個案例結束就清空。 */
const collected: unknown[][] = [];

/** 現在是不是在錄。 */
export function isRecordingBaseline(): boolean {
  return process.env[BASELINE_OUT_ENV] !== undefined;
}

/**
 * 開一組新的收集，回傳給假端點往裡推 body 的那個陣列。沒在錄時回 `undefined`。
 *
 * @returns 假端點每收到一份請求就 `push` 一次；或 `undefined`。
 */
export function openEndpointCollection(): unknown[] | undefined {
  if (!isRecordingBaseline()) return undefined;
  const bodies: unknown[] = [];
  collected.push(bodies);
  return bodies;
}

/**
 * 會隨執行變的字串換成記號：暫存目錄、時間戳、UUID，以及隨機的執行編號（`bg-…`、`session_…`，換成 `{{idN}}`）。只動字串值，不動結構。
 *
 * @param text - 原字串。
 * @param ids - 編號對照表；整個案例共用同一張，同一個編號換成同一個記號。
 * @returns 正規化後的字串。
 */
export function normalizeText(text: string, ids: Map<string, string> = new Map()): string {
  return text
    .replace(/\b(bg-[0-9a-f]{12}|session_[0-9a-f]{8})\b/g, (id) => {
      if (!ids.has(id)) ids.set(id, `{{id${String(ids.size + 1)}}}`);
      return ids.get(id)!;
    })
    .replace(
      /\/(?:private\/)?(?:var\/folders\/[^/\s"']+\/[^/\s"']+\/T|tmp)\/[^\s"'\\/]+/g,
      '{{tmp}}',
    )
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '{{uuid}}')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '{{time}}');
}

/** 遞迴正規化：只換字串值。`ids` 同 {@link normalizeText}。 */
export function normalizeValue(value: unknown, ids: Map<string, string> = new Map()): unknown {
  if (typeof value === 'string') return normalizeText(value, ids);
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, ids));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normalizeValue(item, ids),
      ]),
    );
  }
  return value;
}

/** 測試名字轉成檔名：路徑分隔與控制字元換掉，限長。 */
export function caseFileName(testName: string): string {
  const cleaned = [...testName]
    .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? '_' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return `${cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned}.json`;
}

/**
 * 把這個測試案例收到的請求寫成檔，然後清空。沒收到任何請求（或沒在錄）就什麼都不寫。
 *
 * @param testFile - 測試檔的基本檔名（不含目錄），當子目錄。
 * @param testName - 測試案例完整名字（含 describe 路徑）。
 */
export function flushBaseline(testFile: string, testName: string): void {
  const out = process.env[BASELINE_OUT_ENV];
  const groups = collected.splice(0).filter((bodies) => bodies.length > 0);
  if (out === undefined || groups.length === 0) return;
  const target = join(out, testFile, caseFileName(testName));
  mkdirSync(dirname(target), { recursive: true });
  // 隨機的執行編號整個案例共用一張對照表：同一個編號換成同一個記號，不同的編號分得開。
  const ids = new Map<string, string>();
  const payload = {
    case: testName,
    endpoints: groups.map((bodies) => bodies.map((body) => normalizeValue(body, ids))),
  };
  writeFileSync(target, `${JSON.stringify(payload, null, 1)}\n`);
}
