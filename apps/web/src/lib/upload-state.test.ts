import { describe, expect, it } from 'vitest';

import { formatBytes } from '@/lib/attachments';
import { NO_UPLOADS, reduceUploads, uploadView } from '@/lib/upload-state';
import type { UploadEvent, UploadStates } from '@/lib/upload-state';

const run = (events: readonly UploadEvent[], from: UploadStates = NO_UPLOADS) =>
  events.reduce(reduceUploads, from);

describe('reduceUploads（#733）', () => {
  it('start：這幾張進入上傳中，進度 0', () => {
    expect(run([{ type: 'start', ids: ['a', 'b'] }]).get('a')).toEqual({
      kind: 'uploading',
      loaded: 0,
    });
  });

  it('progress：記 loaded 與 total；total 沒有就沒有', () => {
    const states = run([
      { type: 'start', ids: ['a', 'b'] },
      { type: 'progress', id: 'a', loaded: 30, total: 100 },
      { type: 'progress', id: 'b', loaded: 7 },
    ]);
    expect(states.get('a')).toEqual({ kind: 'uploading', loaded: 30, total: 100 });
    expect(states.get('b')).toEqual({ kind: 'uploading', loaded: 7 });
  });

  it('progress 單調：回頭的值丟掉，進度條不倒退；total 一旦知道就記著', () => {
    const at60 = run([
      { type: 'start', ids: ['a'] },
      { type: 'progress', id: 'a', loaded: 60, total: 100 },
    ]);
    // 回頭的那一筆當下就要丟掉，不是等之後的值蓋過去。
    const regressed = reduceUploads(at60, { type: 'progress', id: 'a', loaded: 20, total: 100 });
    expect(regressed.get('a')).toEqual({ kind: 'uploading', loaded: 60, total: 100 });
    expect(reduceUploads(regressed, { type: 'progress', id: 'a', loaded: 70 }).get('a')).toEqual({
      kind: 'uploading',
      loaded: 70,
      total: 100,
    });
  });

  it('progress 超過 total 夾在 total；壞值（負數、NaN、total 為 0）不收', () => {
    const states = run([
      { type: 'start', ids: ['a'] },
      { type: 'progress', id: 'a', loaded: 150, total: 100 },
    ]);
    expect(states.get('a')).toEqual({ kind: 'uploading', loaded: 100, total: 100 });
    const bad = run([
      { type: 'start', ids: ['a'] },
      { type: 'progress', id: 'a', loaded: -1 },
      { type: 'progress', id: 'a', loaded: Number.NaN },
      { type: 'progress', id: 'a', loaded: 5, total: 0 },
    ]);
    expect(bad.get('a')).toEqual({ kind: 'uploading', loaded: 5 });
  });

  it('只有上傳中的卡收進度：完成、取消、沒開始的都不被拉回上傳中', () => {
    const base = run([{ type: 'start', ids: ['a'] }]);
    expect(
      run(
        [
          { type: 'done', id: 'a' },
          { type: 'progress', id: 'a', loaded: 5 },
        ],
        base,
      ).get('a'),
    ).toEqual({ kind: 'done' });
    expect(
      run(
        [
          { type: 'reset', reason: 'cancelled' },
          { type: 'progress', id: 'a', loaded: 5 },
        ],
        base,
      ).get('a'),
    ).toEqual({ kind: 'idle', reason: 'cancelled' });
    expect(run([{ type: 'progress', id: 'x', loaded: 5 }]).has('x')).toBe(false);
  });

  it('reset：上傳中與已上傳的都回到未上傳，帶原因；本來就沒紀錄的不動', () => {
    const states = run([
      { type: 'start', ids: ['a', 'b', 'c'] },
      { type: 'done', id: 'b' },
      { type: 'reset', reason: 'failed' },
    ]);
    expect(states.get('a')).toEqual({ kind: 'idle', reason: 'failed' });
    expect(states.get('b')).toEqual({ kind: 'idle', reason: 'failed' });
    expect(states.has('z')).toBe(false);
  });

  it('reset 沒有原因（伺服器沒收下、上傳都成功）：清掉紀錄，卡片照常畫', () => {
    const states = run([
      { type: 'start', ids: ['a', 'b'] },
      { type: 'done', id: 'a' },
      { type: 'reset' },
    ]);
    expect(states.size).toBe(0);
    // 已經是未上傳（取消、失敗）的留著：那是上一句留下的。
    const kept = run([
      { type: 'start', ids: ['a'] },
      { type: 'reset', reason: 'cancelled' },
      { type: 'reset' },
    ]);
    expect(kept.get('a')).toEqual({ kind: 'idle', reason: 'cancelled' });
  });

  it('沒有東西可變時回同一個物件（不觸發重畫）', () => {
    expect(reduceUploads(NO_UPLOADS, { type: 'reset', reason: 'cancelled' })).toBe(NO_UPLOADS);
    expect(reduceUploads(NO_UPLOADS, { type: 'start', ids: [] })).toBe(NO_UPLOADS);
    expect(reduceUploads(NO_UPLOADS, { type: 'forget', ids: ['a'] })).toBe(NO_UPLOADS);
    const started = run([
      { type: 'start', ids: ['a'] },
      { type: 'progress', id: 'a', loaded: 5, total: 10 },
    ]);
    expect(reduceUploads(started, { type: 'progress', id: 'a', loaded: 5, total: 10 })).toBe(
      started,
    );
  });

  it('forget：離開草稿的卡不再留紀錄，其他的留著', () => {
    const states = run([
      { type: 'start', ids: ['a', 'b'] },
      { type: 'forget', ids: ['a'] },
    ]);
    expect(states.has('a')).toBe(false);
    expect(states.has('b')).toBe(true);
  });
});

describe('uploadView（#733）', () => {
  it('沒有紀錄：照常畫（undefined）', () => {
    expect(uploadView(undefined, formatBytes)).toBeUndefined();
  });

  it('有總量：百分比取整數往下，100 封頂', () => {
    expect(uploadView({ kind: 'uploading', loaded: 456, total: 1000 }, formatBytes)).toEqual({
      phase: 'uploading',
      text: '上傳中 45%',
      percent: 45,
    });
    expect(uploadView({ kind: 'uploading', loaded: 1000, total: 1000 }, formatBytes)?.percent).toBe(
      100,
    );
  });

  it('進度超過總量（不該發生）也不畫超過 100%', () => {
    expect(uploadView({ kind: 'uploading', loaded: 1500, total: 1000 }, formatBytes)).toEqual({
      phase: 'uploading',
      text: '上傳中 100%',
      percent: 100,
    });
  });

  it('沒有總量：不猜百分比，畫已送出的量；還沒開始就只寫上傳中', () => {
    expect(uploadView({ kind: 'uploading', loaded: 0 }, formatBytes)).toEqual({
      phase: 'uploading',
      text: '上傳中…',
      percent: undefined,
    });
    expect(uploadView({ kind: 'uploading', loaded: 2048 }, formatBytes)?.text).toBe(
      '上傳中 2.0 KB',
    );
  });

  it('未上傳分取消與失敗，已上傳另寫', () => {
    expect(uploadView({ kind: 'idle', reason: 'cancelled' }, formatBytes)?.text).toBe(
      '未上傳（已取消）',
    );
    expect(uploadView({ kind: 'idle', reason: 'failed' }, formatBytes)?.text).toBe(
      '未上傳（上傳失敗）',
    );
    expect(uploadView({ kind: 'done' }, formatBytes)?.text).toBe('已上傳');
  });
});
