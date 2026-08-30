/**
 * 不變量接線：**兩條進入點各自接得上，而且真流量不會誤報**。
 *
 * 跟 [`session-telemetry-paths.test.ts`](./session-telemetry-paths.test.ts) 是同一型的
 * 檔案：漏接任何一邊都不會有型別錯誤，只會靜靜地少掉一整條路的檢查。
 *
 * **第二條是這一檔真正的價值**：`@nexus/core` 的配套入口把 turn 配對變成了運行時斷言，
 * 而一條會在真流量上誤報的檢查比沒有檢查更糟——所以兩條路都真的跑一輪，斷言違規是
 * 零。合法序列是照 `thread-pump.ts` 與 `cli.ts` 實際發的順序寫的，這裡是它的實測。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）。
 *
 * @see [#101](https://github.com/DemianLi/nexus-agent/issues/101)
 */

import type { Event } from '@nexus/wire';
import { createWireClient } from '@nexus/wire';
import type { NexusPlugin } from '@nexus/core';
import { createEchoPlugin } from '@nexus/plugin-echo';
import { describe, expect, it } from 'vitest';

import { createCliAgent, DEFAULT_PLUGINS, runTurn } from './cli.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://invariant.test';
const silent = { log: () => undefined, error: () => undefined };

/**
 * 抽下行抽到 root 走完一輪為止。
 *
 * **刻意用 `next()` 而不是 `for await` ＋ `break`**：`break` 會替你呼叫
 * `iterator.return()` 把整條下行關掉。
 */
async function drainUntilRootCompleted(
  events: AsyncGenerator<Event, void, undefined>,
): Promise<void> {
  for (;;) {
    const next = await events.next();
    if (next.done === true) return;
    const frame = next.value;
    if (frame.method !== 'lifecycle') continue;
    const data = frame.params.data as { event?: string; graph_name?: string };
    if (data.event === 'completed' && data.graph_name === 'root') return;
  }
}

/** 一個一律報違規的配套入口，用來證明接線真的通了。 */
function noisyInvariantPlugin(): NexusPlugin {
  return {
    name: 'noisy-invariant',
    apply(registry) {
      registry.invariants.register('@nexus/noisy', (subject, fail) => {
        subject.observe((event) => fail(`看到 ${event.type}`));
      });
    },
  };
}

describe('不變量接線：CLI 那條路', () => {
  it('真的跑一輪，配套入口一條違規都不報', async () => {
    // **不再自己補 `createCoreInvariantPlugin()`**：它已經在 `DEFAULT_PLUGINS` 裡
    // （#107），補第二份會撞包名歸屬當場拋。
    const { agent, dispose, sessionLog, attachInvariants } = await createCliAgent(
      { live: false },
      DEFAULT_PLUGINS,
    );
    // 這一條刻意**不**傳 `onInvariantViolation`，走 runner 的預設，因為它問的是
    // 「有沒有誤報」而不是「印去哪裡」——預設那條路徑也得是安靜的。
    const violations: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => void violations.push(String(message));
    const detach = attachInvariants(sessionLog);
    expect(detach).toBeDefined();

    try {
      await runTurn(agent, '嗨', silent, sessionLog);
    } finally {
      detach?.();
      console.error = original;
      await dispose();
    }

    expect(sessionLog.events.map((event) => event.type)).toEqual(['turn/start', 'turn/end']);
    expect(violations).toEqual([]);
  });

  it('接線真的通了——換一個一律報違規的配套入口就看得到違規', async () => {
    const { agent, dispose, sessionLog, attachInvariants } = await createCliAgent({ live: false }, [
      ...DEFAULT_PLUGINS,
      noisyInvariantPlugin(),
    ]);
    // 預設的 `onViolation` 是 `console.error`，這裡只需要知道它有沒有跑到，所以攔下來。
    const violations: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => void violations.push(String(message));
    const detach = attachInvariants(sessionLog);

    try {
      await runTurn(agent, '嗨', silent, sessionLog);
    } finally {
      detach?.();
      console.error = original;
      await dispose();
    }

    expect(violations).toEqual([
      'invariant violated by "@nexus/noisy": 看到 turn/start',
      'invariant violated by "@nexus/noisy": 看到 turn/end',
    ]);
  });

  it('沒有 plugin 註冊配套入口時不接線——沒有檢查就不多掛一個訂閱', async () => {
    // **清單自己寫，不能用 `DEFAULT_PLUGINS`**：它現在掛著十個配套入口（#107），
    // 拿它問「沒有人註冊時會怎樣」問的是另一個問題。
    const { dispose, sessionLog, attachInvariants } = await createCliAgent({ live: false }, [
      createEchoPlugin(),
    ]);
    try {
      expect(attachInvariants(sessionLog)).toBeUndefined();
    } finally {
      await dispose();
    }
  });
});

describe('預設清單', () => {
  it('十個配套入口都在，而且各自認領自己的包名', async () => {
    // #107 拍的是「全進」。少掛的那幾個會讓「這個 package 沒有可檢的關係」與
    // 「這個 package 的檢查沒掛上」在診斷裡長得一模一樣，所以這裡數的是**十**。
    const { dispose, sessionLog, attachInvariants } = await createCliAgent(
      { live: false },
      DEFAULT_PLUGINS,
    );
    try {
      expect(attachInvariants(sessionLog)).toBeDefined();
    } finally {
      await dispose();
    }
    expect(DEFAULT_PLUGINS.filter((plugin) => plugin.name.endsWith('-invariant'))).toHaveLength(10);
  });
});

describe('不變量接線：web 那條路', () => {
  it('接的是 pump 自己那份日誌，真的跑一輪也不誤報', async () => {
    const built = await createCliAgent({ live: false }, DEFAULT_PLUGINS);
    const violations: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => void violations.push(String(message));
    const handler = createWireHandler({
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        dispose: built.dispose,
        attachInvariants: built.attachInvariants,
      }),
    });
    const fetchImpl: typeof globalThis.fetch = async (input, init) =>
      handler.handle(new Request(input as string, init));
    const client = createWireClient({ baseUrl: BASE_URL, fetch: fetchImpl });

    try {
      const events = await client.openEvents('web-invariant');
      await client.runStart('web-invariant', '嗨');
      await drainUntilRootCompleted(events);
      await handler.close();
    } finally {
      console.error = original;
    }

    expect(violations).toEqual([]);
  });
});
