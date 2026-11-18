/**
 * 插件照抄的預算（[#2777](https://github.com/DemianLi/nexus-agent/issues/2777)）跟 `@nexus/core` 的預算表釘成相等：插件不能 import core，
 * 預設值、鍵名與算法各抄了一份，這裡是唯一同時看得到兩邊的地方。改了表沒改插件（或反過來）在這裡紅。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HumanMessage } from '@langchain/core/messages';
import {
  INJECTION_DEFERRED_BYTES_KEY,
  INJECTION_SOURCE_BUDGETS,
  injectionLimitFor,
  sourceKwargs,
} from '@nexus/core';
import {
  agentInstructionsConfigSchema,
  createAgentInstructionsListener,
  INJECTION_DEFERRED_BYTES_KEY as INSTRUCTIONS_DEFERRED_KEY,
} from '@nexus/plugin-agent-instructions';
import { MAX_GUIDANCE_BYTES } from '@nexus/plugin-plan-mode';
import {
  Config as invocationConfig,
  createSkillInvocationListener,
  INJECTION_DEFERRED_BYTES_KEY as INVOCATION_DEFERRED_KEY,
} from '@nexus/plugin-skills/invocation';
import { afterEach, describe, expect, it } from 'vitest';

import { ContainedFilesystemBackend } from './contained-backend.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 一個工作區：70,000 位元組的 `AGENTS.md` 與同樣大的技能 `big`，任何窗口下都放不下。 */
function workspace(): ContainedFilesystemBackend {
  const root = mkdtempSync(join(tmpdir(), 'nexus-budget-pins-'));
  dirs.push(root);
  writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(70_000));
  mkdirSync(join(root, 'skills', 'big'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'big', 'SKILL.md'),
    `---\nname: big\ndescription: 大。\n---\n\n${'y'.repeat(70_000)}\n`,
  );
  return new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });
}

const fsOf = (backend: ContainedFilesystemBackend) => () =>
  ({
    kind: 'ok',
    address: { kind: 'root' },
    fs: {
      backend: () => backend,
      sharedWorkspacePrefix: () => undefined,
      offWorkspacePrefixes: () => [],
      skillSources: () => ['/skills/'],
    },
  }) as never;

/** 有窗口與沒有窗口各幾種：比例贏、絕對上限贏、宿主沒交。 */
const WINDOWS = [1000, 8192, 131_072, 1_000_000, undefined] as const;

describe('預設值與鍵名', () => {
  it('agent-instructions、skill-invocation 的設定預設值就是表上那一列', () => {
    expect(agentInstructionsConfigSchema.parse({})).toMatchObject({
      maxBytes: INJECTION_SOURCE_BUDGETS['agent-instructions'].maxBytes,
      contextFraction: INJECTION_SOURCE_BUDGETS['agent-instructions'].contextFraction,
    });
    expect(invocationConfig.parse({})).toEqual({
      maxBytes: INJECTION_SOURCE_BUDGETS['skill-invocation'].maxBytes,
      contextFraction: INJECTION_SOURCE_BUDGETS['skill-invocation'].contextFraction,
    });
  });

  it('plan-mode 的指引上限就是表上 plan:policy 那一列', () => {
    expect(MAX_GUIDANCE_BYTES).toBe(injectionLimitFor('plan:policy'));
  });

  it('兩個插件回報延後位元組的鍵跟 core 讀的是同一個', () => {
    expect(INSTRUCTIONS_DEFERRED_KEY).toBe(INJECTION_DEFERRED_BYTES_KEY);
    expect(INVOCATION_DEFERRED_KEY).toBe(INJECTION_DEFERRED_BYTES_KEY);
  });
});

describe('算法：插件照預設值算出來的上限 ＝ injectionLimitFor', () => {
  it.each(WINDOWS)('agent-instructions，窗口 %s', async (contextWindow) => {
    const listener = createAgentInstructionsListener(agentInstructionsConfigSchema.parse({}), {
      fs: fsOf(workspace()),
    });
    const injections = await listener([], {
      configurable: {},
      ...(contextWindow !== undefined && { contextWindow }),
    });
    const limit = injectionLimitFor('agent-instructions', contextWindow);
    const content = String(injections?.[0]?.content);
    expect(content).toContain(`Workspace instruction budget ${limit} bytes: `);
    // 預算大到截得出檔頭就截，小到截不出（窗口 1000，上限 400）就整份不放。
    expect(content).toMatch(
      /truncated \/AGENTS\.md from 70000 to \d+ bytes|not loaded \/AGENTS\.md \(70000 bytes\)/,
    );
    // 整則訊息（含通知與外框）不超過算出來的上限。
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(limit);
  });

  it.each(WINDOWS)('skill-invocation，窗口 %s', async (contextWindow) => {
    const listener = createSkillInvocationListener(
      { fs: fsOf(workspace()) },
      invocationConfig.parse({}),
    );
    const said = new HumanMessage({
      content: '/big',
      id: 'h1',
      additional_kwargs: sourceKwargs({ kind: 'user' }),
    });
    const injections = await listener([said], {
      configurable: {},
      ...(contextWindow !== undefined && { contextWindow }),
    });
    expect(injections?.[0]?.content).toContain(
      `over the ${injectionLimitFor('skill-invocation', contextWindow)}-byte budget`,
    );
  });
});
