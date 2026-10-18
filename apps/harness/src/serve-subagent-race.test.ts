/**
 * 子代理的會話閘，第二次核對（[#1544](https://github.com/DemianLi/nexus-agent/issues/1544) 驗收 3）。
 *
 * 第一道（冷讀 header、在續接之前）擋住絕大多數；它和續接之間還有一道窄縫——檔案在冷讀之後、拿到寫租約之前被換掉。
 * 對應 dsh 組裝後的第二次核對（`session-controller/src/agent.ts:437-439`）。這一檔用一個假的存放處重現那道縫：
 * `open(…, 'read')` 回「沒有 `parentSession`」，`resume` 回「有」。斷言：丟 `SubagentSessionError`（線上是
 * `thread_is_subagent`），**而且續接拿到的寫把手被關掉了**（租約放了，不然下一次請求撞上自己留下的租約）。
 * 拿掉第二次核對就紅：請求會往下組裝、回成功。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { THREAD_IS_SUBAGENT, WireRejectedError } from '@nexus/wire';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { serveClient } from './fixtures.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

const closed: string[] = [];

// 把 serve 開的存放處包一層：`open` 說沒有 parentSession，`resume` 回的 header 有。
vi.mock('./jsonl-session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jsonl-session-store.js')>();
  return {
    ...actual,
    openJsonlSessionStore: (options: Parameters<typeof actual.openJsonlSessionStore>[0]) => {
      const real = actual.openJsonlSessionStore(options);
      return new Proxy(real, {
        get(target, property, receiver) {
          if (property === 'open') {
            return async (id: string, access: 'read') => {
              const stored = await target.open(id, access);
              return { ...stored, header: withoutParent(stored.header) };
            };
          }
          if (property === 'resume') {
            return async (id: string) => {
              const resumed = await target.resume(id);
              const originalClose = resumed.stored.close.bind(resumed.stored);
              return {
                ...resumed,
                stored: {
                  ...resumed.stored,
                  close: async () => {
                    closed.push(id);
                    await originalClose();
                  },
                },
              };
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

function withoutParent<T extends { parentSession?: unknown }>(header: T): T {
  const { parentSession: _parent, ...rest } = header;
  return rest as T;
}

let serve: ScriptedServe | undefined;
const temporary: string[] = [];
afterEach(async () => {
  await serve?.close();
  serve = undefined;
  closed.length = 0;
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('冷讀與續接之間檔案被換掉：第二次核對', () => {
  it('續接回來的 header 帶 parentSession：丟 thread_is_subagent，而且續接的寫把手被關掉', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { SESSION_LOG_FORMAT_VERSION } = await import('@nexus/core');
    const { projectKey } = await import('./jsonl-session-store.js');
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-subagent-race-'));
    temporary.push(root);
    const directory = join(root, projectKey(process.cwd()));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'alpha%2fbg-0123456789ab.header.json'),
      JSON.stringify({
        version: SESSION_LOG_FORMAT_VERSION,
        id: 'alpha/bg-0123456789ab',
        createdAt: 1,
        parentSession: 'alpha',
      }),
    );
    await writeFile(
      join(directory, 'alpha%2fbg-0123456789ab.jsonl'),
      `${JSON.stringify({ type: 'turn/end', seq: 0, time: 1, data: {} })}\n`,
    );
    serve = await startScriptedServe([{ content: '好' }], { argv: ['--session-log', root] });
    const client = await serveClient(serve.running);

    const opened: unknown = await client.openEvents('alpha/bg-0123456789ab').then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(opened).toBeInstanceOf(WireRejectedError);
    expect((opened as WireRejectedError).code).toBe(THREAD_IS_SUBAGENT);
    expect(closed).toEqual(['alpha/bg-0123456789ab']);
  });
});
