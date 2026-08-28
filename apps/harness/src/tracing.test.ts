/**
 * tracing 的**行為**驗收。
 *
 * 計劃原本寫的是「LangSmith tracing 接線」。動工前一驗，那是不存在的工作——
 * `CallbackManager.configure` 讀到環境變數就自己 `new LangChainTracer()`
 * （`@langchain/core@1.2.9`，`dist/callbacks/manager.js:523-541`），我們一行都不用寫。
 * 而且原本判斷「CI 沒憑證所以驗不了」也是錯的：**要的不是憑證，是一個會收東西的端點**。
 * 這一份就起一個 `127.0.0.1` 的 http server 當那個端點，配一把假 key，
 * 於是驗收句從「LangSmith 能看到完整 trace」翻成**完整到什麼程度**。
 *
 * 三條實測，一條披露的單元測試：
 *
 * 1. 只設環境變數，工具參數的原文就出境了。**這是另外兩條的正對照**——沒有它，
 *    「沒外洩」同樣被「tracing 壓根沒開」「端點打錯」滿足。
 * 2. `LANGSMITH_HIDE_INPUTS` / `HIDE_OUTPUTS` 是全有全無的煞車（**在另一個檔案**，
 *    理由見 {@link tracing-hidden.test.ts} 與下面 singleton 那段）。
 * 3. 自備一個帶 `hideInputs` 函式的 `Client`，基座會讓路——所以 dsh 的脫敏 waterfall
 *    在這裡表達得出來，不是偏離。
 *
 * **singleton 陷阱**：`getDefaultLangChainClientSingleton()` 是 module-private 的
 * `let client`，沒有 setter（`dist/singletons/tracer.js`）。一個 process 裡第一次觸發
 * tracing 時的設定就定生死，之後改環境變數沒用。所以（a）整個檔案共用同一台 server，
 * 端點不能中途換；（b）要驗不同的 client 設定就得換檔案。實測過換不掉：第二條測試
 * 改了環境變數之後，送出去的請求還是打向第一台已經關掉的 server，重試了 17 秒。
 *
 * 每一條「沒外洩」都**先確認東西真的送到了**（`waitForHits`）再斷言內容。順序反過來
 * 的話，一個什麼都沒送的組裝會讓所有負面斷言全綠。
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { tool } from '@langchain/core/tools';
import type { NexusPlugin } from '@nexus/core';
import { Client } from 'langsmith';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import { formatTracingDisclosure, readTracingDisclosure } from './tracing.js';

/** 這串會被工具當參數收下。它出不出現在請求 body 裡，就是這組測試的判準。 */
const SECRET = 'sk-機密值-12345';

/** 假的收件端點會動到的環境變數，每條測試跑完清乾淨。 */
const TRACING_ENV = [
  'LANGSMITH_TRACING',
  'LANGSMITH_ENDPOINT',
  'LANGSMITH_API_KEY',
  'LANGSMITH_PROJECT',
  'LANGCHAIN_CALLBACKS_BACKGROUND',
  // 這個是 apiUrl 之外**另一條**扇出路徑：本機若設了它，trace 會同時往那些端點送。
  // CI 不會設，但開發機可能——所以每次都清掉，跟把端點釘死在 loopback 是同一個理由。
  'LANGSMITH_RUNS_ENDPOINTS',
] as const;

let server: Server;
let endpoint = '';
let hits: string[] = [];

// 整個檔案一台 server：端點一旦被 client singleton 記住就換不掉了（見檔頭）。
beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      hits.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = [];
});

afterEach(() => {
  for (const name of TRACING_ENV) delete process.env[name];
});

/**
 * 把 tracing 指向本機那台假 server。
 *
 * **`LANGSMITH_TRACING` 一定最後才設**，而且設之前先確認端點是 loopback。順序反過來
 * 的話，中間任何一次提早 return 或改寫都會讓一個已經開著的 tracer 指向真正的
 * LangSmith——假 key 換來的 401 是在 body 送出**之後**才發生的事。
 */
function armTracing(): void {
  delete process.env.LANGSMITH_RUNS_ENDPOINTS;
  process.env.LANGSMITH_ENDPOINT = endpoint;
  process.env.LANGSMITH_API_KEY = 'ls-fake-for-test';
  process.env.LANGSMITH_PROJECT = 'nexus-tracing-test';
  // 把 client 換成同步送出，測試才不必睡覺等背景 flush
  //（`dist/singletons/tracer.js` 把它翻成 `blockOnRootRunFinalization: true`）。
  process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';
  expect(process.env.LANGSMITH_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  process.env.LANGSMITH_TRACING = 'true';
}

/** 等到請求真的收到為止。**斷言「沒外洩」之前一定要先過這一關。** */
async function waitForHits(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (hits.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(hits.length).toBeGreaterThanOrEqual(count);
}

const plugin: NexusPlugin = {
  name: 'tracing-probe',
  apply: (registry) =>
    void registry.tools.register(
      tool(({ secret }) => `讀到了：${secret}`, {
        name: 'probe_tool',
        description: '把收到的東西唸一次。',
        schema: z.object({ secret: z.string().describe('一串不該出境的東西') }),
      }),
    ),
};

/** 跑一輪：模型拿 {@link SECRET} 當參數呼叫工具，然後收工。 */
async function runOneTurn(callbacks?: readonly unknown[]): Promise<void> {
  const model = new ScriptedChatModel({
    turns: [
      { content: '', toolCalls: [{ name: 'probe_tool', args: { secret: SECRET } }] },
      { content: '唸完了。' },
    ],
  });
  const { agent, dispose } = await createNexusAgent({ model, plugins: [plugin] });
  try {
    await agent.invoke(
      toAgentInvocation('唸一下。'),
      callbacks === undefined ? undefined : ({ callbacks } as never),
    );
  } finally {
    await dispose();
  }
}

describe('tracing 不需要我們接線', () => {
  it('只設環境變數就送出去，而且工具參數是原文', async () => {
    armTracing();
    await runOneTurn();
    await waitForHits(2);

    const body = hits.join('');
    // 這一條是整組測試的正對照：東西真的送得出去，路是通的。
    expect(body).toContain(SECRET);
  });

  it('自備帶脫敏函式的 client，基座讓路', async () => {
    armTracing();
    // 自己組一份 client：環境變數只給得起「全有全無」，函式版的脫敏只能這樣進來。
    const client = new Client({
      apiUrl: endpoint,
      apiKey: 'ls-fake-for-test',
      blockOnRootRunFinalization: true,
      hideInputs: () => ({ 已脫敏: true }),
      hideOutputs: () => ({ 已脫敏: true }),
    });
    await runOneTurn([new LangChainTracer({ client })]);
    await waitForHits(2);

    const body = hits.join('');
    // 兩條一起才有意義：脫敏標記在（我們那份確實跑了）＋ 原文不在（基座沒有另外
    // 掛一份自己的 tracer 把原文也送一遍）。少了前者，「什麼都沒送」也會過。
    expect(body).toContain('已脫敏');
    expect(body).not.toContain(SECRET);
  });
});

describe('披露讀得出當前設定', () => {
  it('四個環境變數任一為 true 就算開著，其他值不算', () => {
    expect(readTracingDisclosure({ LANGCHAIN_TRACING_V2: 'true' }).enabled).toBe(true);
    expect(readTracingDisclosure({ LANGSMITH_TRACING: 'true' }).enabledBy).toBe(
      'LANGSMITH_TRACING',
    );
    // 基座比的是 `=== 'true'`，所以這些都不算開——披露跟著它，不自己發明寬鬆規則。
    expect(readTracingDisclosure({ LANGSMITH_TRACING: '1' }).enabled).toBe(false);
    expect(readTracingDisclosure({ LANGSMITH_TRACING: 'TRUE' }).enabled).toBe(false);
    expect(readTracingDisclosure({}).enabled).toBe(false);
  });

  it('LANGSMITH_ 找不到會退到 LANGCHAIN_', () => {
    const disclosure = readTracingDisclosure({
      LANGSMITH_TRACING: 'true',
      LANGCHAIN_ENDPOINT: 'https://example.invalid',
      LANGCHAIN_HIDE_INPUTS: 'true',
    });
    expect(disclosure.endpoint).toBe('https://example.invalid');
    expect(disclosure.inputsHidden).toBe(true);
  });

  it('關著的時候講的是肯定句，不是留白', () => {
    const lines = formatTracingDisclosure(readTracingDisclosure({}));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('關閉');
    // 披露只管 tracing 這一道 seam。`--live` 的模型閘道與 MCP 是另外的出境路徑，
    // 所以這一行不准把話講到「沒有東西離開這台機器」那麼大。
    expect(lines[0]).toContain('trace');
    expect(lines[0]).not.toContain('這台機器');
  });

  it('開著就說出是誰開的、送去哪、送的是不是原文', () => {
    const lines = formatTracingDisclosure(
      readTracingDisclosure({
        LANGSMITH_TRACING: 'true',
        LANGSMITH_ENDPOINT: 'https://example.invalid',
        LANGSMITH_PROJECT: 'demo',
      }),
    ).join('\n');
    expect(lines).toContain('LANGSMITH_TRACING');
    expect(lines).toContain('https://example.invalid');
    expect(lines).toContain('demo');
    expect(lines).toContain('原文');
  });

  it('環境變數沒指名終點就不宣稱終點', () => {
    const lines = formatTracingDisclosure(
      readTracingDisclosure({ LANGSMITH_TRACING: 'true' }),
    ).join('\n');
    // 磁碟上的 `~/.langsmith/config.json` 是第二個寫入者，這支程式看不到它，
    // 所以不能說「送去預設端點」——那會在有 profile 的機器上說謊。
    expect(lines).toContain('看不到');
    expect(lines).not.toContain('api.smith.langchain.com');
  });

  it('key 一個字元都不印', () => {
    const lines = formatTracingDisclosure(
      readTracingDisclosure({
        LANGSMITH_TRACING: 'true',
        LANGSMITH_API_KEY: 'lsv2_pt_不該出現在畫面上',
        LANGSMITH_ENDPOINT: 'https://example.invalid',
      }),
    ).join('\n');
    expect(lines).not.toContain('lsv2_pt_不該出現在畫面上');
    expect(lines).not.toContain('lsv2');
  });
});
