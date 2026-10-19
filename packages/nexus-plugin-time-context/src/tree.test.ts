/**
 * time-context 在樹上這一列（[#1625](https://github.com/DemianLi/nexus-agent/issues/1625)）：一致性、登記的 listener、兩條 thread 各讀各的日誌。
 *
 * 走真的 Cordis 樹（`Loader` + `agentLoop` 與 `sessionLookup` 兩個真提供者）。和 `index.test.ts`（文字、日誌折疊、節流）分工：
 * 那邊問「讀數寫什麼」，這邊問「掛在樹上之後，登記的是誰、查的是哪條 thread」。進產品組裝的驗收（A–L）在
 * `apps/harness/src/time-context-on-tree.test.ts`。
 *
 * **測試檔不受 SDK lint 管**（`PLUGIN_LINT_IGNORES`），所以這裡可以 import `@nexus/core`；`src/index.ts` 不行。
 */

import { agentLoopToken } from '@nexus/agent-loop';
import { createAgentLoopProvider } from '@nexus/agent-loop/provider';
import { pickSessionForCall, SessionRegistry } from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { checkConformance } from '@nexus/sdk';
import { createSessionLookupProvider } from '@nexus/session/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as module from './index.js';
import { TIME_CONTEXT_MIDDLEWARE_NAME } from './index.js';

const opened: Context[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of opened.splice(0)) await root.fiber.dispose();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-10-18T01:00:00Z'));
});

const ROOT_NS = 'TimeContext.before_agent:1';
const invocationOf = (thread: string) => ({
  configurable: { thread_id: thread, checkpoint_ns: ROOT_NS },
});

async function mount(threads: readonly string[], config: unknown = {}) {
  const sessions = new Map(threads.map((thread) => [thread, new SessionRegistry(thread)]));
  const loop = createAgentLoopProvider();
  const root = new Context();
  opened.push(root);
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, {
    'pre-step': loop.Provider,
    'session-lookup': createSessionLookupProvider((callConfig) =>
      pickSessionForCall(sessions.values(), callConfig),
    ).Provider,
    'time-context': module,
  });
  const create = (entry: { id: string; name: string; config?: unknown }) =>
    root.loader.create(entry as never, null);
  await create({ id: 'pre-step', name: 'cordis:pre-step' });
  await create({ id: 'session-lookup', name: 'cordis:session-lookup' });
  await create({ id: 'time-context', name: 'cordis:time-context', config });
  await root.loader.await();
  return { loop, root, sessions };
}

describe('一致性套件：真的提供者、真的 Loader', () => {
  it('time-context 全格通過：manifest、匯出形式、卸載後登記處回到空的、缺提供者停在 PENDING', async () => {
    let latest = createAgentLoopProvider();
    const failures = await checkConformance({
      row: 'time-context',
      module,
      config: {},
      providers: {
        agentLoop: () => {
          latest = createAgentLoopProvider();
          return latest.Provider;
        },
        sessionLookup: () => createSessionLookupProvider(() => ({ kind: 'not-attached' })).Provider,
      },
      residue: () => latest.registrations(),
    });
    expect(failures).toEqual([]);
  });

  it('manifest 宣告兩個必要依賴：agentLoop、sessionLookup（都是 ^1.0.0）；沒有提供、沒有 default 匯出', () => {
    expect(agentLoopToken.name).toBe('agentLoop');
    expect(module.manifest.consumes).toEqual([
      { token: 'agentLoop', range: '^1.0.0' },
      { token: 'sessionLookup', range: '^1.0.0' },
    ]);
    expect(module.manifest.provides).toEqual([]);
    expect('default' in module).toBe(false);
    expect(module.manifest.reload).toEqual({ code: 'restart', config: 'next-thread' });
  });
});

describe('掛上之後', () => {
  it('登記的是一位名叫 TimeContextMiddleware 的 listener，登記者是這一列', async () => {
    const { loop } = await mount(['t']);
    expect(loop.preSteps().map(({ name, source }) => ({ name, source }))).toEqual([
      { name: TIME_CONTEXT_MIDDLEWARE_NAME, source: 'time-context' },
    ]);
  });

  it('listener 依呼叫的 thread 挑日誌：兩條 thread 的節流與基線互不影響', async () => {
    const { loop, sessions } = await mount(['a', 'b']);
    const listener = loop.preSteps()[0]!.listener;
    for (const thread of ['a', 'b']) {
      sessions.get(thread)!.root.append('turn/start', { kind: 'message', text: '嗨' });
    }
    expect(await listener([], invocationOf('a'))).toHaveLength(1);
    // a 已經注入過（記進 a 的日誌，這裡模擬宿主做的事）；b 還沒有。
    sessions.get('a')!.root.append('user/message', {
      message: { type: 'human', content: '讀數' } as never,
      source: { kind: 'plugin', plugin: TIME_CONTEXT_MIDDLEWARE_NAME },
    });
    vi.setSystemTime(Date.parse('2026-10-18T01:01:00Z'));
    expect(await listener([], invocationOf('a'))).toBeUndefined();
    expect(await listener([], invocationOf('b'))).toHaveLength(1);
  });

  it('設定寫錯（時區不是 IANA 名、間隔不是非負整數、多餘欄位）：這一列沒有登記任何 listener', async () => {
    for (const config of [
      { timeZone: 'Asia/Taipe' },
      { refreshIntervalMs: -1 },
      { refreshIntervalMs: 1.5 },
      { unknown: true },
    ]) {
      const { loop } = await mount(['t'], config);
      expect(loop.preSteps(), JSON.stringify(config)).toEqual([]);
    }
  });

  it('明指時區時，讀數的時間戳用那個時區', async () => {
    const { loop, sessions } = await mount(['t'], { timeZone: 'Asia/Taipei' });
    sessions.get('t')!.root.append('turn/start', { kind: 'message', text: '嗨' });
    const [injection] = (await loop.preSteps()[0]!.listener([], invocationOf('t'))) ?? [];
    expect(injection?.content.split('\n')[0]).toBe(
      'Time sampled while preparing turn 1, step 1: 2026-10-18T09:00:00+08:00[Asia/Taipei]',
    );
  });
});
