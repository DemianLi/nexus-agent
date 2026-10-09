/**
 * 子代理自己日誌裡的身分（#1271）：寫的一側只寫明列的欄位，讀的一側嚴格驗、取第一顆為準。
 */

import { describe, expect, it } from 'vitest';

import { SessionLog } from './session-log.js';
import type { SessionEvent } from './session-log.js';
import {
  SUBAGENT_DESCRIPTOR_VERSION,
  appendSubagentDescriptor,
  foldSubagentDescriptor,
} from './subagent-descriptor.js';

/** 把一顆已寫好的事件的載荷換掉（造壞檔）。 */
function withData(event: SessionEvent, data: unknown): SessionEvent {
  return { ...event, data } as SessionEvent;
}

describe('appendSubagentDescriptor', () => {
  it('只寫明列的欄位；省略的模型與推理等級不留 undefined', () => {
    const log = new SessionLog('root/bg-1');
    appendSubagentDescriptor(log, { subagent: 'worker' });
    expect(log.events[0]).toMatchObject({
      type: 'subagent/descriptor',
      data: { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', subagent: 'worker' },
    });
    expect('model' in (log.events[0]!.data as object)).toBe(false);
    expect('effort' in (log.events[0]!.data as object)).toBe(false);
  });

  it('帶模型與推理等級；寫完折得回來', () => {
    const log = new SessionLog('root/bg-1');
    appendSubagentDescriptor(log, { subagent: 'worker', model: 'm', effort: 'high' });
    expect(foldSubagentDescriptor(log.events)).toEqual({
      kind: 'ok',
      descriptor: {
        version: 1,
        mode: 'continuable',
        subagent: 'worker',
        model: 'm',
        effort: 'high',
      },
    });
  });
});

describe('foldSubagentDescriptor', () => {
  const good = (() => {
    const log = new SessionLog('root/bg-1');
    appendSubagentDescriptor(log, { subagent: 'worker' });
    return log.events[0]!;
  })();

  it('沒有這一顆（舊日誌、前景子代理）：absent，不推論', () => {
    const log = new SessionLog('root/bg-1');
    log.append('turn/start', { kind: 'message', text: '舊版任務' });
    expect(foldSubagentDescriptor(log.events)).toEqual({ kind: 'absent' });
    expect(foldSubagentDescriptor([])).toEqual({ kind: 'absent' });
  });

  it('取第一顆為準：後來的同種事件改不了組成', () => {
    const log = new SessionLog('root/bg-1');
    appendSubagentDescriptor(log, { subagent: 'first' });
    appendSubagentDescriptor(log, { subagent: 'second', model: 'm' });
    expect(foldSubagentDescriptor(log.events)).toMatchObject({
      kind: 'ok',
      descriptor: { subagent: 'first' },
    });
  });

  it('版本不是這個 runtime 認得的：unsupported-version（不驗其餘欄位，分不出來）', () => {
    expect(foldSubagentDescriptor([withData(good, { version: 2, whatever: true })])).toEqual({
      kind: 'unsupported-version',
      version: 2,
    });
  });

  it.each([
    ['載荷不是物件', 'x'],
    ['陣列', []],
    ['沒有版本', { mode: 'continuable', subagent: 'w' }],
    ['版本不是數字', { version: '1', mode: 'continuable', subagent: 'w' }],
    ['多一個不認得的欄位', { version: 1, mode: 'continuable', subagent: 'w', provider: 'p' }],
    ['mode 不是 continuable', { version: 1, mode: 'one-shot', subagent: 'w' }],
    ['缺 subagent', { version: 1, mode: 'continuable' }],
    ['subagent 是空字串', { version: 1, mode: 'continuable', subagent: '' }],
    ['model 不是字串', { version: 1, mode: 'continuable', subagent: 'w', model: 3 }],
    ['effort 是空字串', { version: 1, mode: 'continuable', subagent: 'w', effort: '' }],
  ])('壞檔不是靜靜忽略：%s → malformed', (_name, data) => {
    expect(foldSubagentDescriptor([withData(good, data)])).toMatchObject({ kind: 'malformed' });
  });
});
