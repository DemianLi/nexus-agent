/**
 * 點名提示區塊（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）：造得出來、讀得回去，使用者自己打的字不會被誤認。
 */

import { describe, expect, it } from 'vitest';

import { userContent } from './message-source.js';
import {
  isMentionHintBlock,
  mentionHintBlock,
  mentionHintText,
  mentionOfHintBlock,
} from './subagent-mention.js';

describe('提示區塊', () => {
  it('造出來的區塊讀得回同一個名字——含引號、反斜線、中文、斜線', () => {
    for (const name of ['reviewer', '審查者', 'a"b', 'a\\b', 'x/y z', '含 "引號" 與 \\']) {
      const mention = { kind: 'subagent', name } as const;
      expect(mentionOfHintBlock(mentionHintBlock(mention))).toEqual(mention);
    }
  });

  it('只認整段字都對得上的文字區塊：使用者打的字、改過的提示、別種區塊都不是', () => {
    const mention = { kind: 'subagent', name: 'reviewer' } as const;
    const text = mentionHintText(mention);
    expect(isMentionHintBlock({ type: 'text', text: '請 reviewer 看一下' })).toBe(false);
    expect(isMentionHintBlock({ type: 'text', text: `${text} 多一段` })).toBe(false);
    expect(isMentionHintBlock({ type: 'text', text: text.replace('處理', '辦理') })).toBe(false);
    expect(isMentionHintBlock({ type: 'image_url', text })).toBe(false);
    expect(isMentionHintBlock(null)).toBe(false);
    expect(isMentionHintBlock('字串')).toBe(false);
  });
});

describe('userContent 的點名', () => {
  const mention = { kind: 'subagent', name: 'reviewer' } as const;

  it('沒點名也沒附件：仍是原本那串字（逐位元組相同）', () => {
    expect(userContent('嗨')).toBe('嗨');
    expect(userContent('嗨', [])).toBe('嗨');
  });

  it('有點名：文字在前、提示在後；空文字不放文字區塊', () => {
    expect(userContent('嗨', undefined, mention)).toEqual([
      { type: 'text', text: '嗨' },
      mentionHintBlock(mention),
    ]);
    expect(userContent('', undefined, mention)).toEqual([mentionHintBlock(mention)]);
  });
});
