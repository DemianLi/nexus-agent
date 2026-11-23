/** 過程違反清單（#436）：每一種各一條正向、乾淨的日誌一條反向。 */

import type { SessionEvent } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { FILE_TOOLS, findViolations } from './violations.js';

let nextSeq = 0;
function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
): SessionEvent {
  nextSeq += 1;
  return { seq: nextSeq, type, data } as SessionEvent;
}

const OPTIONS = { allowedTools: FILE_TOOLS, maxModelCalls: 3 };

const clean = (): SessionEvent[] => [
  event('turn/start', { kind: 'message', text: '讀檔' }),
  event('model/start', {}),
  event('tool/call', { callId: 'c1', name: 'read_file', arguments: '{}' }),
  event('tool/result', { callId: 'c1', isError: false }),
  event('model/start', {}),
  event('turn/end', {}),
];

describe('findViolations', () => {
  it('乾淨的一輪：空', () => {
    expect(findViolations(clean(), OPTIONS)).toEqual([]);
  });

  it('工具報錯', () => {
    const events = [...clean(), event('tool/result', { callId: 'c2', isError: true })];
    expect(findViolations(events, OPTIONS)).toEqual([{ kind: 'tool-error', detail: 'callId c2' }]);
  });

  it('被重打救回來', () => {
    const events = [
      ...clean(),
      event('llm/retry', {
        retryId: 'r',
        retry: 1,
        maxRetries: 2,
        failure: { message: 'x' },
      } as never),
    ];
    expect(findViolations(events, OPTIONS).map((v) => v.kind)).toEqual(['llm-retry']);
  });

  it('轉失敗：算違反；取消案例預期中止則不算', () => {
    const events = [...clean(), event('turn/failed', {} as never)];
    expect(findViolations(events, OPTIONS).map((v) => v.kind)).toEqual(['turn-failed']);
    expect(findViolations(events, { ...OPTIONS, expectAbort: true })).toEqual([]);
  });

  it('問了核准', () => {
    const events = [...clean(), event('approval/asked', { id: 'a', toolName: 'write_file' })];
    expect(findViolations(events, OPTIONS)).toEqual([
      { kind: 'approval-asked', detail: 'write_file' },
    ]);
  });

  it('呼叫了清單外的工具', () => {
    const events = [
      ...clean(),
      event('tool/call', { callId: 'c3', name: 'execute', arguments: '{}' }),
    ];
    expect(findViolations(events, OPTIONS)).toEqual([
      { kind: 'unexpected-tool', detail: 'execute' },
    ]);
  });

  it('模型呼叫超過上限', () => {
    const events = [...clean(), event('model/start', {}), event('model/start', {})];
    expect(findViolations(events, OPTIONS)).toEqual([
      { kind: 'over-call-cap', detail: '4 次，上限 3' },
    ]);
  });
});
