/**
 * 這個套件 lint 設定的排除範圍（[#2533](https://github.com/DemianLi/nexus-agent/issues/2533)，照 #1463 Q3 (a)）。
 *
 * 排除**只蓋到 `src/invariant.ts`**。要證的兩半：
 *
 * 1. SDK 規則**完整**落在 `src/index.ts`：解析後的 `no-restricted-*` 規則與 `pluginLintConfig` 逐條相同（不是「至少紅一條」），
 *    而且同一份違規碼放到 `src/index.ts` 這個路徑真的紅；
 * 2. 另一個**不在排除名單**的檔（一個不存在的違規檔路徑）同樣紅，而同一份違規碼放在 `src/invariant.ts` 這個路徑不紅——
 *    排除的範圍就是那一個檔，不多不少。
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

const eslint = new ESLint({
  cwd: PACKAGE,
  overrideConfigFile: `${PACKAGE}eslint.config.js`,
});

/**
 * **暖身：ESLint 第一次載入設定的一次性成本不能算在第一條測試頭上**（[#2412](https://github.com/DemianLi/nexus-agent/issues/2412)）。
 *
 * 設定檔在第一次 `lintText`／`calculateConfigForFile` 才載入：根目錄那份 import `typescript-eslint`，連帶載入 `typescript`
 * 本體，本機約 400ms；載過之後每次 `lintText` 只要個位數到幾十 ms。CI 上好幾個套件的測試同時跑時，這段放大到 2–5 秒（量測見
 * #2412），全落在檔裡的第一條，貼著它預設的 5 秒逾時。所以在這裡先付掉，每條測試的逾時只蓋熱路徑。hook 的逾時明講成遠高於實測的
 * 60 秒：預設的 10 秒不到 #2412 在 CI 上量到最慢那次（5.4 秒）的兩倍。
 *
 * 暖身只 lint 一段空字串、不做斷言：規則落在哪、排除蓋到哪，仍由下面每一條自己量。
 */
beforeAll(async () => {
  await eslint.lintText('', { filePath: `${PACKAGE}src/index.ts` });
}, 60_000);

/** 這一份違規碼同時踩到「不准碰 `ctx.root`」與「模組層的可變狀態」。 */
const VIOLATING = [
  'const seen = new Set<string>();',
  'export function apply(ctx: { root: unknown }): void {',
  '  void ctx.root;',
  '  seen.add("x");',
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

describe('SDK lint 在 @nexus/plugin-sandbox-policy 的範圍', () => {
  it('src/index.ts：逐行 eslint-disable（清理在 #2557）之外沒有違規，而且同一份違規碼放在這個路徑會紅（規則真的落在它身上）', async () => {
    const real = readFileSync(`${PACKAGE}src/index.ts`, 'utf8');
    expect(await restricted(real, 'src/index.ts')).toEqual([]);
    expect((await restricted(VIOLATING, 'src/index.ts')).length).toBeGreaterThan(0);
  });

  it('不在排除名單的另一個檔（暫存的違規檔）照樣紅', async () => {
    expect((await restricted(VIOLATING, 'src/temporary-violation.ts')).length).toBeGreaterThan(0);
  });

  it('排除只蓋到 src/invariant.ts：同一份違規碼放在這個路徑不紅', async () => {
    expect(await restricted(VIOLATING, 'src/invariant.ts')).toEqual([]);
  });

  it('排除名單就是那一個檔：src/index.ts 的解析後規則與 SDK 的設定逐條相同，invariant.ts 拿不到 SDK 的 no-restricted-syntax', async () => {
    const config = (await eslint.calculateConfigForFile(`${PACKAGE}src/index.ts`)) as {
      rules?: Record<string, unknown>;
    };
    const expected = pluginLintConfig[0]!.rules as Record<string, unknown>;
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    // ESLint 解析後把嚴重度 `'error'` 正規化成 `2`，其餘（選項）逐字相同。
    const normalized = (value: unknown): unknown =>
      Array.isArray(value) ? [value[0] === 'error' ? 2 : value[0], ...value.slice(1)] : value;
    for (const [rule, value] of Object.entries(expected)) {
      expect(config.rules?.[rule], rule).toEqual(normalized(value));
    }
    const excluded = (await eslint.calculateConfigForFile(`${PACKAGE}src/invariant.ts`)) as
      | {
          rules?: Record<string, unknown>;
        }
      | undefined;
    // 被排除的檔拿不到 SDK 的 no-restricted-syntax（只剩 base 的規則）。
    expect(excluded?.rules?.['no-restricted-syntax']).toBeUndefined();
  });
});
