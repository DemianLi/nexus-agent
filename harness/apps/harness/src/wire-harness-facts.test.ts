/**
 * `@nexus/wire` 的 `harness-facts.ts` 跟它的來源釘在一起（[#3147](https://github.com/DemianLi/nexus-agent/issues/3147)）。
 *
 * web 的測試跟 wire 的值比，這一份讓 wire 的值跟來源比。來源改了字，這裡先紅，不會變成 web 靜靜對著舊值綠。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  normalizeCommandDefinition,
  SUBAGENT_MAX_TOKENS_REASON as CORE_MAX_TOKENS_REASON,
} from '@nexus/core';
import { EXTERNAL_MCP_CONTENT_NOTICE as CORE_MCP_NOTICE } from '@nexus/core';
import { parseCommand, runsWhileBusy } from '@nexus/plugin-commands';
import {
  EXIT_PLAN_MODE_TOOL_NAME as PLAN_TOOL,
  PLAN_KEEP_PLANNING_MESSAGE as PLAN_KEEP,
  PLAN_REVIEW_DISMISSED_MESSAGE as PLAN_DISMISSED,
  planFeedbackMessage,
} from '@nexus/plugin-plan-mode';
import {
  APPROVAL_DEFAULT_REASON_TEMPLATE,
  APPROVAL_REJECTED_TEMPLATE,
  COMMAND_GRAMMAR_DESCRIPTORS,
  COMMAND_TOKEN_CASES,
  EXIT_PLAN_MODE_TOOL_NAME,
  EXTERNAL_MCP_CONTENT_NOTICE,
  MODEL_TOOL_NAMES,
  MODEL_TOOL_TEXT,
  PARTIAL_OUTPUT_HEADING,
  PLAN_FEEDBACK_PREFIX,
  PLAN_KEEP_PLANNING_MESSAGE,
  PLAN_REVIEW_DISMISSED_MESSAGE,
  RUNS_WHILE_BUSY_CASES,
  SUBAGENT_MAX_TOKENS_REASON,
  TURN_TIMEOUT_REASON,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { repositoryRoot } from './package-invariants.js';
import { TURN_TIMEOUT_REASON as HARNESS_TURN_TIMEOUT_REASON } from './settings/turn-timeout.js';

const root = repositoryRoot();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('wire 的 harness 事實：字', () => {
  it('核准閘門的預設理由與被拒的樣板（core 的 approval.ts）', () => {
    const approval = read('harness/packages/nexus-core/src/approval.ts');
    const fill = (template: string | undefined) => template?.replace('${exec.name}', '{name}');
    expect(fill(/decision\.reason \?\? `([^`]*)`/u.exec(approval)?.[1])).toBe(
      APPROVAL_DEFAULT_REASON_TEMPLATE,
    );
    expect(fill(/verdict\.message \?\? `([^`]*)`/u.exec(approval)?.[1])).toBe(
      APPROVAL_REJECTED_TEMPLATE,
    );
  });

  it('一輪時鐘到點的原因、MCP 外部內容前綴', () => {
    expect(TURN_TIMEOUT_REASON).toBe(HARNESS_TURN_TIMEOUT_REASON);
    expect(EXTERNAL_MCP_CONTENT_NOTICE).toBe(CORE_MCP_NOTICE);
  });

  it('子代理撞上限的字與組法（core 的 max-tokens.ts、tool-events.ts）', () => {
    expect(SUBAGENT_MAX_TOKENS_REASON).toBe(CORE_MAX_TOKENS_REASON);
    const core = read('harness/packages/nexus-core/src/max-tokens.ts');
    expect(/PARTIAL_OUTPUT_HEADING = '([^']*)'/u.exec(core)?.[1]).toBe(PARTIAL_OUTPUT_HEADING);
    expect(core).toContain(
      "partial.trim() === '' ? '' : `\\n${PARTIAL_OUTPUT_HEADING}\\n${partial}`",
    );
    expect(core).toContain('toolRefusal(SUBAGENT_MAX_TOKENS_REASON + text');
    const events = read('harness/packages/nexus-core/src/tool-events.ts');
    expect(events).toContain("TOOL_ERROR_PREFIX = 'Error: '");
    expect(events).toContain('return errorResult(TOOL_ERROR_PREFIX + reason, options);');
  });

  it('計劃模式：工具名、關掉審核、繼續規劃的兩種說法', () => {
    expect(EXIT_PLAN_MODE_TOOL_NAME).toBe(PLAN_TOOL);
    expect(PLAN_REVIEW_DISMISSED_MESSAGE).toBe(PLAN_DISMISSED);
    expect(PLAN_KEEP_PLANNING_MESSAGE).toBe(PLAN_KEEP);
    expect(planFeedbackMessage('先別動 API')).toBe(`${PLAN_FEEDBACK_PREFIX}先別動 API`);
  });
});

describe('wire 的 harness 事實：工具目錄', () => {
  const text = read('docs/tool-catalog.md');
  const names = [...text.matchAll(/^### `([^`]+)`$/gmu)].map((match) => match[1] ?? '');

  it('名單與 docs/tool-catalog.md 的 `###` 標題一致（含順序）', () => {
    expect(names.length).toBeGreaterThan(0);
    expect([...MODEL_TOOL_NAMES]).toEqual(names);
  });

  it('web 認工具靠的字串都在目錄那一節裡', () => {
    for (const [name, needles] of Object.entries(MODEL_TOOL_TEXT)) {
      const start = text.indexOf(`### \`${name}\``);
      expect(start, `目錄裡沒有 ${name}`).toBeGreaterThanOrEqual(0);
      const end = text.indexOf('\n### ', start + 1);
      const section = text.slice(start, end < 0 ? undefined : end);
      for (const needle of needles)
        expect(section, `${name} 那一節沒有 ${needle}`).toContain(needle);
    }
  });
});

describe('wire 的 harness 事實：命令文法', () => {
  const registered = COMMAND_GRAMMAR_DESCRIPTORS.map((descriptor) =>
    normalizeCommandDefinition({
      name: descriptor.name,
      description: descriptor.description,
      ...(descriptor.input === undefined ? {} : { input: descriptor.input }),
      ...(descriptor.runWhileBusy === undefined ? {} : { runWhileBusy: descriptor.runWhileBusy }),
      handler: () => ({ kind: 'success' }),
    }),
  );
  const find = {
    find: (name: string) => registered.find((r) => r.definition.name === name)?.definition,
  };

  it('清單就是登記表會送出的 descriptor', () => {
    expect(registered.map((r) => r.descriptor)).toEqual([...COMMAND_GRAMMAR_DESCRIPTORS]);
  });

  it.each(COMMAND_TOKEN_CASES)('parseCommand(%j) 認出 %s', (line, name) => {
    expect(parseCommand(line.trim())?.name).toBe(name);
  });

  it.each(RUNS_WHILE_BUSY_CASES)('runsWhileBusy(%j) 是 %s', (line, runs) => {
    expect(runsWhileBusy(find, line)).toBe(runs);
  });

  it('對照組裡兩種結果都有，不是全部同一個答案碰巧一致', () => {
    expect(COMMAND_TOKEN_CASES.some(([, name]) => name !== undefined)).toBe(true);
    expect(COMMAND_TOKEN_CASES.some(([, name]) => name === undefined)).toBe(true);
    expect(RUNS_WHILE_BUSY_CASES.some(([, runs]) => runs)).toBe(true);
    expect(RUNS_WHILE_BUSY_CASES.some(([, runs]) => !runs)).toBe(true);
  });
});
