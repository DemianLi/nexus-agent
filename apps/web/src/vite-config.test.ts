// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';

/** 網頁不由 Vite 服務（#426，照 dsh `rejectStandaloneServe`）：用真的設定檔走 Vite 自己的解析。 */

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));

describe('vite.config.ts', () => {
  it('dev server 拒絕啟動，錯誤指到正確的用法', async () => {
    await expect(resolveConfig({ configFile }, 'serve', 'development')).rejects.toThrow(
      /不由 Vite 服務.*pnpm dev.*serve/s,
    );
  });

  it('preview 也拒絕啟動（Vite 傳的 command 同樣是 serve）', async () => {
    await expect(
      resolveConfig({ configFile }, 'serve', 'production', 'production', true),
    ).rejects.toThrow(/不由 Vite 服務/);
  });

  it('build 照常', async () => {
    const config = await resolveConfig({ configFile }, 'build', 'production');
    expect(config.command).toBe('build');
  });
});

/**
 * 裸的 `cn` 解析到 `lib/utils.ts`（#1523，`resolve-alias.ts`）：build 走 Vite 的解析，型別檢查走 tsconfig 的 `paths`，兩份各自要接上。
 * `cn/config` 不能被改寫——`utils.ts` 自己就是從它取 `createCn`。
 */
describe('裸的 cn 解析到 lib/utils.ts（#1523）', () => {
  const utils = fileURLToPath(new URL('./lib/utils.ts', import.meta.url));

  it('build 的 Vite 解析：cn → lib/utils.ts，cn/config 照舊是套件', async () => {
    const config = await resolveConfig({ configFile }, 'build', 'production');
    const resolve = config.createResolver();
    expect(await resolve('cn', utils)).toBe(utils);
    expect(await resolve('cn/config', utils)).toMatch(/node_modules\/.*\bcn\b.*config/);
  });

  it('guard 測試頁的打包設定也經根 tsconfig.base.json 的 paths 解析 @nexus（#1642）：指到的檔存在，外掛有掛上', async () => {
    // 外掛的 `projects` 相對於 Vite 的 `root`（guard/）解析、指錯只印警告；乾淨樹（沒有 lib/）上 build 才會壞，CI 先建 lib 量不到。
    const guard = fileURLToPath(new URL('../guard/vite.config.ts', import.meta.url));
    const { BASE_TSCONFIG } = await import('../guard/vite.config');
    expect(BASE_TSCONFIG).toBe(
      fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url)),
    );
    expect(existsSync(BASE_TSCONFIG)).toBe(true);
    const config = await resolveConfig({ configFile: guard }, 'build', 'production');
    expect(config.plugins.map((plugin) => plugin.name)).toContain('vite-tsconfig-paths');
  });

  it('guard 測試頁的打包設定也用同一份解析（測試頁畫的 class 要跟出貨一樣）', async () => {
    const guard = fileURLToPath(new URL('../guard/vite.config.ts', import.meta.url));
    const config = await resolveConfig({ configFile: guard }, 'build', 'production');
    expect(await config.createResolver()('cn', utils)).toBe(utils);
  });

  it('tsconfig 的 paths：cn 精確指到同一個檔，沒有 cn/* 萬用', () => {
    const { paths } = readTsconfig().compilerOptions;
    expect(paths.cn).toEqual(['./src/lib/utils.ts']);
    expect(Object.keys(paths)).not.toContain('cn/*');
  });
});

/**
 * tsconfig 帶 JSON 註解（#1633）：`paths` 裡 `@nexus/*` 那一段由 #1502 的產生器寫，前後各一行 `// BEGIN`／`// END` 標記。
 * `JSON.parse` 遇到註解會丟錯，讀這個檔一律走 TypeScript 自己的 `parseConfigFileTextToJson`。
 */
function readTsconfig(): { compilerOptions: { paths: Record<string, string[]> } } {
  const text = readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8');
  const { config, error } = ts.parseConfigFileTextToJson('tsconfig.json', text);
  if (error !== undefined)
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  return config as { compilerOptions: { paths: Record<string, string[]> } };
}

describe('tsconfig 的 @nexus paths（#1633）', () => {
  it('產生器的標記是註解，照樣讀得出來；套件解析到各自的 src', () => {
    const text = readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8');
    expect(text).toContain('// BEGIN generated package aliases');
    expect(text).toContain('// END generated package aliases');
    const { paths } = readTsconfig().compilerOptions;
    expect(paths['@nexus/wire']).toEqual(['../../packages/nexus-wire/src/index.ts']);
    // 條數與區塊有沒有漂移交給產生器的 `--check`（#1502）；這裡只管每一條都指到某個套件的 src 底下的 .ts。
    const packages = Object.entries(paths).filter(([key]) => key.startsWith('@nexus/'));
    expect(packages.length).toBeGreaterThan(0);
    for (const [key, targets] of packages) {
      expect(targets, key).toEqual([
        expect.stringMatching(/^\.\.\/\.\.\/packages\/[^/]+\/src\/.+\.ts$/),
      ]);
    }
  });
});
