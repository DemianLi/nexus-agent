/**
 * `tools` 那顆 frame 的分類：**「停下來等人」與「炸了」在基座眼裡是同一件事，這裡把它們分開。**
 *
 * 中斷是用拋例外實作的，所以基座的 tools 節點對一顆掛著的中斷發的是 `tool-error`，
 * `message` 裝著整顆 `GraphInterrupt` 的酬載（實測，[#239](https://github.com/DemianLi/nexus-agent/issues/239)）。
 * 下游因此把一個還沒被回答的問題畫成紅字「失敗」，還把那串 JSON 當錯誤訊息印給人看。
 *
 * **這一份守的是兩個相反的病**：漏放行（真的中斷還被當成失敗）與誤放行（真的錯誤被當成
 * 中斷吞掉）。只寫前者的話，一個「所有 `tool-error` 都改叫 suspended」的實作會全綠——
 * 而那會讓工具真的炸掉時畫面上什麼都不說。
 */

import { describe, expect, it } from 'vitest';

import { classifyToolData } from './thread-pump.js';

/** 一顆掛著的中斷在線上長的樣子，逐字照實測抄的。 */
const SUSPENSION = JSON.stringify([
  { id: '880178a2fcbb0c638921e69ad65174cd', value: { kind: 'question', questions: [] } },
]);

describe('掛著的中斷不是失敗', () => {
  it('`tool-error` 帶的是中斷酬載時，換成 `tool-suspended` **並且把 message 丟掉**', () => {
    const out = classifyToolData({
      event: 'tool-error',
      tool_call_id: 'call_1_0',
      message: SUSPENSION,
    }) as Record<string, unknown>;

    expect(out['event']).toBe('tool-suspended');
    // 丟掉不是裝飾：留著的話它會沿著 `error` 欄位一路印到畫面上。
    expect(out).not.toHaveProperty('message');
    // 其餘欄位原樣。
    expect(out['tool_call_id']).toBe('call_1_0');
  });

  it('**真的錯誤原樣穿過去**——訊息 parse 不成一串中斷條目', () => {
    const raw = { event: 'tool-error', tool_call_id: 'call_1_0', message: '工具自己炸了' };

    expect(classifyToolData(raw)).toBe(raw);
  });

  it('**一串 parse 得動但不是中斷條目的 JSON 也不算**', () => {
    // 判準是「認得出 id」，不是「parse 得動」。少了這一條，一個回傳 JSON 陣列的工具
    // 炸掉時會被當成中斷吞掉。
    const raw = { event: 'tool-error', tool_call_id: 'c', message: '[{"note":"沒有 id"}]' };

    expect(classifyToolData(raw)).toBe(raw);
  });
});

describe('收尾了不等於成功了', () => {
  it('ToolMessage 說自己 error 時補上 `failed` 與它的內容', () => {
    const out = classifyToolData({
      event: 'tool-finished',
      tool_call_id: 'call_1_0',
      output: { status: 'error', content: '人放棄了這一組問題' },
    }) as Record<string, unknown>;

    expect(out['failed']).toBe(true);
    expect(out['message']).toBe('人放棄了這一組問題');
  });

  it('序列化過的形狀也認得——**同一條線上有兩個位置讀得到它**', () => {
    const out = classifyToolData({
      event: 'tool-finished',
      tool_call_id: 'call_1_0',
      output: { kwargs: { status: 'error', content: '被拒絕了' } },
    }) as Record<string, unknown>;

    expect(out['failed']).toBe(true);
    expect(out['message']).toBe('被拒絕了');
  });

  it('**成功的結果原樣穿過去**，不會被補上 `failed`', () => {
    const raw = {
      event: 'tool-finished',
      tool_call_id: 'call_1_0',
      output: { status: 'success', content: '寫好了' },
    };

    expect(classifyToolData(raw)).toBe(raw);
  });

  it('不是 `tools` 那兩種事件的一律原樣', () => {
    const raw = { event: 'tool-started', tool_call_id: 'call_1_0', tool_name: 'take_note' };

    expect(classifyToolData(raw)).toBe(raw);
  });
});
