/**
 * 這個套件 lint 設定的排除範圍（#2551）。
 *
 * 排除**只蓋到 `src/invariant.ts` 與 `src/model-call-cell.ts`**。要證的兩半：
 *
 * 1. SDK 規則**完整**落在不在名單上的檔：解析後的 `no-restricted-*` 規則與 `pluginLintConfig` 逐條相同（不是「至少紅一條」），
 *    產品檔現在零違規，而且同一份違規碼放到它們的路徑真的紅；
 * 2. 另一個**不在排除名單**的檔（一個不存在的違規檔路徑）同樣紅，而同一份違規碼放在名單上的兩個路徑不紅——排除的範圍就是那兩個檔，
 *    不多不少。
 *
 * 量的是這個套件**真的那份** `eslint.config.js`（`overrideConfigFile`），不是手搭一份相似的設定。違規碼放在記憶體裡、不落成檔：
 * 落地的違規夾具會被 `pnpm -r run lint`、typecheck 與 prettier 掃到（理由同 `packages/nexus-sdk/src/lint.test.ts` 檔頭）；
 * `lintText` 的 `filePath` 是虛擬路徑，決定它被當成哪一個檔——「暫存的違規檔」就是這個。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { pluginLintConfig } from '@nexus/sdk/lint';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

/** 排除名單，與 `eslint.config.js` 的 `EXCLUDED` 逐項相同。 */
const EXCLUDED = ['src/invariant.ts', 'src/model-call-cell.ts'] as const;

/** 受管的產品檔：每一個現在都零違規。 */
const GOVERNED = ['src/index.ts', 'src/command.ts', 'src/plan-mode-state.ts'] as const;

const eslint = new ESLint({
  cwd: PACKAGE,
  overrideConfigFile: `${PACKAGE}eslint.config.js`,
});

// 暖身：ESLint 第一次載入設定的一次性成本不算在第一條測試頭上（理由與 60 秒同 `@nexus/plugin-goal` 的 `eslint-exclusion.test.ts`，#2412）。
beforeAll(async () => {
  await eslint.lintText('', { filePath: `${PACKAGE}src/index.ts` });
}, 60_000);

/** 這一份違規碼同時踩到「不准碰 `ctx.root`」、「模組層的可變狀態」與「import `@nexus/core`」。 */
const VIOLATING = [
  "import type { NexusPlugin } from '@nexus/core';",
  'const seen = new Set<string>();',
  'export function apply(ctx: { root: unknown }): NexusPlugin | undefined {',
  '  void ctx.root;',
  '  seen.add("x");',
  '  return undefined;',
  '}',
  '',
].join('\n');

async function restricted(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${PACKAGE}${file}` });
  const messages = result?.messages ?? [];
  expect(messages.filter((m) => m.fatal === true).map((m) => m.message)).toEqual([]);
  return messages
    .filter((m) => m.ruleId === 'no-restricted-syntax' || m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

describe('SDK lint 在 @nexus/plugin-plan-mode 的範圍', () => {
  it.each(GOVERNED)('%s：現在零違規，而且同一份違規碼放在這個路徑會紅', async (file) => {
    const real = readFileSync(`${PACKAGE}${file}`, 'utf8');
    expect(await restricted(real, file)).toEqual([]);
    expect((await restricted(VIOLATING, file)).length).toBeGreaterThan(0);
  });

  it('不在排除名單的另一個檔（暫存的違規檔）照樣紅', async () => {
    expect((await restricted(VIOLATING, 'src/temporary-violation.ts')).length).toBeGreaterThan(0);
  });

  it.each(EXCLUDED)('排除蓋到 %s：同一份違規碼放在這個路徑不紅', async (file) => {
    expect(await restricted(VIOLATING, file)).toEqual([]);
  });

  it('受管的檔解析後的規則與 SDK 的設定逐條相同，排除的兩個檔沒有', async () => {
    const expected = pluginLintConfig[0]!.rules as Record<string, unknown>;
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    // ESLint 解析後把嚴重度 `'error'` 正規化成 `2`，其餘（選項）逐字相同。
    const normalized = (value: unknown): unknown =>
      Array.isArray(value) ? [value[0] === 'error' ? 2 : value[0], ...value.slice(1)] : value;
    for (const file of GOVERNED) {
      const config = (await eslint.calculateConfigForFile(`${PACKAGE}${file}`)) as {
        rules?: Record<string, unknown>;
      };
      for (const [rule, value] of Object.entries(expected)) {
        expect(config.rules?.[rule], `${file} ${rule}`).toEqual(normalized(value));
      }
    }
    for (const file of EXCLUDED) {
      const excluded = (await eslint.calculateConfigForFile(`${PACKAGE}${file}`)) as
        { rules?: Record<string, unknown> } | undefined;
      // 被排除的檔拿不到 SDK 的 no-restricted-syntax（只剩 base 的規則）。
      expect(excluded?.rules?.['no-restricted-syntax'], file).toBeUndefined();
    }
  });
});
