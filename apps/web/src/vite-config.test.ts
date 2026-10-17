// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

  it('guard 測試頁的打包設定也用同一份解析（測試頁畫的 class 要跟出貨一樣）', async () => {
    const guard = fileURLToPath(new URL('../guard/vite.config.ts', import.meta.url));
    const config = await resolveConfig({ configFile: guard }, 'build', 'production');
    expect(await config.createResolver()('cn', utils)).toBe(utils);
  });

  it('tsconfig 的 paths：cn 精確指到同一個檔，沒有 cn/* 萬用', () => {
    const tsconfig = JSON.parse(
      readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'),
    ) as { compilerOptions: { paths: Record<string, string[]> } };
    expect(tsconfig.compilerOptions.paths.cn).toEqual(['./src/lib/utils.ts']);
    expect(Object.keys(tsconfig.compilerOptions.paths)).not.toContain('cn/*');
  });
});
