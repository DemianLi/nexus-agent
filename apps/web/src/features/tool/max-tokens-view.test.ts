import {
  PARTIAL_OUTPUT_HEADING as WIRE_PARTIAL_OUTPUT_HEADING,
  SUBAGENT_MAX_TOKENS_REASON as WIRE_SUBAGENT_MAX_TOKENS_REASON,
} from '@nexus/wire';
import type { ToolEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  PARTIAL_OUTPUT_HEADING,
  SUBAGENT_MAX_TOKENS_REASON,
  subagentMaxTokensOf,
} from '@/features/tool/max-tokens-view';

const HEADLINE = `Error: ${SUBAGENT_MAX_TOKENS_REASON}`;

function task(patch: Partial<ToolEntry>): ToolEntry {
  return {
    kind: 'tool',
    id: 'tool-task',
    callId: 'call_task',
    name: 'task',
    input: '{"description":"寫報告","subagent_type":"worker"}',
    status: 'failed',
    error: HEADLINE,
    attribution: { kind: 'root' },
    ...patch,
  };
}

describe('子代理撞到輸出上限的 task', () => {
  it('抄來的字跟 wire 對得上（wire 的值與組法跟 core 一致由 harness 的 `wire-harness-facts.test.ts` 釘住；core 改字先紅的是那一格，這一格紅的是 web 的抄本跟 wire 不一致）', () => {
    expect(WIRE_SUBAGENT_MAX_TOKENS_REASON).toBe(SUBAGENT_MAX_TOKENS_REASON);
    expect(WIRE_PARTIAL_OUTPUT_HEADING).toBe(PARTIAL_OUTPUT_HEADING);
  });

  it('寫了一半：帶出那一段，多行照原樣', () => {
    expect(
      subagentMaxTokensOf(
        task({ error: `${HEADLINE}\n${PARTIAL_OUTPUT_HEADING}\n報告\n寫到一半` }),
      ),
    ).toEqual({ partial: '報告\n寫到一半' });
  });

  it('委派工具兩個名字都認：`subagent` 前景撞上限時，root 那張卡的名字是它', () => {
    expect(subagentMaxTokensOf(task({ name: 'subagent' }))).toEqual({ partial: '' });
    expect(subagentMaxTokensOf(task({ name: 'task' }))).toEqual({ partial: '' });
  });

  it('一個字都沒寫：只有那一句，寫到一半的是空的', () => {
    expect(subagentMaxTokensOf(task({}))).toEqual({ partial: '' });
  });

  it('別的失敗、別的工具、沒失敗、措辭認不出來的都不算', () => {
    expect(subagentMaxTokensOf(task({ error: 'Error: 子代理不存在' }))).toBeUndefined();
    expect(subagentMaxTokensOf(task({ name: 'echo' }))).toBeUndefined();
    expect(subagentMaxTokensOf(task({ status: 'done', error: undefined }))).toBeUndefined();
    expect(subagentMaxTokensOf(task({ error: `${HEADLINE}，而且別的` }))).toBeUndefined();
    expect(subagentMaxTokensOf(task({ error: `${HEADLINE}\n別的東西` }))).toBeUndefined();
  });
});
