/**
 * **產品組裝的接線：重試政策真的進到了每一個入口**（[#1427](https://github.com/DemianLi/nexus-agent/issues/1427)）。
 *
 * `stream-retry.test.ts` 與 `live-model-retry-events.test.ts` 都是自己把 `streamRetry` 傳進 `createNexusAgent`，
 * 或直接呼叫 `retryModelCall`——所以把 `assembly-root.ts` 裡傳 `streamRetry`／`retry` 的那一行拿掉，它們不會紅，
 * 產品只是**靜靜變成不重試**（SDK 層又是 `maxRetries: 0`）。這一檔走真的組裝路徑，一個入口一條：
 *
 * | 入口 | 走法 | 拿掉哪一行會紅 |
 * | --- | --- | --- |
 * | 主呼叫 | CLI `--live`，loopback 端點固定回 503，`--patch` 把 `retryPolicy` 縮小 | `assembly-root.ts` 的 `streamRetry: streamRetryOptionsOf(…)` |
 * | 標題 | 同上，標題請求第一次 503、第二次成功 | `assembly-root.ts` 的 `retry: streamRetryOptionsOf(…)` |
 * | 摘要器生摘要 | `createNexusAgent`＋訊息數門檻，生摘要第一次失敗、第二次成功 | `fold.ts` 的 `createSummarizer(…, options.streamRetry)` |
 *
 * 摘要器那一條走 `createNexusAgent`、不走 CLI：一次性的 CLI 只有一輪，湊不出「第二輪才摘要」；而摘要器拿的就是組裝點交給
 * `createNexusAgent` 的同一份 `streamRetry`，主呼叫那一條已經釘住組裝點有交。
 *
 * **零憑證、零外部連線**：端點是 loopback 上的假伺服器，key 用 `vi.stubEnv` 給一把假的。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { MemorySaver } from '@langchain/langgraph';
import { noteStreamFailure } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { runCli } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { LIVE_API_KEY_ENV } from './live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const FAKE_KEY = 'nvapi-fake-for-loopback-only';
/** 重試用兩次、退避 1 毫秒：N = 2，一次主呼叫最多打 3 次。 */
const RETRIES = 2;
const POLICY =
  `    retryPolicy: { mode: normal, maxRetries: ${String(RETRIES)}, ` +
  'backoff: { initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 } }';

async function writePatch(lines: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-retry-wiring-'));
  const path = join(dir, 'patch.yml');
  await writeFile(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

interface Seen {
  readonly title: boolean;
}

/** 標題成功的回應寫完之後，再等這麼久才放主請求回：夠標題那一路把結果寫進日誌，遠大於一次事件迴圈的往返。 */
const TITLE_LANDING_SLACK_MS = 100;
/** 等標題的上限。標題一直不回就不等了，讓斷言去講「標題沒進日誌」，而不是整個測試逾時。 */
const TITLE_WAIT_CAP_MS = 5000;

/**
 * 假端點。`answer(title, nth)` 回 `'503'` 或 `'ok'`；`nth` 是這一類請求（標題／主）的第幾次，從 1 起。
 * 主請求的成功回串流，標題的成功回一般 JSON。
 *
 * **主請求會等標題先答完**：標題 LLM 不在任何一輪裡，一次性 CLI 的收尾會先拆它（`cli.ts` 的 `detachTitle`，
 * 「行程多半比標題先結束」，#650）——主回應一結束，還在退避或還在飛的標題就被中止、寫不進日誌。標題那條測試要斷言
 * 「第二次成功的標題進了日誌」，就得讓主回應排在標題成功之後，否則斷言取決於兩條路誰先回來（負載重的 CI 上會輸）。
 * 沒有標題請求的測試（標題被關掉）不受影響：永遠等不到，所以只有 `holdMainForTitle` 開著才等。
 */
async function endpoint(
  answer: (title: boolean, nth: number) => '503' | 'ok',
  options: { readonly holdMainForTitle?: boolean } = {},
) {
  const seen: Seen[] = [];
  const counts = { title: 0, main: 0 };
  let titleLanded!: () => void;
  const titleAnswered = new Promise<void>((resolve) => {
    titleLanded = resolve;
  });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (piece: Buffer) => chunks.push(piece));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        stream?: boolean;
        messages: { role: string; content: unknown }[];
      };
      const first = body.messages[0];
      const title =
        first?.role === 'system' &&
        typeof first.content === 'string' &&
        first.content.startsWith('Create a concise title');
      seen.push({ title });
      counts[title ? 'title' : 'main'] += 1;
      const id = `chatcmpl-wiring-${String(seen.length)}`;
      if (answer(title, counts[title ? 'title' : 'main']) === '503') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: '上游出事了', type: 'upstream' } }));
        return;
      }
      // 主請求等標題先答完（見 `endpoint` 的說明）。CLI 的主呼叫走非串流、pump 走串流，兩條都要等。
      const hold = (): Promise<void> =>
        !title && options.holdMainForTitle === true
          ? Promise.race([
              titleAnswered,
              new Promise<void>((resolve) => setTimeout(resolve, TITLE_WAIT_CAP_MS)),
            ])
          : Promise.resolve();
      if (body.stream !== true) {
        void hold().then(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id,
              object: 'chat.completion',
              created: 1_790_000_000,
              model: 'fake',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: '一個標題' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
          if (title) {
            response.on('finish', () => {
              setTimeout(titleLanded, TITLE_LANDING_SLACK_MS);
            });
          }
        });
        return;
      }
      const piece = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 1_790_000_000,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      void hold().then(() => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(piece({ role: 'assistant', content: '' }, null));
        response.write(piece({ content: '好' }, null));
        response.write(piece({}, 'stop'));
        response.end('data: [DONE]\n\n');
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    seen,
    counts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function cliEvents(root: string): Promise<SessionEvent[]> {
  const [runDir] = await readdir(root);
  return (await readFile(join(root, runDir!, 'cli.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

describe('產品組裝：模型請求的重試政策接到了每個入口', () => {
  let upstream: Awaited<ReturnType<typeof endpoint>> | undefined;

  beforeEach(() => {
    vi.stubEnv(LIVE_API_KEY_ENV, FAKE_KEY);
  });
  afterEach(async () => {
    if (upstream !== undefined) await upstream.close();
    upstream = undefined;
    vi.unstubAllEnvs();
  });

  async function runOnce(extra: readonly string[]) {
    const root = await mkdtemp(join(tmpdir(), 'nexus-retry-wiring-log-'));
    const patch = await writePatch([
      '- id: live-model',
      '  config:',
      `    baseUrl: '${upstream!.baseUrl}'`,
      POLICY,
      ...extra,
    ]);
    const errors: string[] = [];
    const outcome = await runCli({
      argv: ['--live', '--session-log', root, '--patch', patch, '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: () => undefined, error: (line) => void errors.push(line) },
      env: {},
    }).then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    return { events: await cliEvents(root), errors, outcome };
  }

  it('主呼叫：端點固定回 503，打了 N+1 次、日誌有 N 顆 llm/retry', async () => {
    upstream = await endpoint(() => '503');
    const { events } = await runOnce(['- id: thread-title-llm', '  disabled: true']);
    expect(upstream.counts.title).toBe(0);
    expect(upstream.counts.main).toBe(RETRIES + 1);
    expect(events.filter((event) => event.type === 'llm/retry')).toHaveLength(RETRIES);
    // 每次嘗試各一對起訖。
    expect(events.filter((event) => event.type === 'model/start')).toHaveLength(RETRIES + 1);
  }, 30000);

  it('標題：第一次 503、第二次成功，標題請求打了兩次，模型標題進了日誌', async () => {
    upstream = await endpoint((title, nth) => (title && nth === 1 ? '503' : 'ok'), {
      holdMainForTitle: true,
    });
    const { events } = await runOnce([]);
    expect(upstream.counts.title).toBe(2);
    expect(upstream.counts.main).toBe(1);
    const titles = events.filter((event) => event.type === 'session/title');
    expect(titles.map((event) => (event.data as { source: { kind: string } }).source.kind)).toEqual(
      ['fallback', 'provider'],
    );
  }, 30000);
});

/** 墊料：回話要夠大，保留量（250 token）才切得出舊的一段來摘要（同 `overflow-after-summary.test.ts`）。 */
const PAD = '內容'.repeat(80);

/** 第 `failOn` 次生摘要的呼叫拋一顆「回報過的可重試失敗」，其餘成功。 */
class SummaryFlakyModel extends BaseChatModel {
  constructor(
    private readonly shared: { summaryCalls: number; mainCalls: number },
    private readonly failOn: number,
  ) {
    super({});
  }

  _llmType(): string {
    return 'summary-flaky';
  }

  override bindTools(): SummaryFlakyModel {
    return new SummaryFlakyModel(this.shared, this.failOn);
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const isSummary = messages[0]?.getType() !== 'system';
    if (isSummary) {
      this.shared.summaryCalls += 1;
      if (this.shared.summaryCalls === this.failOn) {
        noteStreamFailure({ code: 'SERVER', status: 503 });
        throw new Error('503 上游出事了');
      }
    } else {
      this.shared.mainCalls += 1;
    }
    const message = new AIMessage(isSummary ? '摘要。' : `回話。${PAD}`);
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  }
}

describe('產品組裝：摘要器生摘要的那一次呼叫吃同一份政策', () => {
  it('第一次生摘要失敗、第二次成功：重打一次，這一輪照常收完', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-retry-wiring-sum-'));
    const shared = { summaryCalls: 0, mainCalls: 0 };
    const built = await createNexusAgent({
      model: new SummaryFlakyModel(shared, 1),
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      checkpointer: new MemorySaver(),
      plugins: [],
      streamRetry: { maxRetries: RETRIES, initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
      // 第 2 輪進來是 3 則，到了訊息數門檻。
      summarization: { trigger: [{ type: 'messages', value: 3 }], retainTokens: 250 },
    });
    const pump = new ThreadPump(
      built.agent as unknown as PumpAgent,
      'retry-wiring-summary',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      built.stepInbox,
    );
    const detach = built.attachSession(pump.sessions);
    try {
      for (let turn = 1; turn <= 2; turn += 1) {
        await pump.submit({
          kind: 'message',
          text: `第 ${turn} 句。${'內容'.repeat(200)}`,
          id: `m${turn}`,
        });
        await pump.whenIdle();
      }
      // 生摘要打了兩次（第一次失敗、重打成功），主呼叫每輪一次。
      expect(shared.summaryCalls).toBe(2);
      expect(shared.mainCalls).toBe(2);
      const events = [...pump.sessionLog.events];
      expect(events.filter((event) => event.type === 'compaction/summary')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'turn/failed')).toEqual([]);
    } finally {
      pump.close();
      detach();
      await built.dispose();
    }
  }, 30000);
});
