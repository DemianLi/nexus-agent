/**
 * 空間用完時給人看的字（[#2195](https://github.com/DemianLi/nexus-agent/issues/2195)）：
 * 認 `cause` 鏈上的 errno，不解析字串；線上那顆 `failed` frame 與 `turn/failed` 同一句。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceConversation, emptyConversation } from '@nexus/wire';
import type { Event } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { ContainedFilesystemBackend, pathlessReason } from './contained-backend.js';
import { classifyTurnFailure, turnFailureOf } from './live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const MESSAGE = '主機的儲存空間滿了，這一輪沒做完，請聯絡管理員。';

const errno = (code: string, syscall = 'write') =>
  Object.assign(new Error(`${code}: no space left on device, ${syscall}`), {
    code,
    errno: -28,
    syscall,
  });

describe('classifyTurnFailure', () => {
  it.each(['ENOSPC', 'EDQUOT'])('%s：固定的字，原文不留', (code) => {
    const { message, error } = turnFailureOf(errno(code));
    expect(error.code).toBe('STORAGE_FULL');
    expect(message).toBe(MESSAGE);
    expect(error.message).toBe(MESSAGE);
  });

  it('走 cause 鏈：包過幾層也認得', () => {
    const wrapped = new Error('寫入失敗', { cause: new Error('外層', { cause: errno('ENOSPC') }) });
    expect(classifyTurnFailure(wrapped).code).toBe('STORAGE_FULL');
  });

  it('反例：字面有 ENOSPC 但沒有 errno，不算', () => {
    expect(classifyTurnFailure(new Error('ENOSPC: no space left on device')).code).toBe('UNKNOWN');
    const shaped = Object.assign(new Error('x'), { code: 'ENOSPC' });
    expect(classifyTurnFailure(shaped).code).toBe('UNKNOWN');
  });
});

describe('工具的錯誤', () => {
  it('空間用完：不帶路徑，說明重試沒用', () => {
    const error = Object.assign(new Error("ENOSPC: no space left on device, open '/host/a'"), {
      code: 'ENOSPC',
      errno: -28,
      syscall: 'open',
    });
    const reason = pathlessReason(error);
    expect(reason).toMatch(/^ENOSPC: the host is out of storage space/u);
    expect(reason).not.toContain('/host');
  });

  it('write_file 走到它', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-storage-full-'));
    try {
      const fence = new ContainedFilesystemBackend({
        rootDir: root,
        mode: 'workspace-write',
        atomicInternals: {
          afterWrite: () => {
            throw errno('ENOSPC');
          },
        },
      });
      const result = await fence.write('/a.txt', 'x');
      expect(result.error).toContain('contact the administrator');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('線上那顆 failed frame', () => {
  const failedFrame = (error: string) => ({
    type: 'event',
    seq: 0,
    method: 'lifecycle',
    params: { namespace: [], timestamp: 0, data: { event: 'failed', graph_name: 'root', error } },
  });

  async function runFailing(thrown: unknown, rethrow = true) {
    const agent = {
      streamEvents: async () =>
        (async function* () {
          yield failedFrame(String((thrown as Error).message));
          if (rethrow) throw thrown;
        })(),
      getState: async () => ({ values: {} }),
      updateState: async () => ({}),
    } as unknown as PumpAgent;
    const warnings: string[] = [];
    const pump = new ThreadPump(
      agent,
      'storage',
      undefined,
      undefined,
      undefined,
      undefined,
      (message) => warnings.push(message),
    );
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = pump.subscribe(['lifecycle'], line.signal);
    const draining = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    await pump.submit({ kind: 'message', text: 'A' }).catch(() => undefined);
    await pump.whenIdle();
    pump.close();
    line.abort();
    await draining;
    const failed = frames.flatMap((frame) => {
      const data = frame.params.data as { event?: string; error?: string };
      return data.event === 'failed' ? [data.error] : [];
    });
    const state = frames.reduce(reduceConversation, emptyConversation());
    return { failed, frames, warnings, pump, state };
  }

  it('空間用完：線上與歷史同一句，原文只進日誌', async () => {
    const { failed, warnings, pump, state } = await runFailing(errno('ENOSPC'));
    expect(failed).toEqual([MESSAGE]);
    const turn = pump.sessionLog.events.find((event) => event.type === 'turn/failed');
    expect(turn?.data).toMatchObject({ message: MESSAGE, error: { code: 'STORAGE_FULL' } });
    expect(warnings.join('\n')).toContain('ENOSPC: no space left on device');
    expect(JSON.stringify(state)).not.toContain('ENOSPC');
    expect(state.errorCode).toBe('STORAGE_FULL');
  });

  it('別的錯：frame 原樣，一顆都不少', async () => {
    const { failed, state } = await runFailing(new Error('炸了'));
    expect(failed).toEqual(['炸了']);
    expect(state.errorCode).toBe('UNKNOWN');
  });

  it('frame 之後沒有拋：串流結束時照樣送出', async () => {
    const { failed, state } = await runFailing(new Error('炸了'), false);
    expect(failed).toEqual(['炸了']);
    expect(state.errorCode).toBeUndefined();
  });
});
