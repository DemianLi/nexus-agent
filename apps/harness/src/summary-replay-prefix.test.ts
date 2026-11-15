/**
 * 生摘要的那一次呼叫是上一次主請求的前綴（[#2775](https://github.com/DemianLi/nexus-agent/issues/2775)）。
 *
 * 真的 `ChatOpenAI` 打本機假端點，比的是線上的請求 body：`history-source: log` 時，摘要請求的工具與上一次主請求相同、
 * 訊息逐則相同到兩者較短的那一邊為止，最後一則是摘要指令；`state` 時維持模板（一則 user 訊息、不帶工具）。
 */
import { SUMMARY_INSTRUCTION } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { runAssembly } from './log-derived-history.fixture.js';
import type { Body, Script } from './log-derived-history.fixture.js';

const PAD = '這一句是用來把對話撐過摘要門檻的填充文字。'.repeat(400);
const LINES = `第一輪${PAD}\n第二輪${PAD}\n第三輪${PAD}\n第四輪${PAD}\n第五輪${PAD}\n/exit\n`;
const SUMMARIZATION = { trigger: [{ type: 'tokens' as const, value: 3_000 }], retainTokens: 12 };
const SUMMARY_TEXT = '## Primary Request and Intent\n- 使用者說了幾輪填充文字。';

const lastContent = (body: Body): unknown => body.messages.at(-1)?.content;
const isReplay = (body: Body): boolean => lastContent(body) === SUMMARY_INSTRUCTION;
const isTemplate = (body: Body): boolean => {
  const content = lastContent(body);
  return typeof content === 'string' && content.startsWith('Conversation to condense:');
};
const script: Script = (_index, body) =>
  isReplay(body) || isTemplate(body) ? { content: SUMMARY_TEXT } : {};

describe('生摘要的請求形狀', () => {
  it('log：摘要請求是上一次主請求的前綴，最後接摘要指令', async () => {
    const run = await runAssembly(LINES, script, [], SUMMARIZATION, 'log');
    const summaries = run.events.filter((event) => event.type === 'compaction/summary');
    expect(summaries.length).toBeGreaterThan(0);
    expect(run.bodies.filter(isTemplate)).toEqual([]);
    const replays = run.bodies.flatMap((body, index) => (isReplay(body) ? [index] : []));
    expect(replays.length).toBe(summaries.length);

    for (const at of replays) {
      const replay = run.bodies[at]!;
      const previous = run.bodies.slice(0, at).findLast((body) => !isReplay(body));
      expect(previous).toBeDefined();
      expect(replay.model).toBe(previous!.model);
      expect((replay.tools ?? []).length).toBeGreaterThan(0);
      expect(JSON.stringify(replay.tools)).toBe(JSON.stringify(previous!.tools));
      const replayed = replay.messages.slice(0, -1);
      const shared = Math.min(replayed.length, previous!.messages.length);
      // 系統訊息加至少一則對話，不然「前綴相同」是空話。
      expect(shared).toBeGreaterThanOrEqual(2);
      expect(replayed[0]!.role).toBe('system');
      expect(JSON.stringify(replayed.slice(0, shared))).toBe(
        JSON.stringify(previous!.messages.slice(0, shared)),
      );
      // 摘要接手：下一次主請求帶著這份摘要。
      const next = run.bodies.slice(at + 1).find((body) => !isReplay(body));
      expect(JSON.stringify(next?.messages)).toContain('使用者說了幾輪填充文字');
    }
  }, 120_000);

  it('state：維持模板，一則 user 訊息、不帶工具', async () => {
    const run = await runAssembly(LINES, script, [], SUMMARIZATION, 'state');
    const summaries = run.events.filter((event) => event.type === 'compaction/summary');
    expect(summaries.length).toBeGreaterThan(0);
    expect(run.bodies.filter(isReplay)).toEqual([]);
    const templates = run.bodies.filter(isTemplate);
    expect(templates.length).toBe(summaries.length);
    for (const body of templates) {
      expect(body.messages.length).toBe(1);
      expect(body.tools ?? []).toEqual([]);
    }
  }, 120_000);
});
