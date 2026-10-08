import { SETTLE_REASONS } from '@nexus/wire';
import type { ConversationStatus, WireQueuedInput } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  canRunSlash,
  canSendText,
  AGENT_MESSAGE_QUEUED_TEXT,
  isAgentMessage,
  isQueueParked,
  isQueuedByAgent,
  isSettledNotice,
  queuedAgentText,
  settledNoticeText,
  QUEUE_PREVIEW_CHARS,
  queueHeading,
  queuePreview,
  SETTLED_NOTICE_TEXT,
  SETTLED_NOTICE_UNKNOWN_TEXT,
} from '@/lib/queue-view';

const STATUSES: readonly ConversationStatus[] = [
  'idle',
  'running',
  'awaiting-input',
  'stopped',
  'failed',
];

describe('isQueueParked（Q6）', () => {
  it.each(STATUSES)('%s：清單空的不算停住', (status) => {
    expect(isQueueParked(status, 0)).toBe(false);
  });

  it.each<[ConversationStatus, boolean]>([
    ['idle', true],
    ['running', false],
    ['awaiting-input', false],
    ['stopped', true],
    ['failed', true],
  ])('%s 且排著一件：%s', (status, parked) => {
    expect(isQueueParked(status, 1)).toBe(parked);
  });
});

describe('queuePreview', () => {
  it('空白攤成一格、頭尾去掉', () => {
    expect(queuePreview('  第一行\n\n\t第二行  ')).toBe('第一行 第二行');
  });

  it('上限以碼位算，不把 emoji 切半', () => {
    const exact = '字'.repeat(QUEUE_PREVIEW_CHARS);
    expect(queuePreview(exact)).toBe(exact);
    const long = '😀'.repeat(QUEUE_PREVIEW_CHARS + 1);
    expect(queuePreview(long)).toBe(`${'😀'.repeat(QUEUE_PREVIEW_CHARS)}…`);
  });
});

it('queueHeading 寫件數', () => {
  expect(queueHeading(3)).toBe('3 則排著的訊息');
});

describe('canSendText（Q2）', () => {
  it.each<[ConversationStatus, boolean]>([
    ['idle', true],
    ['running', true],
    ['awaiting-input', false],
    ['stopped', true],
    ['failed', true],
  ])('%s：%s', (status, allowed) => {
    expect(canSendText(true, status, '一句話')).toBe(allowed);
  });

  it('斷線或空白送不出去', () => {
    expect(canSendText(false, 'idle', '一句話')).toBe(false);
    expect(canSendText(true, 'idle', '   ')).toBe(false);
  });

  it('有附件時空白文字也放行（文字或附件至少一個）；斷線與停在核准點照擋', () => {
    expect(canSendText(true, 'idle', '', true)).toBe(true);
    expect(canSendText(true, 'running', '   ', true)).toBe(true);
    expect(canSendText(false, 'idle', '', true)).toBe(false);
    expect(canSendText(true, 'awaiting-input', '', true)).toBe(false);
    expect(canSendText(true, 'idle', '', false)).toBe(false);
  });
});

describe('canRunSlash', () => {
  it.each<[ConversationStatus, boolean]>([
    ['idle', true],
    ['running', false],
    ['awaiting-input', false],
    ['stopped', true],
    ['failed', true],
  ])('%s：/plan %s', (status, allowed) => {
    expect(canRunSlash(true, status, '/plan', '/feedback')).toBe(allowed);
  });

  it.each(STATUSES)('%s：/feedback 照樣放行', (status) => {
    expect(canRunSlash(true, status, ' /feedback ', '/feedback')).toBe(true);
  });

  it('斷線送不出去', () => {
    expect(canRunSlash(false, 'idle', '/plan', '/feedback')).toBe(false);
  });
});

describe('isSettledNotice（#851）', () => {
  const of = (source: WireQueuedInput['source']): WireQueuedInput => ({
    id: 'a',
    text: 't',
    source,
  });

  it('只有背景子代理結算的通知算；人排的不算', () => {
    expect(isSettledNotice(of({ kind: 'subagent-settled' }))).toBe(true);
    expect(isSettledNotice(of({ kind: 'user' }))).toBe(false);
  });
});

describe('不是人排的那一類（#861）', () => {
  const of = (source: WireQueuedInput['source']): WireQueuedInput => ({
    id: 'a',
    text: 't',
    source,
  });

  it('結算通知與來信各自認得，合起來是「不是人排的」；人排的都不是', () => {
    expect(isAgentMessage(of({ kind: 'agent-message' }))).toBe(true);
    expect(isAgentMessage(of({ kind: 'subagent-settled' }))).toBe(false);
    expect(isQueuedByAgent(of({ kind: 'agent-message' }))).toBe(true);
    expect(isQueuedByAgent(of({ kind: 'subagent-settled' }))).toBe(true);
    expect(isQueuedByAgent(of({ kind: 'user' }))).toBe(false);
  });

  it('佇列列上各寫各的一句，人排的沒有', () => {
    // 沒有 reason＝舊日誌：中性的一句，不是「已完成」
    expect(queuedAgentText(of({ kind: 'subagent-settled' }))).toBe(SETTLED_NOTICE_UNKNOWN_TEXT);
    expect(queuedAgentText(of({ kind: 'subagent-settled', reason: 'aborted' }))).toBe(
      SETTLED_NOTICE_TEXT.aborted,
    );
    expect(queuedAgentText(of({ kind: 'agent-message' }))).toBe(AGENT_MESSAGE_QUEUED_TEXT);
    expect(queuedAgentText(of({ kind: 'user' }))).toBeUndefined();
  });
});

describe('settledNoticeText（#884）', () => {
  it('四種原因各一句，措辭釘死：不是都寫「已完成」', () => {
    expect(settledNoticeText('completed')).toBe('背景子代理已完成');
    expect(settledNoticeText('aborted')).toBe('背景子代理已被停止');
    expect(settledNoticeText('max-tokens')).toBe('背景子代理已達輸出上限，沒寫完');
    expect(settledNoticeText('error')).toBe('背景子代理失敗了');
  });

  it('wire 認得的每一種原因都有自己的一句，而且四句互不相同、都不是中性那句', () => {
    const texts = SETTLE_REASONS.map((reason) => settledNoticeText(reason));
    expect(new Set(texts).size).toBe(SETTLE_REASONS.length);
    expect(texts).not.toContain(SETTLED_NOTICE_UNKNOWN_TEXT);
  });

  it('沒有原因（格式 26 以前的舊日誌）與不認得的值：中性的「已結束」，不假裝成「已完成」', () => {
    expect(settledNoticeText(undefined)).toBe('背景子代理已結束');
    expect(settledNoticeText('exploded')).toBe('背景子代理已結束');
    expect(settledNoticeText(7)).toBe('背景子代理已結束');
    expect(SETTLED_NOTICE_UNKNOWN_TEXT).not.toBe(SETTLED_NOTICE_TEXT.completed);
  });
});
