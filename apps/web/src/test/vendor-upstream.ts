import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 掃原始碼的護欄對 vendor 上游原樣的檔放行（#1523，PM 定的範圍）：放行的掃描都從這裡取，vendor 的位置只寫這一次。
 *
 * 放行的只有 `manifest.json` 登記過的檔——跟 `vendor.test.ts` 的 sha256 那條是同一份名單：沒登記的檔不算上游原樣，照樣檢查。
 * 放行：`lib/utils.test.ts` 的 cn 那條（Q19）、`design-system`、`border-shadow`、`type-hierarchy`（外觀照 SG，Q8；這幾條的責任交給
 * `solid-glass.overrides.css` 與 `guard/`）。**不放行**：tsc、`live-region` 與其他無障礙類的掃描（地圖目標：無障礙門檻全部保留）。
 * 設定檔裡非寫字面不可的（ESLint、`.prettierignore`、`.gitattributes`、`index.css` 的 `@source`）不在這裡。
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = 'vendor/solid-glass';

const manifest = JSON.parse(readFileSync(join(SRC, VENDOR, 'manifest.json'), 'utf8')) as {
  files: Record<string, unknown>;
};

/** 上游原樣的檔，相對 `src`、用 `/` 分隔。 */
export const VENDOR_UPSTREAM_FILES: ReadonlySet<string> = new Set(
  Object.keys(manifest.files).map((name) => `${VENDOR}/${name}`),
);

/** `file`（絕對路徑）是不是 vendor 上游原樣、要放行的檔。 */
export function isVendorUpstream(file: string): boolean {
  return VENDOR_UPSTREAM_FILES.has(relative(SRC, file).split(sep).join('/'));
}
