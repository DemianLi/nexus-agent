/**
 * 撞到輸出上限那一層自己的規則（#433）。真的轉接器、真的組裝與兩條產品路徑在
 * `apps/harness/src/max-tokens.test.ts`。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { toLoggedMessage } from './logged-message.js';
import {
  createMaxTokensCarrier,
  dropToolCalls,
  isMaxTokensFinish,
  SUBAGENT_MAX_TOKENS_REASON,
  subagentMaxTokensResult,
  turnReachedMaxTokens,
} from './max-tokens.js';
import { SessionLog } from './session-log.js';

describe('哪些 finish_reason 算撞到上限', () => {
  it.each([
    ['length', true],
    ['max_tokens', true],
    ['stop', false],
    ['tool_calls', false],
    ['tool_use', false],
  ])('%s → %s', (reason, expected) => {
    expect(isMaxTokensFinish({ finish_reason: reason })).toBe(expected);
  });

  it('沒有這一格、不是物件：不算', () => {
    expect(isMaxTokensFinish({})).toBe(false);
    expect(isMaxTokensFinish(undefined)).toBe(false);
    expect(isMaxTokensFinish('length')).toBe(false);
  });
});

describe('清掉工具呼叫', () => {
  it('四處都清：tool_calls、invalid_tool_calls、additional_kwargs.tool_calls、content 裡的呼叫區塊', () => {
    const cut = new AIMessage({
      id: 'msg-1',
      content: [
        { type: 'reasoning', reasoning: '先查兩處' },
        { type: 'text', text: '我先查。' },
        { type: 'tool_call', id: 'call_ok', name: 'echo', args: { text: 'a' } },
        { type: 'invalid_tool_call', id: 'call_cut', name: 'echo', args: '{"text": "嗨' },
      ] as AIMessage['content'],
      tool_calls: [{ id: 'call_ok', name: 'echo', args: { text: 'a' }, type: 'tool_call' }],
      invalid_tool_calls: [
        {
          id: 'call_cut',
          name: 'echo',
          args: '{"text": "嗨',
          error: 'bad',
          type: 'invalid_tool_call',
        },
      ],
      additional_kwargs: {
        tool_calls: [
          {
            id: 'call_ok',
            type: 'function',
            function: { name: 'echo', arguments: '{"text":"a"}' },
          },
        ],
        reasoning_content: '先查兩處',
      },
      response_metadata: { finish_reason: 'length', model_name: 'fake' },
      usage_metadata: { input_tokens: 3, output_tokens: 16, total_tokens: 19 },
    });
    const dropped = dropToolCalls(cut);
    expect(dropped.tool_calls).toEqual([]);
    expect(dropped.invalid_tool_calls).toEqual([]);
    expect(dropped.additional_kwargs).toEqual({ reasoning_content: '先查兩處' });
    expect(dropped.content).toEqual([
      { type: 'reasoning', reasoning: '先查兩處' },
      { type: 'text', text: '我先查。' },
    ]);
    // 判準讀的就是這一格，清掉的話日誌上的截斷就沒了。
    expect(dropped.response_metadata).toEqual({ finish_reason: 'length', model_name: 'fake' });
    expect(dropped.usage_metadata).toEqual(cut.usage_metadata);
    expect(dropped.id).toBe('msg-1');
  });

  it('本來就沒有呼叫的原樣回傳同一則', () => {
    const plain = new AIMessage({
      content: '只講話',
      response_metadata: { finish_reason: 'length' },
    });
    expect(dropToolCalls(plain)).toBe(plain);
  });
});

describe('這一輪有沒有撞到上限（root 日誌）', () => {
  function reply(finish: string): { message: ReturnType<typeof toLoggedMessage> } {
    return {
      message: toLoggedMessage(
        new AIMessage({ content: '…', response_metadata: { finish_reason: finish } }),
      ),
    };
  }

  it('sticky：前一步撞到、後一步正常收，照樣算', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '做' });
    log.append('assistant/message', reply('length'));
    log.append('assistant/message', reply('stop'));
    expect(turnReachedMaxTokens(log.events)).toBe(true);
  });

  it('只看當前這一輪：上一輪撞過不算到這一輪頭上', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '做' });
    log.append('assistant/message', reply('length'));
    log.append('turn/end', { reason: { kind: 'max-tokens' } });
    log.append('turn/start', { kind: 'message', text: '再做' });
    log.append('assistant/message', reply('stop'));
    expect(turnReachedMaxTokens(log.events)).toBe(false);
  });

  it('一輪都還沒開始：不算', () => {
    expect(turnReachedMaxTokens([])).toBe(false);
  });
});

describe('子代理撞到上限時 task 的結果', () => {
  const HEADLINE = `Error: ${SUBAGENT_MAX_TOKENS_REASON}`;

  it('逐字照 dsh：錯誤一句，後面接已經寫出的那段；status 是 error、不帶碼', () => {
    const result = subagentMaxTokensResult(
      new ToolMessage({ content: '寫到一半', tool_call_id: 'call_task', name: 'task' }),
      'call_task',
      '寫到一半',
    ) as ToolMessage;
    expect(result.content).toBe(`${HEADLINE}\nPartial output before the run ended:\n寫到一半`);
    expect(result.status).toBe('error');
    expect(result.tool_call_id).toBe('call_task');
  });

  it('一個字都沒寫：只有那一句', () => {
    const result = subagentMaxTokensResult(undefined, 'call_task', '  ') as ToolMessage;
    expect(result.content).toBe(HEADLINE);
  });

  /**
   * 基座的 `task` 回 `Command`，裡面還有子代理寫進 state 的檔案——那是真的做了的事。
   * 只換這次呼叫的那則 ToolMessage，其餘原樣；跟著一起塞進對話的別則訊息也留著。
   */
  it('Command 只換這次呼叫的那則，state 的其餘欄位原樣', () => {
    const injected = new HumanMessage('外掛塞的');
    const original = new Command({
      update: {
        files: { '/notes.md': { content: ['半份'] } },
        messages: [
          new ToolMessage({ content: 'Task completed', tool_call_id: 'call_task', name: 'task' }),
          injected,
        ],
      },
    });
    const result = subagentMaxTokensResult(original, 'call_task', '半份');
    expect(result).toBeInstanceOf(Command);
    const update = (result as Command).update as {
      files: unknown;
      messages: readonly unknown[];
    };
    expect(update.files).toEqual({ '/notes.md': { content: ['半份'] } });
    expect(update.messages).toHaveLength(2);
    expect(update.messages[0]).toBe(injected);
    const replaced = update.messages[1] as ToolMessage;
    expect(replaced.tool_call_id).toBe('call_task');
    expect(replaced.status).toBe('error');
    expect(String(replaced.content).startsWith(HEADLINE)).toBe(true);
  });
});

describe('載體', () => {
  it('取走就沒了；同一次 spawn 撞第二次蓋掉前一次', () => {
    const carrier = createMaxTokensCarrier();
    carrier.record('tools:a', '第一段');
    carrier.record('tools:a', '第二段');
    expect(carrier.take('tools:b')).toBeUndefined();
    expect(carrier.take('tools:a')).toBe('第二段');
    expect(carrier.take('tools:a')).toBeUndefined();
  });
});
