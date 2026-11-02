import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import type { Plugin } from 'vite';

/**
 * 網頁打包的三顆 fontsource 字型都是 OFL-1.1：散布字型要附著作權聲明與授權全文
 * （[#1713](https://github.com/DemianLi/nexus-agent/issues/1713)）。照 dsh `apps/web/vite.config.ts:34-46` 的
 * `brandFontLicense()`，全文在 `generateBundle` 跟著字型進 `dist/assets/fonts/`，檔名照它的 `<字型>-OFL.txt`。
 *
 * 跟 dsh 的差別：dsh 的 Montserrat 放在原始碼裡（`packages/client/ui-theme/src/styles/`），授權全文也是；我們的字型
 * 來源是 fontsource 套件（#1468／#1512 的 UI 拍板），全文就讀套件自己帶的 `LICENSE`（三個套件的 `exports` 都開了
 * `./LICENSE`），版本跟著字型一起升。
 *
 * `scripts/check-font-licenses.mjs` 在 `pnpm build` 最後一步量產物裡真的有這三份。
 */
export const FONT_LICENSES = [
  { package: '@fontsource-variable/geist', fileName: 'assets/fonts/Geist-OFL.txt' },
  { package: '@fontsource-variable/geist-mono', fileName: 'assets/fonts/GeistMono-OFL.txt' },
  { package: '@fontsource-variable/noto-sans-tc', fileName: 'assets/fonts/NotoSansTC-OFL.txt' },
] as const;

const require = createRequire(import.meta.url);

/**
 * 字型套件自己帶的授權全文的路徑。
 *
 * @param fontPackage - fontsource 套件名，例如 `@fontsource-variable/geist`。
 * @returns 那個套件的 `LICENSE` 的絕對路徑。
 */
export function fontLicensePath(fontPackage: string): string {
  return require.resolve(`${fontPackage}/LICENSE`);
}

/** 把每顆字型的 OFL 全文放到產物的 `assets/fonts/`，跟 woff2 一起散布。 */
export function fontLicenses(): Plugin {
  return {
    name: 'nexus-font-licenses',
    async generateBundle() {
      for (const { package: fontPackage, fileName } of FONT_LICENSES) {
        this.emitFile({
          type: 'asset',
          fileName,
          source: await readFile(fontLicensePath(fontPackage)),
        });
      }
    },
  };
}
