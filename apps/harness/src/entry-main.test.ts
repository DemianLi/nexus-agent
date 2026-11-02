import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { HARNESS_VERSION } from './harness-version.js';

/**
 * 三個入口（serve、cli、plugin-cli）用 `import.meta.main` 判斷「被當腳本跑」，不比 `argv[1]` 與 `import.meta.url`（#1502）。
 *
 * 比路徑的版本在裝好之後經 `node_modules/.bin` 的符號連結啟動時會對不上：`argv[1]` 是連結、`import.meta.url` 是真實路徑，
 * main 不執行，**什麼都不印、以 0 結束**——像成功。所以這裡從符號連結啟動，斷言輸出真的出現；把任一個入口改回比 `argv[1]`，
 * 對應那一條就紅（輸出空白）。`--version` 是不碰任何東西就印完的旗標，所以量的只有「main 有沒有跑」。
 *
 * 這裡跑的是原始碼（`node --import tsx`）。編出來的 `lib/` 經 `node_modules/.bin` 啟動的版本由 `scripts/smoke-built-bin.ts`
 * 在 build 之後量（`lib/` 在測試用的乾淨樹裡不存在，測試不替它建）。
 */

const run = promisify(execFile);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 在暫存目錄放一條指向 `src/<name>.ts` 的符號連結，回連結路徑。 */
function linkTo(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'entry-main-'));
  roots.push(root);
  const link = join(root, `nexus-${name}`);
  symlinkSync(fileURLToPath(new URL(`./${name}.ts`, import.meta.url)), link);
  return link;
}

describe.each(['serve', 'cli', 'plugin-cli'])('%s 經符號連結啟動', (name) => {
  it('main 會跑：--version 印出 manifest 的版本，不是靜靜以 0 結束', async () => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', linkTo(name), '--version'], {
      timeout: 60_000,
    });
    expect(stdout.trim()).toBe(HARNESS_VERSION);
  });
});

describe('被 import 時不執行 main', () => {
  it('import 入口模組不印版本、不起 server', async () => {
    const entry = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(entry)});`],
      { timeout: 60_000 },
    );
    expect(stdout).toBe('');
  });
});
