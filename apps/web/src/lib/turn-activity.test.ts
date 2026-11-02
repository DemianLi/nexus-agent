import {
  type AiEntry,
  type ConversationEntry,
  type ConversationState,
  emptyConversation,
  type HumanEntry,
  type ToolEntry,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { turnActivity } from '@/lib/turn-activity';

/**
 * 狀態列執行中那一列的 glyph 畫哪一種（#1684 驗收 B）：判的順序照 `turn-activity.ts` 檔頭（PM 2026-10-19 接受）。
 * 每一條對到一行規則，拿掉那一行就紅（PR 內文有突變表）。
 */

const SUBAGENT = { kind: 'subagent', name: 'worker', callId: 'call_task' } as const;

function human(text = '幫我找檔'): HumanEntry {
  return { kind: 'human', id: `human-${text}`, text };
}

function ai(patch: Partial<AiEntry> = {}): AiEntry {
  return {
    kind: 'ai',
    id: 'ai-1',
    text: '',
    streaming: true,
    attribution: { kind: 'root' },
    ...patch,
  };
}

function tool(name: string, patch: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: 'tool',
    id: `tool-${name}`,
    callId: `call_${name}`,
    name,
    input: '{}',
    status: 'running',
    attribution: { kind: 'root' },
    ...patch,
  };
}

/** 一輪在跑：`turnStart` 指到 `earlier` 之後。 */
function running(
  entries: readonly ConversationEntry[],
  earlier: readonly ConversationEntry[] = [],
  patch: Partial<ConversationState> = {},
): ConversationState {
  return {
    ...emptyConversation(),
    status: 'running',
    entries: [...earlier, ...entries],
    turnStart: earlier.length,
    ...patch,
  };
}

const RETRY = { retryId: 'r1', retry: 1, maxRetries: 3, delayMs: 2000, code: 'TIMEOUT' };

describe('turnActivity', () => {
  it('搜尋類的工具在跑：searching', () => {
    expect(turnActivity(running([human(), ai({ streaming: false }), tool('grep')]))).toBe(
      'searching',
    );
  });

  it('其他工具在跑：running', () => {
    expect(turnActivity(running([human(), ai({ streaming: false }), tool('execute')]))).toBe(
      'running',
    );
  });

  it('平行的工具裡有一顆是搜尋、一顆不是：running', () => {
    expect(turnActivity(running([human(), tool('grep'), tool('execute')]))).toBe('running');
  });

  it('平行的工具全是搜尋：searching', () => {
    expect(turnActivity(running([human(), tool('grep'), tool('glob')]))).toBe('searching');
  });

  it('平行工具最後一顆先完成、前面一顆還在跑：照還在跑的那顆，不是最後一則', () => {
    expect(
      turnActivity(running([human(), tool('execute'), tool('grep', { status: 'done' })])),
    ).toBe('running');
  });

  it('回覆串流中、正文不是空的：writing', () => {
    expect(turnActivity(running([human(), ai({ text: '找到三個檔' })]))).toBe('writing');
  });

  it('回覆串流中只有推理、還沒有正文：thinking', () => {
    expect(turnActivity(running([human(), ai({ reasoning: '先列目錄', text: '  ' })]))).toBe(
      'thinking',
    );
  });

  it('本輪什麼都還沒有：thinking', () => {
    expect(turnActivity(running([human()]))).toBe('thinking');
  });

  it('工具剛完成、下一次回覆還沒開始：thinking', () => {
    expect(turnActivity(running([human(), tool('execute', { status: 'done', text: 'ok' })]))).toBe(
      'thinking',
    );
  });

  it('在等重打：thinking，就算上一則是串流中有正文的回覆', () => {
    expect(turnActivity(running([human(), ai({ text: '寫到一半' })], [], { retry: RETRY }))).toBe(
      'thinking',
    );
  });

  it('子代理那幾則不看：子代理的工具在跑、回覆在串，root 這邊照 root 的', () => {
    expect(
      turnActivity(
        running([
          human(),
          ai({ id: 'ai-root', streaming: false }),
          tool('grep', { attribution: SUBAGENT }),
          ai({ id: 'ai-sub', text: '子代理在寫', attribution: SUBAGENT }),
        ]),
      ),
    ).toBe('thinking');
  });

  it('歸屬不明的也不看', () => {
    expect(
      turnActivity(
        running([
          human(),
          tool('execute', { attribution: { kind: 'unattributed', namespace: ['tools:x'] } }),
        ]),
      ),
    ).toBe('thinking');
  });

  it('前景子代理跑著時：root 的 task 還在跑，所以是 running', () => {
    expect(
      turnActivity(
        running([human(), tool('task'), ai({ text: '子代理在寫', attribution: SUBAGENT })]),
      ),
    ).toBe('running');
  });

  it('只看本輪：上一輪留下的工具與回覆不算', () => {
    expect(
      turnActivity(
        running(
          [human('再一次')],
          [human(), tool('grep', { status: 'running' }), ai({ text: '上一輪', streaming: true })],
        ),
      ),
    ).toBe('thinking');
  });
});
