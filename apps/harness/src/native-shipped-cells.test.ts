/**
 * native 下每一種出貨組裝都建得起來（#2416）：native 只呼叫 middleware 上登記的那一步，沒登記、也不在 noop 清單上的格，
 * `createNativeAgent` 建構時就拋（`packages/nexus-core/src/native-loop/agent.ts`）。這裡把產品會組的每一種都用 native 建一次。
 *
 * 另外列舉 native 還在原位呼叫的工具步驟（有 `wrapToolCall` 的那幾顆）。這份清單是封閉的：多一顆、少一顆都紅，
 * 往裡加一顆要先經過決策（#2416 驗收）。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeAgent } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, shippedServePlugins, withScriptedModel } from './fixtures.js';

/**
 * native 還在原位呼叫的工具步驟，照類別排：
 *
 * - loop 自己做的：barrier、圍堵；
 * - 工具事件由 loop 派發的點：pre-execute、execute、post-execute；
 * - 核准不搬上匯流排（#1466）：核准閘門；
 * - 維持登記一步的：invalidToolArgs、readContinuation、背景委派、host-tools（#2522），turnCancel（併進 loop，TODO(#2363)）；
 * - 基座帶進來的：基座 Filesystem 的工具結果搬檔。
 */
const TOOL_STEPS_IN_PLACE = [
  'FilesystemMiddleware',
  'host-tools',
  'nexusApprovalGate',
  'nexusBackgroundDelegation',
  'nexusInvalidToolArgs',
  'nexusReadContinuation',
  'nexusToolBarrier',
  'nexusToolExecute',
  'nexusToolFailureContainment',
  'nexusToolPostExecute',
  'nexusToolPreExecute',
  'nexusTurnCancel',
];

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type Invocation = Parameters<typeof createCliAgent>[0];

/** 用 native 建一次，回有 `wrapToolCall` 的那幾顆的名字。 */
async function toolStepsOf(
  plugins: readonly PluginEntry[],
  invocation: (root: string, shared: string) => Omit<Invocation, 'live' | 'agentLoop'>,
): Promise<string[]> {
  const root = await tempDir('native-cells-');
  const shared = await tempDir('native-cells-shared-');
  const built = await createCliAgent(
    { live: false, agentLoop: 'native', ...invocation(root, shared) },
    withScriptedModel(plugins, [{ content: '好了' }]),
    root,
  );
  try {
    expect(built.agent).toBeInstanceOf(NativeAgent);
    const middleware = (built.agent as unknown as NativeAgent).middleware;
    return [
      ...new Set(middleware.filter((m) => m.wrapToolCall !== undefined).map((m) => m.name)),
    ].sort();
  } finally {
    await built.dispose();
  }
}

/** 產品會組的每一種：兩個入口的出貨清單、沒有 `--workspace` 的 CLI、serve 的選配全開，與嵌入版（host-tools 只在嵌入版掛）。 */
const ASSEMBLIES = [
  [
    'serve 出貨清單',
    shippedServePlugins,
    (root: string) => ({ workspace: root, sandbox: 'workspace-write', stepInbox: true }),
  ],
  [
    'CLI 出貨清單',
    shippedPlugins,
    (root: string) => ({ workspace: root, sandbox: 'workspace-write' }),
  ],
  ['CLI 出貨清單，沒有 --workspace', shippedPlugins, () => ({})],
  [
    'serve 選配全開（共用區、背景委派、插話）',
    shippedServePlugins,
    (root: string, shared: string) => ({
      workspace: root,
      sandbox: 'workspace-write',
      stepInbox: true,
      sharedWorkspaceRoot: shared,
      backgroundSubagents: { maxActive: 2 },
    }),
  ],
  [
    '嵌入版（host-tools）',
    shippedServePlugins,
    (root: string) => ({
      workspace: root,
      sandbox: 'workspace-write',
      stepInbox: true,
      profile: 'embed',
      hostTools: {},
    }),
  ],
] as const;

describe('native 下每一種出貨組裝都建得起來', () => {
  it('每一種都建得起來；原位呼叫的工具步驟都在清單上，合起來恰好是那份清單', async () => {
    const seen = new Set<string>();
    for (const [label, load, of] of ASSEMBLIES) {
      const steps = await toolStepsOf(await load(), of as never);
      expect(
        steps.filter((name) => !TOOL_STEPS_IN_PLACE.includes(name)),
        label,
      ).toEqual([]);
      for (const name of steps) seen.add(name);
    }
    expect([...seen].sort()).toEqual([...TOOL_STEPS_IN_PLACE].sort());
  });
});
