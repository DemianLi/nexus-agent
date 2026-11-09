/**
 * 點名提示區塊（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）：造得出來、讀得回去，使用者自己打的字不會被誤認。
 */

import { describe, expect, it } from 'vitest';

import { replayConversation } from './langchain-message-adapter.js';
import { turnStartMessage, userContent } from './message-source.js';
import type { SessionEvent } from './session-log.js';
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

/**
 * 提示照 root 手上的委派工具組字（[#2649](https://github.com/DemianLi/nexus-agent/issues/2649)）：日誌記 `mention.tool`，live 與重放照它組；
 * 這一格出現以前的日誌重放出來的字，與當初送給模型的逐位元組相同。
 */
describe('提示裡的委派工具', () => {
  /** #2359 實機重跑（develop `747b2b3a`，continuable）假端點收到的 root 請求裡，人話那一則的原文。 */
  const SENT_BEFORE_2649 =
    '幫我登記阿明<system-reminder>使用者點名要你把這句話交給子代理 "general-purpose" 處理：' +
    '請用委派工具（task 的 subagent_type 填這個名字）把這句話派給它，並把它需要的背景一併交代。</system-reminder>';

  it('continuable 模式（`subagent`）：提示只提 `subagent`，不提 `task`', () => {
    const text = mentionHintText({ kind: 'subagent', name: 'general-purpose', tool: 'subagent' });
    expect(text).toContain('subagent 的 subagent_type');
    expect(text).not.toContain('task');
  });

  it('one-shot 模式（`task`）：提示只提 `task`，字與缺席時相同', () => {
    const text = mentionHintText({ kind: 'subagent', name: 'general-purpose', tool: 'task' });
    expect(text).toContain('task 的 subagent_type');
    expect(text).not.toContain('subagent 的');
    expect(text).toBe(mentionHintText({ kind: 'subagent', name: 'general-purpose' }));
  });

  it('三種字都讀得回點名：舊字（缺席）、`task`、`subagent`', () => {
    const name = 'general-purpose';
    expect(mentionOfHintBlock(mentionHintBlock({ kind: 'subagent', name }))).toEqual({
      kind: 'subagent',
      name,
    });
    expect(mentionOfHintBlock(mentionHintBlock({ kind: 'subagent', name, tool: 'task' }))).toEqual({
      kind: 'subagent',
      name,
    });
    expect(
      mentionOfHintBlock(mentionHintBlock({ kind: 'subagent', name, tool: 'subagent' })),
    ).toEqual({ kind: 'subagent', name, tool: 'subagent' });
    expect(
      isMentionHintBlock({ type: 'text', text: SENT_BEFORE_2649.slice('幫我登記阿明'.length) }),
    ).toBe(true);
  });

  it('舊日誌（continuable，`mention` 沒有 `tool`）重放出來的人話，與當初送出的逐位元組相同', () => {
    // 55 版寫出的 `turn/start`，原樣是磁碟上的一行。
    const line =
      '{"type":"turn/start","seq":0,"time":0,"data":{"kind":"message","text":"幫我登記阿明",' +
      '"mention":{"kind":"subagent","name":"general-purpose"}}}';
    const replay = replayConversation([JSON.parse(line) as SessionEvent]);
    if (replay.kind !== 'replayed') throw new Error(`推不出來：${replay.reason}`);
    expect(replay.messages.map((message) => message.text)).toEqual([SENT_BEFORE_2649]);
  });

  it.each(['task', 'subagent'] as const)(
    '新日誌（`tool: %s`）：live 組的與重放組的是同一段字',
    (tool) => {
      const data = {
        kind: 'message' as const,
        text: '幫我登記阿明',
        mention: { kind: 'subagent' as const, name: 'general-purpose', tool },
      };
      const live = turnStartMessage(data).data.content;
      // 輪中插話那條路不經 `turn/start`，直接用 `userContent` 組。
      expect(userContent(data.text, undefined, data.mention)).toEqual(live);
      const replay = replayConversation([
        { type: 'turn/start', seq: 0, time: 0, data } as unknown as SessionEvent,
      ]);
      if (replay.kind !== 'replayed') throw new Error(`推不出來：${replay.reason}`);
      expect(replay.messages[0]!.content).toEqual(live);
      expect(JSON.stringify(live)).toContain(`${tool} 的 subagent_type`);
    },
  );
});
