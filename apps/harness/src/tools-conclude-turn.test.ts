/**
 * **外部插件經 tools 服務標「這一輪在這個工具之後收」**（[#1607](https://github.com/DemianLi/nexus-agent/issues/1607)，`@nexus/tools` 契約 `1.4.0`）。
 *
 * 宿主把 core 的 `returnDirect` 語意改成「標了才收」之後，經 `@nexus/tools` 登記的外部工具碰不到 core 的 `concludeTurn`
 * （定義套件不相依 core）。`ctx.tools.concludeTurn(toolName)` 就是它們的入口，由宿主在 `plugin-tree.ts` 建提供者時注入。
 *
 * 量的是產品路徑：真的樹（`createCordisRoot`）、home 的 patch 插一列暫存目錄裡的函式插件、真的 `createCliAgent`；模型是腳本。
 *
 * - 工具宣告 `returnDirect: true` 且本體呼叫 `concludeTurn` → 這一輪在它之後結束（模型只被叫一次）。
 * - 宣告了 `returnDirect` 卻不呼叫 → 照常回頭叫模型（以前是每一種結局都收）。
 * - 沒宣告 `returnDirect` 卻呼叫 → 也不收（標記只對宣告過的工具有效）。
 *
 * 零憑證、零外部連線。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { withScriptedModel, withoutTimeContext } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { seedHomePatch } from './plugin-journal.fixture.js';
import type { ScriptedChatModel, ScriptedTurn } from './scripted-model.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 暫存目錄裡的模組解不出裸 specifier：langchain 的 `tool` 用絕對位置寫進模組。 */
const LANGCHAIN_TOOLS = import.meta.resolve('@langchain/core/tools');

/**
 * 一顆外部函式插件：只相依 `@nexus/tools`（`^1.4.0`），登記一個工具 `closer_tool`；
 * `declared` 決定有沒有宣告 `returnDirect`，參數 `close` 決定本體呼不呼叫 `concludeTurn`。
 */
function closerPlugin(declared: boolean): string {
  return `import { z } from 'zod';
import { tool } from ${JSON.stringify(LANGCHAIN_TOOLS)};
export const name = 'closer';
export const inject = { tools: { range: '^1.4.0' } };
export const Config = z.strictObject({});
export const manifest = {
  id: 'closer', version: '1.0.0', owner: 't',
  provides: [], consumes: [{ token: 'tools', range: '^1.4.0' }],
  config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply(ctx) {
  ctx.tools.register(
    tool(
      async ({ close }) => {
        if (close) ctx.tools.concludeTurn('closer_tool');
        return '好';
      },
      {
        name: 'closer_tool',
        description: '測試用：close 為真時標這一輪收。',
        schema: z.object({ close: z.boolean() }),
        ${declared ? 'returnDirect: true,' : ''}
      },
    ),
  );
}
`;
}

/** 一個 home，patch 插進 `closer` 那一列；回傳 env。 */
function home(declared: boolean): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join('/var/tmp', 'nexus-conclude-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  const module = join(dir, 'closer.mjs');
  writeFileSync(module, closerPlugin(declared), { mode: 0o600 });
  chmodSync(module, 0o600);
  seedHomePatch(dir, `- insert:\n    - id: closer\n      name: 'file://${module}'\n`);
  return { [HARNESS_HOME_ENV]: dir };
}

const AGAIN: ScriptedTurn = { content: '再試。' };

/** 叫一次 `closer_tool`，回頭看模型被叫了幾次。 */
async function modelCalls(declared: boolean, close: boolean): Promise<number> {
  const env = home(declared);
  const root = createCordisRoot();
  roots.push(root);
  const loaded = await loadDefaultPlugins({ env, warn: () => {} }, { tree: root.tree });
  expect(loaded.dropped).toEqual([]);
  const built = await createCliAgent(
    { live: false },
    withScriptedModel(withoutTimeContext(loaded.plugins), [
      { content: '收。', toolCalls: [{ name: 'closer_tool', args: { close } }] },
      AGAIN,
    ]),
  );
  try {
    await built.agent.invoke(toAgentInvocation('收一下'), {
      configurable: { thread_id: `conclude-${Math.random()}` },
    });
    return (built.model as ScriptedChatModel).prompts.length;
  } finally {
    await built.dispose();
  }
}

describe('外部插件：ctx.tools.concludeTurn（契約 1.4.0）', () => {
  it('宣告 returnDirect 且本體標了 → 這一輪在工具之後結束（模型 1 次）', async () => {
    expect(await modelCalls(true, true)).toBe(1);
  }, 60000);

  it('宣告 returnDirect 但這一回沒標 → 照常回頭叫模型（模型 2 次）', async () => {
    expect(await modelCalls(true, false)).toBe(2);
  }, 60000);

  it('沒宣告 returnDirect、本體卻標了 → 也不收（模型 2 次）', async () => {
    expect(await modelCalls(false, true)).toBe(2);
  }, 60000);
});
