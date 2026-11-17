/**
 * 刪除的寫入方放手，per-thread 這一半（[#2957](https://github.com/DemianLi/nexus-agent/issues/2957)，H）。
 *
 * - 對話行程那一側：`POST /internal/threads/:id/release` 只認綁著的那一條，停、等閒置、撤出，回來時寫租約已放掉。
 * - 前台那一側：本地沒有這條 thread 時，`releaseWriter` 問對話行程（`threadActivityElsewhere.release`）；沒有行程就直接回。
 * - 前台的 `threadActivityOverSocket` 把 release 送到那條 thread 的 socket；沒有 socket 不送。
 *
 * 跨行程的整支（真的監督行程、前台與對話行程各一個）只在 Linux 跑，見 `per-thread.integration.test.ts`；這份在 macOS 也跑得起來。
 */

import { describe, expect, it } from 'vitest';

import { loopbackRequest } from './fixtures.js';
import { rig, startHeldRun, BASE } from './idle-eviction.fixture.js';
import { threadActivityOverSocket } from './front-wire.js';
import { internalThreadPath } from './wire-handler.js';

describe('對話行程：release 路由只認綁著的那一條', () => {
  it('綁著的 thread 停掉一輪、撤出，回 204；寫入方已放掉（evicted 與 disposed 都有）', async () => {
    const r = rig({ boundThread: () => 't-run', releaseIdleWaitMs: 2_000 });
    try {
      await startHeldRun(r, 't-run');
      // 工具卡在閘門上：放行之後它才回來，停止擋住之後的下一步，撤出完成。
      const pending = r.handler.handle(
        loopbackRequest(`${BASE}${internalThreadPath('t-run', 'release')}`, { method: 'POST' }),
      );
      r.probe.hold.open();
      const response = await pending;
      expect(response.status).toBe(204);
      expect(r.disposed).toContain('t-run');
      expect(r.evicted).toContain('t-run');
    } finally {
      r.probe.hold.open();
      await r.handler.close();
    }
  }, 60_000);

  it('不是綁著的 thread：404，不碰它', async () => {
    const r = rig({ boundThread: () => 't-bound' });
    try {
      const response = await r.handler.handle(
        loopbackRequest(`${BASE}${internalThreadPath('t-other', 'release')}`, { method: 'POST' }),
      );
      expect(response.status).toBe(404);
    } finally {
      await r.handler.close();
    }
  });
});

describe('前台：本地沒有的 thread 放手寫入方，問對話行程', () => {
  it('releaseWriter 對本地沒有的 thread 呼叫 threadActivityElsewhere.release', async () => {
    const released: string[] = [];
    const r = rig({
      threadActivityElsewhere: {
        activity: async () => [],
        stop: async () => undefined,
        release: async (threadId) => {
          released.push(threadId);
        },
      },
    });
    try {
      await r.handler.releaseWriter('t-far');
      expect(released).toEqual(['t-far']);
    } finally {
      await r.handler.close();
    }
  });

  it('沒有對話行程（沒有 release 可問）就直接回，不拋', async () => {
    const r = rig({
      threadActivityElsewhere: { activity: async () => [], stop: async () => undefined },
    });
    try {
      await expect(r.handler.releaseWriter('t-nobody')).resolves.toBeUndefined();
    } finally {
      await r.handler.close();
    }
  });
});

describe('前台的 socket 轉送：release 送到那條 thread 的對話行程', () => {
  it('有 socket 就 POST 到 release 路徑；沒有 socket 就不送', async () => {
    const forwarded: { url: string; method: string; socket: string }[] = [];
    const sockets: Record<string, string | undefined> = { 't-up': '/sock/up' };
    const port = threadActivityOverSocket(
      { socketOf: (threadId: string) => sockets[threadId] } as never,
      {
        forward: async (request: Request, socket: string) => {
          forwarded.push({ url: new URL(request.url).pathname, method: request.method, socket });
          return new Response(null, { status: 204 });
        },
      } as never,
    );
    await port.release?.('t-up');
    await port.release?.('t-down');
    expect(forwarded).toEqual([
      { url: internalThreadPath('t-up', 'release'), method: 'POST', socket: '/sock/up' },
    ]);
  });
});
