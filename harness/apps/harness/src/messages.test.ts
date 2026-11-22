import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { toAgentInvocation } from './messages.js';

describe('toAgentInvocation', () => {
  it('字串當成使用者說的話', () => {
    const { messages } = toAgentInvocation('嗨。');

    expect(messages).toHaveLength(1);
    expect(HumanMessage.isInstance(messages[0])).toBe(true);
    expect(messages[0]?.text).toBe('嗨。');
  });

  it('已經是訊息的原樣通過，角色不被猜', () => {
    const { messages } = toAgentInvocation([new SystemMessage('你是助手。'), '嗨。']);

    expect(SystemMessage.isInstance(messages[0])).toBe(true);
    expect(HumanMessage.isInstance(messages[1])).toBe(true);
  });

  it('混合的一串依原順序保留', () => {
    const { messages } = toAgentInvocation(['第一句', new AIMessage('好的'), '第二句']);

    expect(messages.map((message) => message.text)).toEqual(['第一句', '好的', '第二句']);
  });

  it('字串前後空白去掉', () => {
    expect(toAgentInvocation('  嗨。  ').messages[0]?.text).toBe('嗨。');
  });

  it('空輸入直接失敗', () => {
    expect(() => toAgentInvocation('')).toThrow('輸入是空的');
    expect(() => toAgentInvocation('   ')).toThrow('輸入是空的');
    expect(() => toAgentInvocation([])).toThrow('輸入是空的');
    expect(() => toAgentInvocation(['', '  '])).toThrow('輸入是空的');
  });
});
