/**
 * OTel 後端：**對著一個 `node:http` 的假 collector、走 SDK 真正的流水線**
 * （BatchLogRecordProcessor → OTLP/HTTP JSON），加上設定的 fail-loud。
 *
 * 測法照 dsh 的
 * `references/deepseek-harness/packages/session/session-telemetry-otel/tests/otel.spec.ts`：
 * `createServer` 綁 `127.0.0.1:0`，收 `/v1/logs`。**零憑證、零外部連線**——缺的從來
 * 不是憑證，是對手方，而 loopback 假端點就是對手方。
 */

import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { once } from 'node:events';

import { SessionLog, SessionTelemetryCoordinator, createRegistry, loadPlugins } from '@nexus/core';
import type { SessionTelemetrySink } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TELEMETRY_MODE,
  OpenTelemetrySessionService,
  createTelemetryOtelPlugin,
} from './index.js';

/** OTLP/JSON 裡這些斷言碰得到的那幾格。 */
interface OtlpLogsRequest {
  resourceLogs: {
    resource: { attributes: { key: string; value: { stringValue?: string } }[] };
    scopeLogs: {
      scope: { name: string };
      logRecords: {
        timeUnixNano: string;
        severityNumber: number;
        severityText: string;
        attributes?: { key: string; value: Record<string, unknown> }[];
        body?: unknown;
      }[];
    }[];
  }[];
}

interface Capture {
  headers: IncomingHttpHeaders;
  body: OtlpLogsRequest;
}

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
    server.closeAllConnections();
  }
});

/**
 * 起一個假 collector。
 * @param hang - 收到請求後永遠不回應，用來驗關機期限。
 * @returns 端點 URL 與收到的每一次請求。
 */
async function mockCollector(hang = false): Promise<{ url: string; captures: Capture[] }> {
  const captures: Capture[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => void chunks.push(chunk));
    request.on('end', () => {
      if (hang) return;
      captures.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()) as OtlpLogsRequest,
      });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('沒有拿到 port');
  return { url: `http://127.0.0.1:${address.port}/v1/logs`, captures };
}

function allRecords(captures: readonly Capture[]) {
  return captures.flatMap((capture) =>
    capture.body.resourceLogs.flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) =>
        scope.logRecords.map((record) => ({ scope: scope.scope.name, record })),
      ),
    ),
  );
}

function attributeOf(
  record: { attributes?: { key: string; value: Record<string, unknown> }[] },
  key: string,
): unknown {
  const found = record.attributes?.find((attribute) => attribute.key === key);
  return found === undefined ? undefined : Object.values(found.value)[0];
}

function resourceAttributes(captures: readonly Capture[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const capture of captures) {
    for (const resource of capture.body.resourceLogs) {
      for (const attribute of resource.resource.attributes) {
        out[attribute.key] = attribute.value.stringValue;
      }
    }
  }
  return out;
}

describe('設定驗證', () => {
  it('預設是關閉的——不送才是預設值', () => {
    expect(DEFAULT_TELEMETRY_MODE).toBe('disabled');
    expect(new OpenTelemetrySessionService().sharing).toBe('disabled');
  });

  it('full 少了 exporter.url 當場拋，訊息指名欄位', () => {
    expect(() => new OpenTelemetrySessionService({ mode: 'full' })).toThrow('exporter.url 是必填');
  });

  it('exporter.url 不是合法 URL 就拋', () => {
    expect(
      () => new OpenTelemetrySessionService({ mode: 'full', exporter: { url: '不是網址' } }),
    ).toThrow('不是合法的 URL');
  });

  it('exporter.url 必須是 http(s)', () => {
    expect(
      () =>
        new OpenTelemetrySessionService({
          mode: 'full',
          exporter: { url: 'ftp://collector.example.com/v1/logs' },
        }),
    ).toThrow('必須是 http(s)');
  });

  it('maxExportBatchSize 非正整數就拋——SDK 收得下，但關機會永遠掛住', async () => {
    const { url } = await mockCollector();
    expect(
      () =>
        new OpenTelemetrySessionService({
          mode: 'full',
          exporter: { url },
          processor: { maxExportBatchSize: 0 },
        }),
    ).toThrow('maxExportBatchSize 必須是正整數');
  });

  it('shutdownTimeoutMillis 超出範圍就拋', async () => {
    const { url } = await mockCollector();
    for (const millis of [0, -1, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(
        () =>
          new OpenTelemetrySessionService({
            mode: 'full',
            exporter: { url },
            shutdownTimeoutMillis: millis,
          }),
      ).toThrow('shutdownTimeoutMillis');
    }
  });

  it('disabled 不看 exporter.url，也不建任何 SDK 狀態', async () => {
    const service = new OpenTelemetrySessionService({ mode: 'disabled' });
    expect(service.sharing).toBe('disabled');
    service.emit({ channel: 'ledger', time: 1, severity: 'info', attributes: {}, body: {} });
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
});

describe('flush 這一格刻意是空的', () => {
  it('後端不實作 flush()——並行 flush 跟 shutdown 排空的互動沒有文件', () => {
    // 刻意以 seam 的型別讀：`flush?` 那一格在契約上存在，這個後端就是沒有填。
    const service: SessionTelemetrySink = new OpenTelemetrySessionService();
    expect(service.flush).toBeUndefined();
  });
});

describe('走 SDK 真正的流水線送到假 collector', () => {
  it('日誌事件變成 OTLP 記錄，識別、severity、body 都對得上', async () => {
    const { url, captures } = await mockCollector();
    const service = new OpenTelemetrySessionService({
      mode: 'full',
      exporter: { url, headers: { authorization: 'Bearer test-token' } },
      serviceName: 'nexus-agent-test',
      serviceVersion: '9.9.9',
    });
    const log = new SessionLog('thread-otel');
    const coordinator = new SessionTelemetryCoordinator({ log, sink: service });

    log.append('turn/start', { kind: 'message', text: '你好' });
    log.append('turn/failed', { message: '模型炸了' });

    // 關機才是排空點：batch processor 的 scheduledDelayMillis 預設 5 秒，
    // 靠時間等會讓這條測試變成計時器賽跑。
    await coordinator.dispose();

    const records = allRecords(captures);
    expect(records.length).toBeGreaterThanOrEqual(3);

    const ledger = records.filter((entry) => entry.scope === '@nexus/plugin-telemetry-otel');
    expect(ledger.map((entry) => attributeOf(entry.record, 'event.type'))).toEqual([
      'turn/start',
      'turn/failed',
    ]);
    // `event.seq` 過線之後仍然是**數字**（OTLP 的 intValue），不是字串——去重鍵的型別
    // 在這條線上沒有被壓成字串，收端可以直接比大小。
    expect(ledger.map((entry) => attributeOf(entry.record, 'event.seq'))).toEqual([0, 1]);
    expect(ledger.every((entry) => attributeOf(entry.record, 'session.id') === 'thread-otel')).toBe(
      true,
    );
    // severity 是捕獲當下映好的：失敗那筆是 ERROR(17)，其餘 INFO(9)。
    expect(ledger.map((entry) => entry.record.severityText)).toEqual(['INFO', 'ERROR']);
    expect(ledger.map((entry) => entry.record.severityNumber)).toEqual([9, 17]);
  });

  it('ledger 與 ops 落在兩個不同的 scope，收端因此分得開', async () => {
    const { url, captures } = await mockCollector();
    const service = new OpenTelemetrySessionService({ mode: 'full', exporter: { url } });
    const log = new SessionLog('thread-otel');
    const coordinator = new SessionTelemetryCoordinator({ log, sink: service });

    log.append('turn/end', {});
    await coordinator.dispose();

    const scopes = new Set(allRecords(captures).map((entry) => entry.scope));
    expect(scopes).toEqual(
      new Set(['@nexus/plugin-telemetry-otel', '@nexus/plugin-telemetry-otel/ops']),
    );
    const ops = allRecords(captures).find(
      (entry) => entry.scope === '@nexus/plugin-telemetry-otel/ops',
    );
    expect(attributeOf(ops!.record, 'telemetry.op')).toBe('shutdown');
    // ops 記錄刻意不帶 ledger 的識別。
    expect(attributeOf(ops!.record, 'event.seq')).toBeUndefined();
  });

  it('exporter 的選項原樣轉交：headers 真的出現在請求上', async () => {
    const { url, captures } = await mockCollector();
    const service = new OpenTelemetrySessionService({
      mode: 'full',
      exporter: { url, headers: { authorization: 'Bearer test-token' } },
    });
    const log = new SessionLog('thread-otel');
    const coordinator = new SessionTelemetryCoordinator({ log, sink: service });
    log.append('turn/end', {});
    await coordinator.dispose();

    expect(captures[0]?.headers['authorization']).toBe('Bearer test-token');
  });

  it('Resource 帶 service.name / service.version，而且沒有 user.id', async () => {
    const { url, captures } = await mockCollector();
    const service = new OpenTelemetrySessionService({
      mode: 'full',
      exporter: { url },
      serviceName: 'nexus-agent-test',
      serviceVersion: '9.9.9',
    });
    const log = new SessionLog('thread-otel');
    const coordinator = new SessionTelemetryCoordinator({ log, sink: service });
    log.append('turn/end', {});
    await coordinator.dispose();

    const attributes = resourceAttributes(captures);
    expect(attributes['service.name']).toBe('nexus-agent-test');
    expect(attributes['service.version']).toBe('9.9.9');
    // dsh 有一個匿名的 `user.id`，我們不編一個——偏離的方向是往少送那一邊。
    expect(Object.keys(attributes)).not.toContain('user.id');
  });

  it('脫敏規則的產物才是送出去的東西', async () => {
    const { url, captures } = await mockCollector();
    const service = new OpenTelemetrySessionService({ mode: 'full', exporter: { url } });
    const log = new SessionLog('thread-otel');
    const coordinator = new SessionTelemetryCoordinator({
      log,
      sink: service,
      rules: () => [
        {
          value: (record) => ({ ...record, body: { kind: 'message', text: '[已脫敏]' } }),
          origin: { id: 'scrub#0', name: 'scrub' },
        },
      ],
    });

    log.append('turn/start', { kind: 'message', text: 'sk-notasecret-fixture' });
    await coordinator.dispose();

    const wire = JSON.stringify(captures);
    expect(wire).toContain('已脫敏');
    expect(wire).not.toContain('sk-notasecret-fixture');
  });

  it('collector 不回應時，關機在自己的期限上 reject 而不是永遠等', async () => {
    const { url } = await mockCollector(true);
    const service = new OpenTelemetrySessionService({
      mode: 'full',
      exporter: { url },
      shutdownTimeoutMillis: 120,
    });
    const log = new SessionLog('thread-otel');
    const warnings: string[] = [];
    const coordinator = new SessionTelemetryCoordinator({
      log,
      sink: service,
      warn: (message) => void warnings.push(message),
    });
    log.append('turn/end', {});

    // 期限真的到得了，而且協調器把它圍堵成一行 warn——**盡力而為的旁路不該有讓應用
    // 程式關機失敗的權力**。兩件事一起驗：dispose 自己 resolve、warn 說得出原因。
    await expect(coordinator.dispose()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('provider 關機超過 120ms');
  }, 10_000);
});

describe('plugin 這一層', () => {
  it('apply 把服務掛上註冊點，披露讀得到它的策略', async () => {
    const { url } = await mockCollector();
    const registry = createRegistry();
    await loadPlugins([createTelemetryOtelPlugin({ mode: 'full', exporter: { url } })], registry);

    expect(registry.telemetry.service()?.value.sharing).toBe('full');
    expect(registry.telemetry.service()?.origin.name).toBe('telemetry-otel');
    await registry.telemetry.service()!.value.shutdown();
  });

  it('設定錯誤在建 plugin 的當下就拋，不會拖到載入或跑起來', () => {
    expect(() => createTelemetryOtelPlugin({ mode: 'full' })).toThrow('exporter.url 是必填');
  });
});
