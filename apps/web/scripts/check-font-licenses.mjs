/* global console, process, URL */
/**
 * 量**建置出來的產物**：三顆 fontsource 字型的 OFL 全文真的在 `dist/assets/fonts/`（#1713）。`pnpm build` 的最後一步，
 * 失敗就讓建置失敗。外掛（`font-licenses.ts`）沒掛進 `vite.config.ts`、或少產出一份，這裡就紅；外掛本身怎麼產出由
 * `src/font-licenses.test.ts` 量。檔名清單跟外掛的 `FONT_LICENSES` 是同一份：這支是純 Node 腳本，讀不了 TypeScript，
 * 所以列在這裡，`src/font-licenses.test.ts` 斷言兩份一致。
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EXPECTED = [
  { fileName: 'assets/fonts/Geist-OFL.txt', marker: 'Geist-Italic[wght].ttf' },
  { fileName: 'assets/fonts/GeistMono-OFL.txt', marker: 'GeistMono-Italic[wght].ttf' },
  { fileName: 'assets/fonts/NotoSansTC-OFL.txt', marker: 'Google Inc.' },
];

const OFL_TITLE = 'SIL OPEN FONT LICENSE Version 1.1';

/**
 * 量一份 `dist`，回傳問題清單（空的就是過）。
 *
 * @param {URL} dist - 產物目錄。
 * @returns {string[]} 每一條是一個問題。
 */
export function checkFontLicenses(dist) {
  const problems = [];
  for (const { fileName, marker } of EXPECTED) {
    let text;
    try {
      text = readFileSync(new URL(fileName, dist), 'utf8');
    } catch (error) {
      problems.push(
        `${fileName} 不在產物裡：${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!text.includes(OFL_TITLE)) problems.push(`${fileName} 沒有「${OFL_TITLE}」`);
    if (!text.includes(marker))
      problems.push(`${fileName} 不是對應那顆字型的授權（找不到「${marker}」）`);
  }
  return problems;
}

// 直接執行才量（`node scripts/check-font-licenses.mjs`）；測試 import 時不跑。比 realpath：路徑經過符號連結時字面對不上。
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const problems = checkFontLicenses(new URL('../dist/', import.meta.url));
  if (problems.length > 0) {
    console.error(`字型授權全文（#1713）：\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`字型授權全文：${EXPECTED.length} 份都在 dist/assets/fonts/`);
}
