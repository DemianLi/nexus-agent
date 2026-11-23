// 改 vendor 檔的登記機制（#1583）：`sync.mjs` 與 `vendor.test.ts` 共用這一份，套 patch、反向套 patch、產生 patch 都用同一套
// jsdiff（`diff` 套件），不混用系統的 `patch`／`diff -u`，邊界行為才不會在 `--check` 與離線測試之間分歧。
//
// - fuzz 0：context 一行都不能對不上（jsdiff 仍會往前後掃找 context 完全相同的位置，這是 unified diff 的 offset，不是 fuzz）。
// - 不自動轉換換行：patch 與檔案都要是 LF，CRLF 直接套不上（`.gitattributes` 的 `patches/** -text` 保證 checkout 不轉）。
// - 一個檔有多個 patch 時，照 manifest 的順序正向套，反向時倒序。
import { applyPatch, createTwoFilesPatch, parsePatch, reversePatch } from 'diff';

const OPTIONS = { fuzzFactor: 0, autoConvertLineEndings: false };

/** patch 檔名：`patches/NNNN-<元件>-<事由>.patch`。 */
export const PATCH_NAME = /^patches\/\d{4}-[a-z0-9]+(?:-[a-z0-9]+)+\.patch$/;

/** 解一個 patch 檔：只准一個檔的 diff。 */
function parseOne(text, name) {
  if (text.includes('\r')) throw new Error(`${name} 有 CR，patch 一律 LF`);
  const parsed = parsePatch(text);
  if (parsed.length !== 1) throw new Error(`${name} 要正好改一個檔，解出 ${parsed.length} 個`);
  return parsed[0];
}

/** 把 `patches`（`[名字, 內容]`，照 manifest 的順序）依序套到 `source` 上；任何一個套不上就丟錯。 */
export function applyAll(source, patches) {
  let text = source;
  for (const [name, patch] of patches) {
    const next = applyPatch(text, parseOne(patch, name), OPTIONS);
    if (next === false) throw new Error(`${name} 套不上（fuzz 0）`);
    text = next;
  }
  return text;
}

/** 從套完的內容倒推回上游原樣：`patches` 倒序反向套；任何一個退不回去就丟錯。 */
export function revertAll(patched, patches) {
  let text = patched;
  for (const [name, patch] of [...patches].reverse()) {
    const next = applyPatch(text, reversePatch(parseOne(patch, name)), OPTIONS);
    if (next === false) throw new Error(`${name} 反向套不上（fuzz 0）`);
    text = next;
  }
  return text;
}

/** 產生一個 patch：`before`（上游原樣加上前面的 patch）到 `after`（手改後）的 unified diff，檔名用 vendor 裡的路徑。 */
export function createOne(file, before, after) {
  return createTwoFilesPatch(`a/${file}`, `b/${file}`, before, after, '', '', { context: 3 });
}
