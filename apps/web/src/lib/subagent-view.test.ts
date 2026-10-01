import type { Attribution, ConversationEntry, ToolEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  agentMessageCaption,
  canSendToSubagent,
  canStopSubagent,
  sendMessageSummary,
  sendMessageTitle,
  subagentLabel,
  subagentNames,
  subagentPlaceholder,
  subagentRunState,
  subagentSendError,
  UNKNOWN_SUBAGENT_LABEL,
} from './subagent-view';

function tool(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    kind: 'tool',
    id: 'tool-1',
    callId: 'call-1',
    name: 'subagent',
    input: '{}',
    status: 'done',
    attribution: { kind: 'root' },
    ...overrides,
  };
}

const delegated = (runId: string, subagentType: string, name = 'subagent'): ToolEntry =>
  tool({
    id: `tool-${runId}`,
    callId: `call-${runId}`,
    name,
    meta: { kind: 'background-subagent', runId, subagentType },
  });

describe('subagentNames', () => {
  it('從背景委派卡的 meta 收編號與名字；前景的、沒有 meta 的、別的工具都不收', () => {
    const entries: ConversationEntry[] = [
      delegated('bg-1', 'researcher'),
      delegated('bg-2', 'reviewer', 'task'),
      tool({ id: 'fg', name: 'task' }),
      tool({
        id: 'other',
        name: 'echo',
        meta: { kind: 'background-subagent', runId: 'bg-9', subagentType: 'x' },
      }),
    ];
    expect([...subagentNames(entries)]).toEqual([
      ['bg-1', 'researcher'],
      ['bg-2', 'reviewer'],
    ]);
  });
});

describe('subagentLabel', () => {
  const names = new Map([['bg-1', 'researcher']]);

  it('對得到就是名字，對不到（重新整理後委派卡不在）就說背景子代理，不猜', () => {
    expect(subagentLabel(names, 'bg-1')).toBe('researcher');
    expect(subagentLabel(names, 'bg-404')).toBe(UNKNOWN_SUBAGENT_LABEL);
    expect(subagentLabel(new Map([['bg-1', '']]), 'bg-1')).toBe(UNKNOWN_SUBAGENT_LABEL);
  });

  it('來信上面那一行', () => {
    expect(agentMessageCaption('researcher')).toBe('researcher 說');
  });
});

describe('send_message 的標題與摘要：同一個工具兩個方向', () => {
  const names = new Map([['bg-1', 'researcher']]);
  const root: Attribution = { kind: 'root' };
  const fromSubagent: Attribution = { kind: 'subagent', name: 'researcher', callId: 'c' };

  it('主對話傳給子代理：傳給誰（從委派卡對回名字）、訊息的第一行', () => {
    expect(sendMessageTitle(root)).toBe('傳訊給子代理');
    expect(sendMessageSummary('{"agent_id":"bg-1","message":"先看 A\\n再看 B"}', root, names)).toBe(
      '傳給 researcher：先看 A',
    );
  });

  it('編號對不到名字：說背景子代理，不把 bg-… 的編號端出來', () => {
    const summary = sendMessageSummary('{"agent_id":"bg-7","message":"嗨"}', root, names);
    expect(summary).toBe(`傳給 ${UNKNOWN_SUBAGENT_LABEL}：嗨`);
    expect(summary).not.toContain('bg-7');
  });

  it('子代理回報給主對話：標題與摘要都說主對話，不拿主對話的編號去對名字', () => {
    expect(sendMessageTitle(fromSubagent)).toBe('傳訊給主對話');
    expect(
      sendMessageSummary('{"agent_id":"root-session","message":"做完了"}', fromSubagent, names),
    ).toBe('傳給 主對話：做完了');
  });

  it('參數形狀不對（串流中途截斷、缺欄位、空白訊息）：沒有摘要，卡片退回通用的', () => {
    for (const input of ['{"agent_id":"bg-1","mess', '{"agent_id":"bg-1"}', '{"message":"嗨"}']) {
      expect(sendMessageSummary(input, root, names)).toBeUndefined();
    }
    expect(sendMessageSummary('{"agent_id":"bg-1","message":"  "}', root, names)).toBeUndefined();
    expect(sendMessageSummary('null', root, names)).toBeUndefined();
  });
});

describe('背景子代理的狀態與輸入框（#869）', () => {
  it('還沒收到快照是 unknown，收過而不在裡面是 closed', () => {
    expect(subagentRunState(null, 'bg-1')).toBe('unknown');
    expect(subagentRunState({}, 'bg-1')).toBe('closed');
    expect(subagentRunState({ 'bg-1': 'running' }, 'bg-1')).toBe('running');
    expect(subagentRunState({ 'bg-1': 'idle' }, 'bg-1')).toBe('idle');
    expect(subagentRunState({ 'bg-2': 'idle' }, 'bg-1')).toBe('closed');
  });

  it('佔位字：跑著與未知一樣，閒著說會喚醒，收線說結束', () => {
    expect(subagentPlaceholder('running')).toBe(subagentPlaceholder('unknown'));
    expect(subagentPlaceholder('idle')).toContain('喚醒');
    expect(subagentPlaceholder('closed')).toContain('結束');
  });

  it('只有收線或斷線才不能送；停止只在跑著（含未知）可按', () => {
    expect(canSendToSubagent('running', true)).toBe(true);
    expect(canSendToSubagent('idle', true)).toBe(true);
    expect(canSendToSubagent('unknown', true)).toBe(true);
    expect(canSendToSubagent('closed', true)).toBe(false);
    expect(canSendToSubagent('running', false)).toBe(false);
    expect(canStopSubagent('running')).toBe(true);
    expect(canStopSubagent('unknown')).toBe(true);
    expect(canStopSubagent('idle')).toBe(false);
    expect(canStopSubagent('closed')).toBe(false);
  });

  it('四個錯誤碼各一句，認不得的碼帶伺服器的話', () => {
    const lines = [
      'subagent_not_found',
      'subagent_at_capacity',
      'subagent_closed',
      'invalid_argument',
    ].map((code) => subagentSendError(code, 'x'));
    expect(new Set(lines).size).toBe(4);
    expect(lines.join('')).not.toContain('x');
    expect(subagentSendError('internal_error', '壞了')).toContain('壞了');
  });
});
