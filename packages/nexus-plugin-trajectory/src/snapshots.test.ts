/** 請求快照投影（[#1027](https://github.com/DemianLi/nexus-agent/issues/1027)）：留最新幾份、系統提示詞截斷、其餘事件不動。 */

import { describe, expect, it } from 'vitest';
import { SessionLog } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { REQUEST_SNAPSHOTS_KEEP, REQUEST_SYSTEM_MAX_CHARS } from '@nexus/wire';
import {
  applyRequestSnapshots,
  initialRequestSnapshots,
  requestSnapshotsUnit,
} from './snapshots.js';

const system = (log: SessionLog, text: string, modelCall?: number) =>
  log.append(
    'request/system',
    { system: text, reason: 'change', ...(modelCall === undefined ? {} : { modelCall }) },
    { ignorable: true },
  );

function foldAll(events: readonly SessionEvent[]) {
  let state = initialRequestSnapshots();
  for (const event of events) state = applyRequestSnapshots(state, event);
  return requestSnapshotsUnit.view(state);
}

describe('請求快照投影', () => {
  it('兩種快照各自留下來，帶識別與原因', () => {
    const log = new SessionLog('s');
    const start = log.append('model/start', {});
    log.append(
      'request/system',
      { system: '你是助手', reason: 'initial', modelCall: start.seq },
      { ignorable: true },
    );
    log.append(
      'request/header',
      {
        header: { config: { model: 'm', temperature: 0 }, tools: [{ name: 'read_file' }] },
        reason: 'initial',
        modelCall: start.seq,
      },
      { ignorable: true },
    );
    const view = foldAll(log.events);
    expect(view.system).toEqual([
      expect.objectContaining({
        seq: 1,
        reason: 'initial',
        modelCall: start.seq,
        text: '你是助手',
        chars: 4,
      }),
    ]);
    expect(view.header[0]?.header).toEqual({
      config: { model: 'm', temperature: 0 },
      tools: [{ name: 'read_file' }],
    });
  });

  it('每種只留最新的幾份，舊的在前', () => {
    const log = new SessionLog('s');
    for (let i = 0; i < REQUEST_SNAPSHOTS_KEEP + 3; i += 1) system(log, `版本 ${i}`);
    const view = foldAll(log.events);
    expect(view.system).toHaveLength(REQUEST_SNAPSHOTS_KEEP);
    expect(view.system.map((s) => s.text)).toEqual(
      Array.from({ length: REQUEST_SNAPSHOTS_KEEP }, (_, i) => `版本 ${i + 3}`),
    );
  });

  it('系統提示詞超過上限就截斷、標 truncated，原文總長照記', () => {
    const log = new SessionLog('s');
    system(log, 'x'.repeat(REQUEST_SYSTEM_MAX_CHARS + 10));
    const [snapshot] = foldAll(log.events).system;
    expect(snapshot?.text).toHaveLength(REQUEST_SYSTEM_MAX_CHARS);
    expect(snapshot?.chars).toBe(REQUEST_SYSTEM_MAX_CHARS + 10);
    expect(snapshot?.truncated).toBe(true);
  });

  it('剛好在上限上的不標 truncated；沒有 modelCall 就不放這一格', () => {
    const log = new SessionLog('s');
    system(log, 'y'.repeat(REQUEST_SYSTEM_MAX_CHARS));
    const [snapshot] = foldAll(log.events).system;
    expect(snapshot).not.toHaveProperty('truncated');
    expect(snapshot).not.toHaveProperty('modelCall');
  });

  it('不是快照的事件回同一個參照', () => {
    const state = initialRequestSnapshots();
    const log = new SessionLog('s');
    log.append('turn/start', { kind: 'message', text: 'x' });
    for (const event of log.events) expect(applyRequestSnapshots(state, event)).toBe(state);
  });
});
