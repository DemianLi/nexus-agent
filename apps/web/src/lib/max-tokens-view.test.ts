import { readFileSync } from 'node:fs';

import type { ToolEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  PARTIAL_OUTPUT_HEADING,
  SUBAGENT_MAX_TOKENS_REASON,
  subagentMaxTokensOf,
} from '@/lib/max-tokens-view';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

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
  it('抄來的字跟 `@nexus/core` 對得上（web 不相依 core，改了那邊這裡要紅）', () => {
    const core = read('../../../../packages/nexus-core/src/max-tokens.ts');
    expect(/SUBAGENT_MAX_TOKENS_REASON = '([^']*)'/.exec(core)?.[1]).toBe(
      SUBAGENT_MAX_TOKENS_REASON,
    );
    expect(/PARTIAL_OUTPUT_HEADING = '([^']*)'/.exec(core)?.[1]).toBe(PARTIAL_OUTPUT_HEADING);
    // 組法：理由後面換行接標頭、再換行接寫到一半的那段；沒寫出字就不接。前綴由 toolRefusal 加。
    expect(core).toContain(
      "partial.trim() === '' ? '' : `\\n${PARTIAL_OUTPUT_HEADING}\\n${partial}`",
    );
    expect(core).toContain('toolRefusal(SUBAGENT_MAX_TOKENS_REASON + text');
    const events = read('../../../../packages/nexus-core/src/tool-events.ts');
    expect(events).toContain("TOOL_ERROR_PREFIX = 'Error: '");
    expect(events).toContain('return errorResult(TOOL_ERROR_PREFIX + reason, options);');
  });

  it('寫了一半：帶出那一段，多行照原樣', () => {
    expect(
      subagentMaxTokensOf(
        task({ error: `${HEADLINE}\n${PARTIAL_OUTPUT_HEADING}\n報告\n寫到一半` }),
      ),
    ).toEqual({ partial: '報告\n寫到一半' });
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
