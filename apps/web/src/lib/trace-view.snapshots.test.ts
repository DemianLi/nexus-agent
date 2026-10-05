import type { RequestSnapshotsView } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { sameRow, traceModel } from '@/lib/trace-view';
import type { TraceRow } from '@/lib/trace-view';
import { Script } from '@/test/conversation-frames';
import { call, turn, view, withTrajectory } from '@/test/trajectory-fixtures';

type CallRow = Extract<TraceRow, { kind: 'call' }>;

const SYSTEM_TEXT = 'You are a helpful assistant.\n工作目錄是 /。';

const tool = (name: string) => ({
  name,
  description: `${name} 的說明`,
  parameters: { type: 'object' },
});

function snapshots(): RequestSnapshotsView {
  return {
    system: [{ seq: 8, time: 1, reason: 'initial', text: SYSTEM_TEXT, chars: SYSTEM_TEXT.length }],
    header: [
      {
        seq: 3,
        time: 1,
        reason: 'initial',
        header: { config: { model: 'm', temperature: 1 }, tools: [tool('task'), tool('ls')] },
      },
      {
        seq: 9,
        time: 2,
        reason: 'change',
        header: {
          config: { model: 'm', temperature: 1, topP: 0.95 },
          tools: [tool('subagent'), tool('ls')],
        },
      },
    ],
  };
}

function rowsOf(snaps: RequestSnapshotsView, calls = [call(5, { system: 8, header: 9 })]) {
  const script = new Script();
  const state = reduceAll(emptyConversation(), [script.running(), script.completed()]);
  const model = traceModel(withTrajectory(state, script, view([turn(0, { calls })]), snaps));
  return model.turns[0]!.rows.filter((row): row is CallRow => row.kind === 'call');
}

describe('呼叫列帶請求快照的內容', () => {
  it('系統提示詞全文與原因、整份設定與工具清單（JSON）、原因都在列上', () => {
    const [row] = rowsOf(snapshots());
    expect(row!.systemText).toBe(SYSTEM_TEXT);
    expect(row!.systemReason).toBe('initial');
    expect(row!.headerReason).toBe('change');
    expect(JSON.parse(row!.headerJson!)).toEqual(snapshots().header[1]!.header);
    expect(row!.headerTools).toBe(2);
  });

  it('工具清單相對上一份留著的快照：新增與移除各列出來；沒有上一份、或沒變就沒有這一格', () => {
    const snaps = snapshots();
    const [changed] = rowsOf(snaps);
    expect(changed!.toolsDiff).toBe('新增 subagent；移除 task');
    // 指到的是最早那份：沒有更早的可比。
    const [first] = rowsOf(snaps, [call(5, { header: 3 })]);
    expect(first!.toolsDiff).toBeUndefined();
    // 只動設定、工具名沒變：沒有差異可講。
    const sameTools: RequestSnapshotsView = {
      ...snaps,
      header: [
        snaps.header[1]!,
        {
          seq: 20,
          time: 3,
          reason: 'change',
          header: { config: { model: 'x' }, tools: [tool('subagent'), tool('ls')] },
        },
      ],
    };
    const [same] = rowsOf(sameTools, [call(5, { header: 20 })]);
    expect(same!.toolsDiff).toBeUndefined();
  });

  it('沒有指向、或指到已被擠掉的快照：沒有內容欄位', () => {
    const [none, gone] = rowsOf(snapshots(), [call(5), call(6, { system: 1, header: 2 })]);
    for (const row of [none!, gone!]) {
      expect([row.systemText, row.headerJson, row.headerReason, row.toolsDiff]).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
    }
  });

  it('列只放原始值：同一份投影重建一次，每一列 sameRow（否則整個分頁每個 frame 重畫）', () => {
    const calls = [call(5, { system: 8, header: 9 }), call(6, { system: 8, header: 9 })];
    const first = rowsOf(snapshots(), calls);
    const second = rowsOf(snapshots(), calls);
    expect(first).toHaveLength(2);
    first.forEach((row, index) => expect(sameRow(row, second[index]!)).toBe(true));
  });

  it('不是物件的工具條目與缺 tools 的 header 不會讓它拋', () => {
    const snaps: RequestSnapshotsView = {
      system: [],
      header: [
        {
          seq: 9,
          time: 2,
          reason: 'initial',
          header: { config: {}, tools: [1, null, { name: 3 }] },
        },
        { seq: 10, time: 3, reason: 'initial', header: 42 },
      ],
    };
    const [odd, number] = rowsOf(snaps, [call(5, { header: 9 }), call(6, { header: 10 })]);
    expect([odd!.headerTools, number!.headerTools]).toEqual([3, undefined]);
    expect(number!.headerJson).toBe('42');
  });

  it('呼叫的結果（失敗、已中止）進列；正常回來的沒有這一格', () => {
    const [failed, aborted, fine] = rowsOf(snapshots(), [
      call(5, { outcome: 'error' }),
      call(6, { outcome: 'aborted' }),
      call(7),
    ]);
    expect([failed!.outcome, aborted!.outcome, fine!.outcome]).toEqual([
      'error',
      'aborted',
      undefined,
    ]);
    expect('outcome' in fine!).toBe(false);
  });
});
