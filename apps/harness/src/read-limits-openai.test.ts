/**
 * **模型真的收到的 `read_file` 說明講 2000 行、`limit` 不必填**——[#602](https://github.com/DemianLi/nexus-agent/issues/602)
 * 的驗收，量在 HTTP 那一層。
 *
 * 說明是在模型呼叫時換掉的（`@nexus/core` 的 `read-continuation.ts`，偏離一）：換出來的是一份 OpenAI 形狀的
 * 定義，不是工具。它能不能過 langchain 的工具驗證、`bindTools` 收不收、序列化進請求本體長什麼樣，
 * `ScriptedChatModel` 都答不了——它只記工具名。所以對手方是本機的假 Chat Completions 端點，記下每一次
 * 請求的 `tools`，兩種抽法都走：`agent.invoke`（CLI 那條，非串流）與 `ThreadPump`（serve 那條，串流）。
 * 每一條都經過一次委派，子代理的請求一起量。
 *
 * **零憑證、零外部連線。**
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

interface ToolDefinition {
  readonly type: string;
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: {
      readonly properties: Record<string, unknown>;
      readonly required?: string[];
    };
  };
}

interface RecordedRequest {
  readonly tools: ToolDefinition[];
  readonly messages: { role: string; content: unknown }[];
  readonly stream: boolean;
}

/** 一步：模型這一次回什麼。有 `call` 就是叫一個工具。 */
interface Step {
  readonly call?: { readonly name: string; readonly args: Record<string, unknown> };
  readonly text?: string;
}

/**
 * 照腳本回話的 Chat Completions 端點，串流與非串流都接。每一次請求記下 `tools` 與 `messages`。
 * **每次回的 id 都不同**：同 id 的 AI 訊息會被 reducer 取代，歷史少一截。
 */
async function scriptedOpenAi(steps: readonly Step[]) {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as {
        tools?: ToolDefinition[];
        messages?: { role: string; content: unknown }[];
        stream?: boolean;
      };
      const index = requests.length;
      requests.push({
        tools: parsed.tools ?? [],
        messages: parsed.messages ?? [],
        stream: parsed.stream === true,
      });
      const step = steps[index] ?? { text: '（腳本用完）' };
      const toolCalls =
        step.call === undefined
          ? undefined
          : [
              {
                id: `call_${index}`,
                type: 'function',
                function: { name: step.call.name, arguments: JSON.stringify(step.call.args) },
              },
            ];
      const finish = toolCalls === undefined ? 'stop' : 'tool_calls';
      if (parsed.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `resp_${index}`,
            object: 'chat.completion',
            created: 0,
            model: 'fake',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: step.text ?? '', tool_calls: toolCalls },
                finish_reason: finish,
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        `data: ${JSON.stringify({
          id: `resp_${index}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: step.text ?? '' }));
      if (toolCalls !== undefined) {
        res.write(
          chunk({ tool_calls: toolCalls.map((call, position) => ({ index: position, ...call })) }),
        );
      }
      res.write(chunk({}, finish));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** `n` 行的檔，第 i 行（1 起算）是 `line i`，結尾有換行。 */
function numbered(n: number): string {
  return `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
}

/** root 委派一次、子代理不帶 `limit` 讀一次，回來後 root 帶一個超過上限的 `limit` 讀一次。 */
const SCRIPT: readonly Step[] = [
  {
    call: {
      name: 'task',
      args: { description: '讀 /big.txt 回報行數', subagent_type: 'general-purpose' },
    },
  },
  { call: { name: 'read_file', args: { file_path: '/big.txt' } } },
  { text: '讀了。' },
  { call: { name: 'read_file', args: { file_path: '/big.txt', limit: 3000 } } },
  { text: '收工。' },
];

/** 一次請求裡模型拿到的所有工具訊息文字。 */
function toolTexts(request: RecordedRequest | undefined): string[] {
  return (request?.messages ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    );
}

/** 共用的判準：每一次帶了 `read_file` 的請求、子代理那兩次也算。 */
function expectDshReadFile(requests: readonly RecordedRequest[]): void {
  expect(requests).toHaveLength(SCRIPT.length);
  for (const [index, request] of requests.entries()) {
    const read = request.tools.find((tool) => tool.function.name === 'read_file');
    expect(read, `第 ${index} 次請求`).toBeDefined();
    expect(read?.function.description).toContain('By default, it reads up to 2000 lines');
    expect(read?.function.description).not.toContain('100 lines');
    expect(read?.function.parameters.properties.limit).toEqual({
      type: 'number',
      description: 'Maximum number of lines to return. Defaults to 2000.',
    });
    expect(read?.function.parameters.required ?? []).not.toContain('limit');
    // 不可列舉的 `name` 沒有序列化進去：每個工具都只有 `type` 與 `function`。
    for (const tool of request.tools)
      expect(Object.keys(tool).sort()).toEqual(['function', 'type']);
  }
  // 子代理不帶 `limit`：一次讀到 2000 行。這一則回到子代理的第二次請求裡。
  expect(toolTexts(requests[2]).join('\n')).toContain(
    '(Showing lines 1-2000 of 2500. Use offset=2000 to continue.)',
  );
  // root 帶 3000：dsh 的原句，由圍堵轉成工具錯誤。
  const last = toolTexts(requests[4]).at(-1) ?? '';
  expect(last).toContain('limit must be less than or equal to 2000');
  expect(last).not.toContain('line 1');
}

describe('模型真的收到的 read_file', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-read-limits-'));
    await writeFile(join(root, 'big.txt'), numbered(2500));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function build(baseURL: string) {
    return createNexusAgent({
      model: new ChatOpenAI({
        model: 'fake',
        apiKey: 'sk-loopback',
        maxRetries: 0,
        configuration: { baseURL },
      }),
      backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
      checkpointer: new MemorySaver(),
      plugins: [],
    });
  }

  it('CLI 那條（invoke，非串流）：root 與子代理的每一次請求都是 dsh 的說明', async () => {
    const upstream = await scriptedOpenAi(SCRIPT);
    const built = await build(upstream.baseURL);
    try {
      await built.agent.invoke(toAgentInvocation('讀。'), {
        configurable: { thread_id: 'read-limits-cli' },
      });
      expect(upstream.requests.every((request) => !request.stream)).toBe(true);
      expectDshReadFile(upstream.requests);
    } finally {
      await built.dispose();
      await upstream.close();
    }
  }, 20000);

  it('serve 那條（ThreadPump，串流）：一樣', async () => {
    const upstream = await scriptedOpenAi(SCRIPT);
    const built = await build(upstream.baseURL);
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'read-limits-serve');
    const detach = built.attachSession(pump.sessions);
    try {
      await pump.submit({ kind: 'message', text: '讀。' });
      expect(upstream.requests.every((request) => request.stream)).toBe(true);
      expectDshReadFile(upstream.requests);
      // 日誌上那一次是工具錯誤。
      const results = pump.sessions.root.events.filter((event) => event.type === 'tool/result');
      expect(results.at(-1)?.data).toMatchObject({ isError: true });
    } finally {
      detach();
      await built.dispose();
      await upstream.close();
    }
  }, 20000);
});
