/**
 * 圖上 `HumanMessage` 的來源（[#662](https://github.com/DemianLi/nexus-agent/issues/662)）。
 *
 * 提醒器怎麼用它在 `repeat-reminder.test.ts`；這裡管來源本身：每一種 `turn/start` 對到哪個 kind、
 * 即時與重放造出同一則、缺席的方向。
 */

import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { attachmentBlock } from './attachment-ref.js';
import { replayConversation } from './conversation-replay.js';
import {
  humanMessageForTurnStart,
  isMachineMessage,
  MESSAGE_SOURCE_KWARG,
  messageSourceOf,
  sourceKwargs,
  turnStartSource,
} from './message-source.js';
import type { SessionEventMap } from './session-log.js';
import { SessionLog } from './session-log.js';

type TurnStart = SessionEventMap['turn/start'];

const GOAL: TurnStart = {
  kind: 'goal',
  text: '續行',
  goalId: 'g1' as never,
  revision: 2,
  round: 3,
};
const SETTLED: TurnStart = {
  kind: 'subagent-settled',
  text: '收工了',
  summary: '一行',
  senderSessionId: 's1',
};
const AGENT: TurnStart = { kind: 'agent-message', text: '嗨', senderSessionId: 's2' };

describe('turnStartSource：每一種輸入各一個 kind', () => {
  it('人打的字沒有來源；resume 沒有訊息', () => {
    expect(turnStartSource({ kind: 'message', text: '嗨' })).toBeUndefined();
    expect(turnStartSource({ kind: 'resume' })).toBeUndefined();
  });

  it('機器造的頭帶自己的 kind 與細節', () => {
    expect(turnStartSource(GOAL)).toEqual({ kind: 'goal', goalId: 'g1', revision: 2, round: 3 });
    expect(turnStartSource(SETTLED)).toEqual({ kind: 'subagent-settled', senderSessionId: 's1' });
    expect(turnStartSource(AGENT)).toEqual({ kind: 'agent-message', senderSessionId: 's2' });
  });
});

describe('humanMessageForTurnStart', () => {
  it('文字原樣，來源放在 additional_kwargs', () => {
    const message = humanMessageForTurnStart(GOAL);
    expect(message.text).toBe('續行');
    expect(message.additional_kwargs[MESSAGE_SOURCE_KWARG]).toEqual(turnStartSource(GOAL));
    expect(isMachineMessage(message)).toBe(true);
  });

  it('人打的字沒有來源：不算機器造的', () => {
    const message = humanMessageForTurnStart({ kind: 'message', text: '嗨' });
    expect(messageSourceOf(message)).toBeUndefined();
    expect(isMachineMessage(message)).toBe(false);
  });

  const FILE = {
    type: 'file' as const,
    attachmentId: `sha256:${'a'.repeat(64)}`,
    name: 'a.txt',
    bytes: 3,
  };
  const IMAGE = {
    type: 'image' as const,
    attachmentId: `sha256:${'b'.repeat(64)}`,
    mediaType: 'image/png' as const,
    bytes: 9,
    width: 1,
    height: 1,
  };

  it('帶附件：內容是「附件區塊（選的順序）＋文字區塊」，參照原樣；沒附件仍是純字串', () => {
    const message = humanMessageForTurnStart({
      kind: 'message',
      text: '看這個',
      attachments: [IMAGE, FILE],
    });
    expect(message.content).toEqual([
      attachmentBlock(IMAGE),
      attachmentBlock(FILE),
      { type: 'text', text: '看這個' },
    ]);
    // 區塊裡是參照（沒有 `type: 'file'` 那一欄），不是位元組。
    expect(JSON.stringify(message.content)).not.toContain('"type":"file"');
    expect(humanMessageForTurnStart({ kind: 'message', text: '嗨', attachments: [] }).content).toBe(
      '嗨',
    );
    expect(humanMessageForTurnStart({ kind: 'message', text: '嗨' }).content).toBe('嗨');
  });

  it('只有附件沒有字：不放空文字區塊', () => {
    const message = humanMessageForTurnStart({ kind: 'message', text: '', attachments: [FILE] });
    expect(message.content).toHaveLength(1);
    expect((message.content as { type: string }[])[0]!.type).toBe('nexus-file');
  });

  it('別種 kind 的 turn/start 不帶附件', () => {
    expect(humanMessageForTurnStart(GOAL).content).toBe('續行');
  });

  it('resume 造不出訊息：大聲拋', () => {
    expect(() => humanMessageForTurnStart({ kind: 'resume' })).toThrow(/resume/u);
  });
});

describe('isMachineMessage', () => {
  it('user 來源是人；其他 kind 與沒見過的 kind 都是機器；不是 HumanMessage 一律否', () => {
    const of = (kind: string) =>
      new HumanMessage({ content: 'x', additional_kwargs: sourceKwargs({ kind }) });
    expect(isMachineMessage(of('user'))).toBe(false);
    expect(isMachineMessage(of('plugin'))).toBe(true);
    expect(isMachineMessage(of('never-seen-before'))).toBe(true);
    expect(isMachineMessage(undefined)).toBe(false);
    expect(isMachineMessage(new HumanMessage('x'))).toBe(false);
  });
});

describe('重放造出和即時同一則', () => {
  it('續接回來的續行輪次的頭仍然帶 goal 來源', () => {
    const log = new SessionLog('message-source');
    log.append('turn/start', { kind: 'message', text: '人說' });
    log.append('assistant/message', {
      message: { type: 'ai', data: { content: '好', tool_calls: [] } },
    } as never);
    log.append('turn/end', {});
    log.append('turn/start', GOAL);
    log.append('assistant/message', {
      message: { type: 'ai', data: { content: '再看', tool_calls: [] } },
    } as never);
    log.append('turn/end', {});
    const replay = replayConversation(log.events);
    if (replay.kind !== 'replayed') throw new Error(`推不出來：${replay.reason}`);
    const humans = replay.messages.filter((message) => HumanMessage.isInstance(message));
    expect(humans.map((message) => messageSourceOf(message))).toEqual([
      undefined,
      { kind: 'goal', goalId: 'g1', revision: 2, round: 3 },
    ]);
    // 和即時造的是同一份。
    expect(humans[1]?.additional_kwargs).toEqual(humanMessageForTurnStart(GOAL).additional_kwargs);
  });
});
