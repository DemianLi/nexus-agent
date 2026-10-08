import { describe, expect, it } from 'vitest';

import {
  agentRows,
  agentsFromKinds,
  applyAgentPick,
  toMention,
  type MentionAgent,
} from '@/lib/agent-mention';

/** `@子代理` 提及的純規則（#328 第 2 項）。 */

const agents: readonly MentionAgent[] = [
  { id: 'a', name: 'Explorer', description: '唯讀地探索程式碼' },
  { id: 'b', name: 'reviewer', description: '審查變更' },
  { id: 'c', name: 'tester', description: '補測試，順便 EXPLORE 邊界' },
];

describe('server 的種類換成選單用的', () => {
  it('註冊的名字就是身分，說明照帶，順序不動', () => {
    expect(
      agentsFromKinds([
        { name: 'explorer', description: '探索' },
        { name: 'reviewer', description: '審查' },
      ]),
    ).toEqual([
      { id: 'explorer', name: 'explorer', description: '探索' },
      { id: 'reviewer', name: 'reviewer', description: '審查' },
    ]);
    expect(agentsFromKinds([])).toEqual([]);
  });

  it('選中的換成 run.start 的 mention：只有種類與名字，沒有說明', () => {
    expect(toMention(agents[1]!)).toEqual({ kind: 'subagent', name: 'reviewer' });
  });
});

describe('agentRows', () => {
  it('查詢是空的就全列，照清單順序，說明放在 hint', () => {
    const rows = agentRows(agents, '');
    expect(rows.map((row) => row.name)).toEqual(['Explorer', 'reviewer', 'tester']);
    expect(rows[1]).toEqual({
      source: 'agent',
      agent: agents[1],
      name: 'reviewer',
      hint: '審查變更',
    });
  });

  it('名字或說明含查詢就留，不分大小寫', () => {
    expect(agentRows(agents, 'EXPL').map((row) => row.agent.id)).toEqual(['a', 'c']);
    expect(agentRows(agents, 'rev').map((row) => row.agent.id)).toEqual(['b']);
    expect(agentRows(agents, '審查').map((row) => row.agent.id)).toEqual(['b']);
  });

  it('查詢前後的空白不算；沒有符合的回空', () => {
    expect(agentRows(agents, ' rev ')).toHaveLength(1);
    expect(agentRows(agents, '沒有這個')).toEqual([]);
  });
});

describe('applyAgentPick', () => {
  const hit = (start: number, end: number) => ({ query: '', quoted: false, start, end });

  it('整份草稿只有 @ 那一段：選完草稿是空的', () => {
    expect(applyAgentPick('@ex', hit(0, 3))).toEqual({ draft: '', caret: 0 });
  });

  it('@ 在句子中間：只拿掉那一段，前後的空白不留兩個', () => {
    // 「請 @ex 看」→「請 看」，不是「請  看」。
    expect(applyAgentPick('請 @ex 看', hit(2, 5))).toEqual({ draft: '請 看', caret: 2 });
  });

  it('@ 在字首、後面接空白：後面那個空白一起收', () => {
    expect(applyAgentPick('@ex 看這個', hit(0, 3))).toEqual({ draft: '看這個', caret: 0 });
  });

  it('@ 前面是字（不是空白）時後面的空白留著，不把前後兩個字黏在一起', () => {
    // detectMention 要求 @ 在字首或空白後面，這裡直接餵一個前面是字的位置，釘「只在前面是空白或字首才收」。
    expect(applyAgentPick('甲@ex 乙', hit(1, 4))).toEqual({ draft: '甲 乙', caret: 1 });
  });

  it('@ 在句尾：後面沒有東西可收', () => {
    expect(applyAgentPick('看一下 @ex', hit(4, 7))).toEqual({ draft: '看一下 ', caret: 4 });
  });
});
