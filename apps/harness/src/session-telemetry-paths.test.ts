/**
 * 遙測接線：**兩條進入點各自接得上，而且接的是自己那份日誌**。
 *
 * 這一檔跟 [`session-log-paths.test.ts`](./session-log-paths.test.ts) 是一對。那邊證的是
 * 兩條路都在寫日誌，這邊證的是那兩份日誌各自都有出口——接線點不一樣（CLI 在
 * `runCli`，web 在 `wire-handler.ts` 建 pump 的那一刻），漏掉任何一邊都不會有
 * 型別錯誤，只會靜靜地少掉一整條路的遙測。
 *
 * **零憑證、零外部連線**：後端是測試自己的假貨，模型是 `ScriptedChatModel`
 * （[#31](https://github.com/DemianLi/nexus-agent/issues/31)：CI 沒有模型秘密）。
 *
 * @see [#89](https://github.com/DemianLi/nexus-agent/issues/89)
 */

import type { Event } from '@nexus/wire';
import { createWireClient } from '@nexus/wire';
import type {
  NexusPlugin,
  SessionTelemetryRecord,
  SessionTelemetryRedactRule,
  SessionTelemetryService,
} from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { createCliAgent, DEFAULT_PLUGINS, runTurn } from './cli.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://telemetry.test';
const silent = { log: () => undefined, error: () => undefined };

interface Collected extends SessionTelemetryService {
  readonly records: SessionTelemetryRecord[];
  readonly shutdowns: { count: number };
}

function collectingSink(): Collected {
  const records: SessionTelemetryRecord[] = [];
  const shutdowns = { count: 0 };
  return {
    records,
    shutdowns,
    sharing: 'full',
    emit: (record) => void records.push(record),
    shutdown: () => {
      shutdowns.count += 1;
      return Promise.resolve();
    },
  };
}

/** 一個只掛遙測的 plugin——真的走 `apply(registry)`，不是繞過契約直接組協調器。 */
function telemetryPlugin(sink: SessionTelemetryService, redact?: SessionTelemetryRedactRule) {
  const plugin: NexusPlugin = {
    name: 'telemetry',
    apply(registry) {
      registry.telemetry.use(sink);
      if (redact !== undefined) registry.telemetry.redact(redact);
    },
  };
  return plugin;
}

function ledgerOf(sink: Collected): SessionTelemetryRecord[] {
  return sink.records.filter((record) => record.channel === 'ledger');
}

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

describe('遙測接線：CLI 那條路', () => {
  it('一輪跑完，日誌寫下的每一筆都鏡像成一筆 ledger 記錄', async () => {
    const sink = collectingSink();
    const { agent, dispose, sessionLog, attachTelemetry } = await createCliAgent({ live: false }, [
      ...DEFAULT_PLUGINS,
      telemetryPlugin(sink),
    ]);
    const detach = attachTelemetry(sessionLog);
    expect(detach).toBeDefined();

    try {
      await runTurn(agent, '嗨', silent, sessionLog);
    } finally {
      await dispose();
    }

    expect(ledgerOf(sink).map((record) => record.attributes['event.type'])).toEqual([
      'turn/start',
      'turn/end',
    ]);
    expect(ledgerOf(sink).map((record) => record.attributes['event.seq'])).toEqual([0, 1]);
    expect(ledgerOf(sink).every((record) => record.attributes['session.id'] === 'cli')).toBe(true);
  });

  it('dispose 會把協調器一起收掉：ops 的 shutdown 送出、後端也被關', async () => {
    const sink = collectingSink();
    const { dispose, sessionLog, attachTelemetry } = await createCliAgent({ live: false }, [
      ...DEFAULT_PLUGINS,
      telemetryPlugin(sink),
    ]);
    attachTelemetry(sessionLog);

    await dispose();

    const ops = sink.records.filter((record) => record.channel === 'ops');
    expect(ops.map((record) => record.attributes['telemetry.op'])).toEqual(['shutdown']);
    expect(sink.shutdowns.count).toBe(1);
  });

  it('沒有 plugin 掛後端時不接線——沒有出口就不付投影的成本', async () => {
    const { dispose, sessionLog, attachTelemetry, telemetrySharing } = await createCliAgent(
      { live: false },
      DEFAULT_PLUGINS,
    );
    try {
      expect(attachTelemetry(sessionLog)).toBeUndefined();
      // 披露那一層讀的就是這個：`undefined` 才是「未配置」。
      expect(telemetrySharing).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it('掛了後端時，披露讀得到那個後端說的策略', async () => {
    const { dispose, telemetrySharing } = await createCliAgent({ live: false }, [
      ...DEFAULT_PLUGINS,
      telemetryPlugin(collectingSink()),
    ]);
    try {
      expect(telemetrySharing).toBe('full');
    } finally {
      await dispose();
    }
  });

  it('脫敏規則真的作用在送出去的那份上，日誌本身不被改寫', async () => {
    const sink = collectingSink();
    const scrub: SessionTelemetryRedactRule = (record) => ({
      ...record,
      body: { kind: 'message', text: '[已脫敏]' },
    });
    const { dispose, sessionLog, attachTelemetry } = await createCliAgent({ live: false }, [
      ...DEFAULT_PLUGINS,
      telemetryPlugin(sink, scrub),
    ]);
    attachTelemetry(sessionLog);

    try {
      sessionLog.append('turn/start', { kind: 'message', text: 'sk-notasecret-fixture' });
    } finally {
      await dispose();
    }

    expect(ledgerOf(sink)[0]?.body).toEqual({ kind: 'message', text: '[已脫敏]' });
    // 脫敏只作用在匯出的副本上——正典日誌永遠不回頭被改寫。
    expect(sessionLog.events[0]?.data).toEqual({
      kind: 'message',
      text: 'sk-notasecret-fixture',
    });
  });

  it('會拋的脫敏規則扣住記錄，但那一輪照樣跑完', async () => {
    const sink = collectingSink();
    const { agent, dispose, sessionLog, attachTelemetry } = await createCliAgent({ live: false }, [
      ...DEFAULT_PLUGINS,
      telemetryPlugin(sink, () => {
        throw new Error('規則壞了');
      }),
    ]);
    attachTelemetry(sessionLog);

    try {
      await expect(runTurn(agent, '嗨', silent, sessionLog)).resolves.toBeUndefined();
    } finally {
      await dispose();
    }

    // agent loop 毫髮無傷，日誌照樣完整；出口那側一筆都沒有（fail-closed）。
    expect(sessionLog.events.map((event) => event.type)).toEqual(['turn/start', 'turn/end']);
    expect(sink.records).toHaveLength(0);
  });
});

describe('遙測接線：web 那條路', () => {
  it('接的是 pump 自己那份日誌——session.id 是 threadId', async () => {
    const sink = collectingSink();
    const built = await createCliAgent({ live: false }, [
      ...DEFAULT_PLUGINS,
      telemetryPlugin(sink),
    ]);
    const handler = createWireHandler({
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        dispose: built.dispose,
        attachTelemetry: built.attachTelemetry,
      }),
    });
    const fetchImpl: typeof globalThis.fetch = async (input, init) =>
      handler.handle(new Request(input as string, init));
    const client = createWireClient({ baseUrl: BASE_URL, fetch: fetchImpl });

    // `run.start` 是 fire-and-forget，所以同步機制是下行本身而不是時間：抽到 root
    // 那顆 `completed` 為止，那時這一輪的日誌事件已經寫完了。
    const events = await client.openEvents('web-telemetry');
    await client.runStart('web-telemetry', '嗨');
    await drainUntilRootCompleted(events);
    await handler.close();

    // **這一條就是 (A) 出局的證據還在成立**：號跟著 thread 走，不是跟著行程走。
    expect(ledgerOf(sink).map((record) => record.attributes['session.id'])).toEqual([
      'web-telemetry',
      'web-telemetry',
    ]);
    expect(ledgerOf(sink).map((record) => record.attributes['event.type'])).toEqual([
      'turn/start',
      'turn/end',
    ]);
    expect(sink.shutdowns.count).toBe(1);
  });

  it('createAgent 沒給 attachTelemetry 時什麼都不會發生', async () => {
    const sink = collectingSink();
    const built = await createCliAgent({ live: false }, [
      ...DEFAULT_PLUGINS,
      telemetryPlugin(sink),
    ]);
    const handler = createWireHandler({
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        dispose: built.dispose,
      }),
    });
    const fetchImpl: typeof globalThis.fetch = async (input, init) =>
      handler.handle(new Request(input as string, init));
    const client = createWireClient({ baseUrl: BASE_URL, fetch: fetchImpl });

    const events = await client.openEvents('web-none');
    await client.runStart('web-none', '嗨');
    await drainUntilRootCompleted(events);
    await handler.close();

    expect(sink.records).toHaveLength(0);
  });
});
