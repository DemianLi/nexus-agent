import type { ConversationStatus } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  canRunSlash,
  canSendText,
  isQueueParked,
  QUEUE_PREVIEW_CHARS,
  queueHeading,
  queuePreview,
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
