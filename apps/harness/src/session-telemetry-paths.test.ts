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

import { once } from 'node:events';
import { createServer } from 'node:http';

import type { Event } from '@nexus/wire';
import { createWireClient } from '@nexus/wire';
import { SessionLog, SessionRegistry } from '@nexus/core';
import type {
  LoggedMessage,
  NexusPlugin,
  SessionTelemetryRecord,
  SessionTelemetryRedactRule,
  SessionTelemetryService,
  SessionTelemetrySharingStatus,
} from '@nexus/core';
import { createTelemetryOtelPlugin } from '@nexus/plugin-telemetry-otel';
import { describe, expect, it, vi } from 'vitest';

import { DISABLED_FEEDBACK_WARNING } from './agent-factory.js';
import { createCliAgent, DEFAULT_PLUGINS, runTurn } from './cli.js';
import { loopbackRequest } from './fixtures.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://telemetry.test';
const silent = { log: () => undefined, error: () => undefined };

interface Collected extends SessionTelemetryService {
  readonly records: SessionTelemetryRecord[];
  readonly shutdowns: { count: number };
}

function collectingSink(sharing: SessionTelemetrySharingStatus = 'full'): Collected {
  const records: SessionTelemetryRecord[] = [];
  const shutdowns = { count: 0 };
  return {
    records,
    shutdowns,
    sharing,
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

/**
 * 補一則記著 id 的回覆，回傳那個 id：評分的目標。
 *
 * CLI 那條路跑假模型時日誌裡沒有記著 id 的回覆，而評分只在 web。這幾條驗的是遙測怎麼送回饋，不是目標怎麼認，
 * 所以直接補一則。**它是日誌的一顆，會跟著前綴一起送**，數號碼的那條要算進去。
 */
function ratableReply(log: SessionLog): string {
  const message = { type: 'ai', data: { content: '答。', id: 'm-telemetry' } } as LoggedMessage;
  log.append('assistant/message', { message });
  return 'm-telemetry';
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
    const { agent, dispose, sessions, sessionLog, attachTelemetry } = await createCliAgent(
      { live: false },
      [...DEFAULT_PLUGINS, telemetryPlugin(sink)],
    );
    const detach = attachTelemetry(sessions);
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
    const { dispose, sessions, attachTelemetry } = await createCliAgent({ live: false }, [
      ...DEFAULT_PLUGINS,
      telemetryPlugin(sink),
    ]);
    attachTelemetry(sessions);

    await dispose();

    const ops = sink.records.filter((record) => record.channel === 'ops');
    expect(ops.map((record) => record.attributes['telemetry.op'])).toEqual(['shutdown']);
    expect(sink.shutdowns.count).toBe(1);
  });

  it('沒有 plugin 掛後端時不接線——沒有出口就不付投影的成本', async () => {
    const { dispose, sessions, attachTelemetry, telemetrySharing } = await createCliAgent(
      { live: false },
      DEFAULT_PLUGINS,
    );
    try {
      expect(attachTelemetry(sessions)).toBeUndefined();
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
    const { dispose, sessions, sessionLog, attachTelemetry } = await createCliAgent(
      { live: false },
      [...DEFAULT_PLUGINS, telemetryPlugin(sink, scrub)],
    );
    attachTelemetry(sessions);

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
    const { agent, dispose, sessions, sessionLog, attachTelemetry } = await createCliAgent(
      { live: false },
      [
        ...DEFAULT_PLUGINS,
        telemetryPlugin(sink, () => {
          throw new Error('規則壞了');
        }),
      ],
    );
    attachTelemetry(sessions);

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
        commands: built.commands,
        dispose: built.dispose,
        attachTelemetry: built.attachTelemetry,
      }),
    });
    const fetchImpl: typeof globalThis.fetch = async (input, init) =>
      handler.handle(loopbackRequest(input as string, init));
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
        commands: built.commands,
        dispose: built.dispose,
      }),
    });
    const fetchImpl: typeof globalThis.fetch = async (input, init) =>
      handler.handle(loopbackRequest(input as string, init));
    const client = createWireClient({ baseUrl: BASE_URL, fetch: fetchImpl });

    const events = await client.openEvents('web-none');
    await client.runStart('web-none', '嗨');
    await drainUntilRootCompleted(events);
    await handler.close();

    expect(sink.records).toHaveLength(0);
  });
});

/** 起一個收 `/v1/logs` 的假 collector，只記原始 body。 */
async function mockCollector(): Promise<{ url: string; bodies: string[]; close: () => void }> {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => void chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('沒有拿到 port');
  return {
    url: `http://127.0.0.1:${address.port}/v1/logs`,
    bodies,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

describe('遙測接線：feedback-only 只在人送出回饋時補送（#279）', () => {
  it('回饋之前一筆都不送；第一顆回饋送整份前綴，之後只送新的那段', async () => {
    const sink = collectingSink('feedback-only');
    const { agent, dispose, sessions, sessionLog, attachTelemetry, feedback } =
      await createCliAgent({ live: false }, [...DEFAULT_PLUGINS, telemetryPlugin(sink)]);
    attachTelemetry(sessions);
    const seqs = () => ledgerOf(sink).map((record) => record.attributes['event.seq']);

    try {
      await runTurn(agent, '嗨', silent, sessionLog);
      expect(sink.records).toHaveLength(0);

      feedback!.record(sessionLog, { text: '回答錯了' });
      expect(ledgerOf(sink).map((record) => record.attributes['event.type'])).toEqual([
        'turn/start',
        'turn/end',
        'feedback/record',
      ]);

      await runTurn(agent, '再一次', silent, sessionLog);
      expect(seqs()).toEqual([0, 1, 2]);

      // 第二顆只送上次交到之後的那段——上界不對的話，這裡會重送 0–2。3–5 是第二輪與補上的那則回覆。
      const put = feedback!.put(sessionLog, {
        messageId: ratableReply(sessionLog),
        rating: 'negative',
        ifVersion: null,
      });
      expect(put.ok).toBe(true);
      expect(seqs()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    } finally {
      await dispose();
    }

    // 收掉時也不發 ops 的 shutdown：人沒按送出的東西，一筆都不出去。
    expect(sink.records.filter((record) => record.channel === 'ops')).toHaveLength(0);
    expect(sink.shutdowns.count).toBe(1);
  });

  it('續接回來的日誌裡本來就有回饋，接上的當下也不送', async () => {
    const earlier = new SessionLog('cli');
    earlier.append('turn/start', { kind: 'message', text: '上一次' });
    earlier.append('turn/end', {});
    earlier.append('feedback/record', { text: '上一次的回饋' });
    const sessions = new SessionRegistry('cli', { rootSeed: earlier.events });

    const sink = collectingSink('feedback-only');
    const { dispose, attachTelemetry } = await createCliAgent({ live: false }, [
      ...DEFAULT_PLUGINS,
      telemetryPlugin(sink),
    ]);
    try {
      attachTelemetry(sessions);
      // 上一個行程的那顆不是這一次按的——重播到它就等於接上的當下把整份歷史送出去。
      expect(sink.records).toHaveLength(0);

      // 這一次按的那顆才放行，而前綴包括帶進來的歷史（照 dsh 的 `includeHistory: true`）。
      sessions.root.append('feedback/record', { text: '這一次' });
      expect(ledgerOf(sink).map((record) => record.attributes['event.type'])).toEqual([
        'turn/start',
        'turn/end',
        'feedback/record',
        'session/end-seed',
        'feedback/record',
      ]);
    } finally {
      await dispose();
    }
  });

  it('策略是關閉時，收到回饋講一聲不會送出去；別的事件不講', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sink = collectingSink('disabled');
    const { agent, dispose, sessions, sessionLog, attachTelemetry, feedback } =
      await createCliAgent({ live: false }, [...DEFAULT_PLUGINS, telemetryPlugin(sink)]);
    attachTelemetry(sessions);

    try {
      await runTurn(agent, '嗨', silent, sessionLog);
      expect(warn).not.toHaveBeenCalled();
      feedback!.record(sessionLog, { text: '回答錯了' });
      expect(warn.mock.calls).toEqual([[DISABLED_FEEDBACK_WARNING]]);
    } finally {
      await dispose();
      warn.mockRestore();
    }
  });

  it('web 回饋對話框送出的那顆也放行——寫者不同，看的是同一份 root 日誌', async () => {
    const sink = collectingSink('feedback-only');
    const built = await createCliAgent({ live: false }, [
      ...DEFAULT_PLUGINS,
      telemetryPlugin(sink),
    ]);
    const handler = createWireHandler({
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        commands: built.commands,
        dispose: built.dispose,
        attachTelemetry: built.attachTelemetry,
        ...(built.feedback !== undefined && { feedback: built.feedback }),
      }),
    });
    const fetchImpl: typeof globalThis.fetch = async (input, init) =>
      handler.handle(loopbackRequest(input as string, init));
    const client = createWireClient({ baseUrl: BASE_URL, fetch: fetchImpl });

    const events = await client.openEvents('web-feedback');
    await client.runStart('web-feedback', '嗨');
    await drainUntilRootCompleted(events);
    expect(sink.records).toHaveLength(0);

    await client.feedbackRecord('web-feedback', { text: '這一輪不對' });
    await handler.close();

    expect(ledgerOf(sink).map((record) => record.attributes['event.type'])).toEqual([
      'turn/start',
      'turn/end',
      'feedback/record',
    ]);
  });

  it('走真的 OTel 後端：回饋的文字與評分備註原樣進 collector', async () => {
    // #278 留下的那件：當時是讀碼得出、沒實跑。這裡對著假 collector 真打一次。
    const collector = await mockCollector();
    const { agent, dispose, sessions, sessionLog, attachTelemetry, feedback } =
      await createCliAgent({ live: false }, [
        ...DEFAULT_PLUGINS,
        createTelemetryOtelPlugin({ mode: 'feedback-only', exporter: { url: collector.url } }),
      ]);
    attachTelemetry(sessions);

    try {
      await runTurn(agent, '嗨', silent, sessionLog);
      feedback!.record(sessionLog, { text: '會話評語原文' });
      const put = feedback!.put(sessionLog, {
        messageId: ratableReply(sessionLog),
        rating: 'negative',
        note: '評分備註原文',
        ifVersion: null,
      });
      expect(put.ok).toBe(true);
    } finally {
      // 關機是排空點：batch processor 預設 5 秒才送，靠時間等會變成計時器賽跑。
      await dispose();
      collector.close();
    }

    const sent = collector.bodies.join('\n');
    expect(sent).toContain('turn/start');
    expect(sent).toContain('會話評語原文');
    expect(sent).toContain('評分備註原文');
    // on-demand 不發 ops 記錄。
    expect(sent).not.toContain('telemetry.op');
  });
});
