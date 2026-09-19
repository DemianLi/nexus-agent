// @vitest-environment node
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
