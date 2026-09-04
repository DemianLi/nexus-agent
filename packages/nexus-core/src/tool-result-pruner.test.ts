import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  assertToolResultPruneConfig,
  codePointLength,
  DEFAULT_TOOL_RESULT_PRUNE,
  measureToolResultContent,
  pruneToolResultContent,
  pruneToolResults,
  TOOL_RESULT_PRUNE_MARKER,
} from './tool-result-pruner.js';
import type { ToolResultPruneConfig } from './tool-result-pruner.js';

/** 一組小到測試讀得懂的預算。頭尾加標記剛好塞得進門檻。 */
const SMALL: ToolResultPruneConfig = {
  thresholdChars: 100,
  headChars: 20,
  tailChars: 10,
};

const MARKER_CHARS = codePointLength(TOOL_RESULT_PRUNE_MARKER);

function toolMessage(content: string, id = 'call-1'): ToolMessage {
  return new ToolMessage({ content, tool_call_id: id, name: 'grep', status: 'error' });
}

describe('預算的驗證', () => {
  it('dsh 的預設值自己過得了驗證', () => {
    expect(assertToolResultPruneConfig(DEFAULT_TOOL_RESULT_PRUNE)).toBe(DEFAULT_TOOL_RESULT_PRUNE);
  });

  it('頭尾加標記塞不進門檻就當場拋', () => {
    expect(() =>
      assertToolResultPruneConfig({ thresholdChars: 30, headChars: 20, tailChars: 10 }),
    ).toThrow(/thresholdChars/);
  });

  /** 這一條擋的是「剪完比原本還大」——dsh 把它移到設定層，我們照抄。 */
  it('標記本身也算進頭尾預算', () => {
    const threshold = 20 + 10 + MARKER_CHARS;
    expect(() =>
      assertToolResultPruneConfig({ thresholdChars: threshold, headChars: 20, tailChars: 10 }),
    ).not.toThrow();
    expect(() =>
      assertToolResultPruneConfig({ thresholdChars: threshold - 1, headChars: 20, tailChars: 10 }),
    ).toThrow();
  });

  it('非整數與負數都擋', () => {
    expect(() => assertToolResultPruneConfig({ ...SMALL, thresholdChars: 0 })).toThrow(
      /thresholdChars/,
    );
    expect(() => assertToolResultPruneConfig({ ...SMALL, headChars: -1 })).toThrow(/headChars/);
    expect(() => assertToolResultPruneConfig({ ...SMALL, tailChars: 1.5 })).toThrow(/tailChars/);
  });
});

describe('剪一則內容', () => {
  it('沒超過門檻回 null——呼叫端據此判斷「一字不動」', () => {
    expect(pruneToolResultContent('短'.repeat(100), SMALL)).toBeNull();
  });

  it('剛好等於門檻也不剪', () => {
    expect(pruneToolResultContent('x'.repeat(SMALL.thresholdChars), SMALL)).toBeNull();
  });

  it('剪出來是頭 ＋ 標記 ＋ 尾，而且落在門檻內', () => {
    const head = 'H'.repeat(SMALL.headChars);
    const middle = 'M'.repeat(500);
    const tail = 'T'.repeat(SMALL.tailChars);
    const pruned = pruneToolResultContent(head + middle + tail, SMALL);

    expect(pruned).toBe(head + TOOL_RESULT_PRUNE_MARKER + tail);
    expect(measureToolResultContent(pruned!)).toBeLessThanOrEqual(SMALL.thresholdChars);
    expect(String(pruned)).toContain(TOOL_RESULT_PRUNE_MARKER);
  });

  /**
   * **這一條是 code point 與 UTF-16 code unit 的差別。**
   *
   * `'😀'.length` 是 2。用 `.length` 切 20 個「字元」會切在第 10 個 emoji 的中間，剪出來
   * 的頭尾各帶一個孤兒 surrogate（`\uD83D` / `\uDE00`）。這條測試釘住我們數的是 code
   * point：切點永遠落在完整的 emoji 邊界上。
   */
  it('切點不會劈開代理對', () => {
    const pruned = pruneToolResultContent('😀'.repeat(200), SMALL);
    const text = String(pruned);

    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(text.startsWith('😀'.repeat(SMALL.headChars))).toBe(true);
    expect(text.endsWith('😀'.repeat(SMALL.tailChars))).toBe(true);
  });

  it('非文字區塊原序保留、而且不計費', () => {
    const content = [
      { type: 'text', text: 'A'.repeat(200) },
      { type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } },
      { type: 'text', text: 'B'.repeat(200) },
    ];
    expect(measureToolResultContent(content)).toBe(400);

    const pruned = pruneToolResultContent(content, SMALL);
    expect(Array.isArray(pruned)).toBe(true);
    const blocks = pruned as { type: string }[];
    expect(blocks.map((block) => block.type)).toEqual(['text', 'image_url', 'text']);
    expect(blocks[1]).toEqual(content[1]);
  });

  it('頭尾落在不同區塊時，標記只插一次', () => {
    const content = [
      { type: 'text', text: 'A'.repeat(200) },
      { type: 'text', text: 'B'.repeat(200) },
    ];
    const pruned = pruneToolResultContent(content, SMALL) as { text: string }[];
    const joined = pruned.map((block) => block.text).join('');

    expect(joined.split(TOOL_RESULT_PRUNE_MARKER)).toHaveLength(2);
    expect(joined.startsWith('A'.repeat(SMALL.headChars))).toBe(true);
    expect(joined.endsWith('B'.repeat(SMALL.tailChars))).toBe(true);
  });
});

describe('剪一整串訊息', () => {
  /**
   * **長度與順序不准變，這是一條性質不是一個偏好。**
   *
   * 基座的 `getEffectiveMessages` 是 `[summary, ...messages.slice(cutoffIndex)]`，而那個
   * `cutoffIndex` 是前幾輪算出來存在 state 裡的。少一則訊息，slice 就切在錯的地方，
   * AI／Tool 配對當場斷掉——**而且不會拋**。
   */
  it('訊息數與型別順序完全不變', () => {
    const messages = [
      new HumanMessage('找一下。'),
      new AIMessage({ content: '', tool_calls: [{ name: 'grep', args: {}, id: 'call-1' }] }),
      toolMessage('X'.repeat(5000)),
      new AIMessage('找到了。'),
    ];
    const { messages: next, prunedCount } = pruneToolResults(messages, SMALL);

    expect(prunedCount).toBe(1);
    expect(next).toHaveLength(messages.length);
    expect(next.map((message) => message.getType())).toEqual([
      'human',
      'ai',
      'tool',
      'ai',
    ]);
  });

  it('只換 content，其餘欄位原樣帶過', () => {
    const original = toolMessage('X'.repeat(5000), 'call-42');
    const [pruned] = pruneToolResults([original], SMALL).messages as ToolMessage[];

    expect(pruned!.tool_call_id).toBe('call-42');
    expect(pruned!.name).toBe('grep');
    expect(pruned!.status).toBe('error');
    expect(pruned!.content).not.toBe(original.content);
  });

  /** 對照組：巨大的 human message 不是工具結果，一個字都不准動。 */
  it('不是工具結果的訊息一律不碰', () => {
    const messages = [new HumanMessage('X'.repeat(50_000))];
    const result = pruneToolResults(messages, SMALL);

    expect(result.prunedCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it('沒有一則超標時，回的就是原本那個陣列', () => {
    const messages = [toolMessage('短')];
    expect(pruneToolResults(messages, SMALL).messages).toBe(messages);
  });

  it('帳目對得上', () => {
    const original = toolMessage('X'.repeat(5000));
    const { charsRemoved, messages } = pruneToolResults([original], SMALL);
    const after = measureToolResultContent(messages[0]!.content);

    expect(charsRemoved).toBe(5000 - after);
    expect(after).toBe(SMALL.headChars + MARKER_CHARS + SMALL.tailChars);
  });

  it('預設預算就是 dsh 的那組', () => {
    expect(DEFAULT_TOOL_RESULT_PRUNE).toEqual({
      thresholdChars: 8192,
      headChars: 4096,
      tailChars: 1024,
    });
    // 不給 config 時走的就是它。
    expect(pruneToolResults([toolMessage('X'.repeat(8192))]).prunedCount).toBe(0);
    expect(pruneToolResults([toolMessage('X'.repeat(8193))]).prunedCount).toBe(1);
  });
});
