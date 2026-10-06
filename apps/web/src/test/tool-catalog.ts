import { readFileSync } from 'node:fs';

/**
 * 讀 `docs/tool-catalog.md`（#442）：模型實際收到的每一個工具名。那份檔由 harness 的產生器從產品組裝產出、CI 驗它沒有過期，
 * 所以這裡**不解析別套件的原始碼**，只讀它（#666）。
 *
 * 解析本身有自檢：檔頭寫「（共 N 個）」，抓到的工具標題數對不上就拋，不讓格式一變就悄悄少抓幾個而測試照樣綠。
 */
const CATALOG = new URL('../../../../docs/tool-catalog.md', import.meta.url);

export function catalogToolNames(): readonly string[] {
  const text = readFileSync(CATALOG, 'utf8');
  const names = [...text.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1] ?? '');
  const declared = /（共 (\d+) 個）/.exec(text);
  if (declared === null)
    throw new Error('工具目錄找不到「（共 N 個）」那一句，格式變了，解析要跟著改');
  if (Number(declared[1]) !== names.length) {
    throw new Error(`工具目錄寫共 ${declared[1]} 個，但解析到 ${names.length} 個工具標題`);
  }
  return names;
}
