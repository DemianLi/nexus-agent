/**
 * **讀到二進位檔的 `read_file` 照 dsh 拒絕，不把圖片塊送進模型**——[#642](https://github.com/DemianLi/nexus-agent/issues/642)。
 *
 * 缺陷是量出來的：deepagents 的 `read_file` 碰到圖片回 `{type:'image', mimeType, data}`，`@langchain/openai` 的轉換器
 * 原樣塞進 `role: tool`，而 NVIDIA 的端點對 `role: tool` 只收字串或文字塊，回 400。帶圖的那則工具結果已經在叫模型
 * 之前進了 state，所以**同一條 thread 之後每一輪都 400**。
 *
 * 兩層各驗：
 *
 * - **後端的判準**：照 dsh 的 `readWholeText`（`packages/fs/fs-local/src/fsio.ts:386-399`，`477b4f4`）看內容——前 8KB
 *   有 NUL 就是 `binary file`，不是合法 UTF-8 就是 `invalid UTF-8 text`。兩種 backend 各驗：落磁碟的
 *   `ContainedFilesystemBackend`，與沒給 `--workspace` 時墊底的 `TextOnlyStateBackend`（模型 `write_file` 一張
 *   base64 的 PNG 再讀，同樣中毒，實測）。
 * - **真的組裝打真的轉換器**：對手方是本機的假 Chat Completions 端點，照真端點的規則回 400（原文見 {@link REJECTED}），
 *   走 serve 那條（`ThreadPump`，串流）連跑兩輪。`ScriptedChatModel` 驗不到這一層：它不經過轉換器，看不到
 *   `isDataContentBlock` 放行了什麼。
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
import { createFilesystemMiddleware } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { TextOnlyStateBackend } from './binary-read.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 一張 1×1 的 PNG。檔頭的 IHDR 長度欄位就有 NUL，所以它在 dsh 的判準下是二進位。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** NVIDIA 端點（`integrate.api.nvidia.com`）對 `role: tool` 帶非文字內容回的 400，2026-09-25 實測原文。 */
const REJECTED =
  'data did not match any variant of untagged enum ChatCompletionRequestToolMessageContent';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-binary-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function backend(): ContainedFilesystemBackend {
  return new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });
}

describe('後端照 dsh 看內容判二進位', () => {
  it('圖片：前 8KB 有 NUL，拒絕成 binary file', async () => {
    await writeFile(join(root, 'dot.png'), PNG);
    expect(await backend().read('/dot.png')).toEqual({
      error: 'cannot read "/dot.png": binary file',
    });
  });

  it('副檔名是文字、內容有 NUL：一樣拒絕——判的是內容，不是副檔名', async () => {
    await writeFile(join(root, 'dump.txt'), Buffer.from([0x61, 0x00, 0x62, 0x0a]));
    expect(await backend().read('/dump.txt')).toEqual({
      error: 'cannot read "/dump.txt": binary file',
    });
  });

  it('沒有 NUL 但不是合法 UTF-8：invalid UTF-8 text', async () => {
    await writeFile(join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect(await backend().read('/latin1.txt')).toEqual({
      error: 'cannot read "/latin1.txt": invalid UTF-8 text',
    });
  });

  it('NUL 落在前 8KB 之外、整份仍是合法 UTF-8：照讀（dsh 只取樣前 8KB）', async () => {
    await writeFile(join(root, 'late.txt'), `${'a'.repeat(8192)}\u0000\n`);
    const result = await backend().read('/late.txt');
    expect(result.error).toBeUndefined();
    expect(typeof result.content).toBe('string');
  });

  it('UTF-8 的中文與 SVG 照讀，內容一字不差', async () => {
    await writeFile(join(root, 'note.md'), '第一行\n第二行\n');
    await writeFile(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    expect(await backend().read('/note.md')).toMatchObject({ content: '第一行\n第二行\n' });
    expect(await backend().read('/icon.svg')).toMatchObject({
      content: '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    });
  });

  it('read_file 回的是 dsh 那句錯誤，不是圖片塊', async () => {
    await writeFile(join(root, 'dot.png'), PNG);
    const middleware = createFilesystemMiddleware({ backend: backend() });
    const readFile = middleware.tools?.find((tool) => tool.name === 'read_file');
    const output: unknown = await readFile?.invoke({ file_path: '/dot.png' });
    expect(output).toEqual([{ type: 'text', text: 'Error: cannot read "/dot.png": binary file' }]);
  });
});

describe('沒掛工作區的虛擬 FS 一樣拒絕', () => {
  /** 餵一份 state 的 legacy 建構：只為了不經 graph 直接讀。產品路徑是零參數建構。 */
  function stateWith(files: Record<string, unknown>): TextOnlyStateBackend {
    return new TextOnlyStateBackend({ state: { files } } as never);
  }
  const at = '2026-09-25T00:00:00.000Z';

  it('位元組、checkpoint 往返後的普通物件都拒；不是合法 UTF-8 的講 invalid UTF-8 text', () => {
    const backend = stateWith({
      '/dot.png': {
        content: new Uint8Array(PNG),
        mimeType: 'image/png',
        created_at: at,
        modified_at: at,
      },
      '/round.png': {
        content: Object.fromEntries([...PNG].map((byte, index) => [index, byte])),
        mimeType: 'image/png',
        created_at: at,
        modified_at: at,
      },
      '/latin1.pdf': {
        content: new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
        mimeType: 'application/pdf',
        created_at: at,
        modified_at: at,
      },
    });
    expect(backend.read('/dot.png')).toEqual({ error: 'cannot read "/dot.png": binary file' });
    expect(backend.read('/round.png')).toEqual({ error: 'cannot read "/round.png": binary file' });
    expect(backend.read('/latin1.pdf')).toEqual({
      error: 'cannot read "/latin1.pdf": invalid UTF-8 text',
    });
  });

  it('文字檔與不存在的檔照基座', () => {
    const backend = stateWith({
      '/note.md': {
        content: '第一行\n第二行',
        mimeType: 'text/markdown',
        created_at: at,
        modified_at: at,
      },
    });
    expect(backend.read('/note.md')).toMatchObject({ content: '第一行\n第二行' });
    expect(backend.read('/nope.png')).toEqual({ error: "File '/nope.png' not found" });
  });
});

/** 一步：模型這一次回什麼。有 `call` 就是叫一個工具。 */
interface Step {
  readonly call?: { readonly name: string; readonly args: Record<string, unknown> };
  readonly text?: string;
}

interface RecordedRequest {
  readonly messages: { role: string; content: unknown }[];
  readonly rejected: boolean;
}

/** `role: tool` 的 content 真端點收不收：字串，或每一塊都是文字。 */
function acceptedToolContent(content: unknown): boolean {
  if (typeof content === 'string') return true;
  return (
    Array.isArray(content) &&
    content.every((part) => (part as { type?: unknown } | null)?.type === 'text')
  );
}

/**
 * 照腳本回話的串流 Chat Completions 端點，**照真端點的規則拒絕**：任何一則 `role: tool` 的 content 不是字串或純文字塊，
 * 就回 400 與 {@link REJECTED}，不吃腳本的一步。每次回的 id 都不同（同 id 的 AI 訊息會被 reducer 取代）。
 */
async function strictOpenAi(steps: readonly Step[]) {
  const requests: RecordedRequest[] = [];
  let served = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages?: { role: string; content: unknown }[] };
      const messages = parsed.messages ?? [];
      const rejected = messages.some(
        (message) => message.role === 'tool' && !acceptedToolContent(message.content),
      );
      requests.push({ messages, rejected });
      if (rejected) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: REJECTED, type: 'Bad Request', code: 400 } }));
        return;
      }
      const index = served++;
      const step = steps[index] ?? { text: '（腳本用完）' };
      const toolCalls =
        step.call === undefined
          ? undefined
          : [
              {
                index: 0,
                id: `call_${index}`,
                type: 'function',
                function: { name: step.call.name, arguments: JSON.stringify(step.call.args) },
              },
            ];
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
      if (toolCalls !== undefined) res.write(chunk({ tool_calls: toolCalls }));
      res.write(chunk({}, toolCalls === undefined ? 'stop' : 'tool_calls'));
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

/** 跑兩輪、收掉資源，回日誌事件。 */
async function twoTurns(
  steps: readonly Step[],
  backendOption: ContainedFilesystemBackend | undefined,
  label: string,
) {
  const upstream = await strictOpenAi(steps);
  const built = await createNexusAgent({
    model: new ChatOpenAI({
      model: 'fake',
      apiKey: 'sk-loopback',
      maxRetries: 0,
      configuration: { baseURL: upstream.baseURL },
    }),
    ...(backendOption !== undefined && { backend: backendOption }),
    checkpointer: new MemorySaver(),
    plugins: [],
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, label);
  const detach = built.attachSession(pump.sessions);
  try {
    await pump.submit({ kind: 'message', text: '看一下 /dot.png。' }).catch(() => {});
    // **第二輪是主角**：帶圖的工具結果若留在歷史裡，這一輪一樣被拒。
    await pump.submit({ kind: 'message', text: '那算了。' }).catch(() => {});
    return { events: pump.sessions.root.events, requests: upstream.requests };
  } finally {
    detach();
    await built.dispose();
    await upstream.close();
  }
}

describe('真的組裝：沒掛工作區（state 裡的虛擬 FS）', () => {
  it('模型寫進一張 PNG 再讀：兩輪照常收尾，讀到的是 dsh 那句錯誤', async () => {
    const { events, requests } = await twoTurns(
      [
        {
          call: {
            name: 'write_file',
            args: { file_path: '/dot.png', content: PNG.toString('base64') },
          },
        },
        { call: { name: 'read_file', args: { file_path: '/dot.png' } } },
        { text: '那是一張圖，我讀不了。' },
        { text: '好的。' },
      ],
      undefined,
      'binary-read-state',
    );
    const outcomes = events
      .filter((event) => event.type === 'turn/end' || event.type === 'turn/failed')
      .map((event) => event.type);
    expect(outcomes).toEqual(['turn/end', 'turn/end']);
    expect(requests.map((request) => request.rejected)).toEqual([false, false, false, false]);

    const seen = requests[2]?.messages.filter((message) => message.role === 'tool').at(-1);
    expect(seen?.content).toEqual([
      { type: 'text', text: 'Error: cannot read "/dot.png": binary file' },
    ]);
    const results = events.filter((event) => event.type === 'tool/result');
    expect(results.at(-1)?.data).toMatchObject({ isError: true });
  }, 20000);
});

describe('真的組裝：讀到圖片的那一輪與下一輪', () => {
  it('兩輪都照常收尾，模型讀到的是 dsh 那句錯誤；那一次在日誌上是工具錯誤', async () => {
    await writeFile(join(root, 'dot.png'), PNG);
    const upstream = await strictOpenAi([
      { call: { name: 'read_file', args: { file_path: '/dot.png' } } },
      { text: '那是一張圖，我讀不了。' },
      { text: '好的。' },
    ]);
    const built = await createNexusAgent({
      model: new ChatOpenAI({
        model: 'fake',
        apiKey: 'sk-loopback',
        maxRetries: 0,
        configuration: { baseURL: upstream.baseURL },
      }),
      backend: backend(),
      checkpointer: new MemorySaver(),
      plugins: [],
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'binary-read');
    const detach = built.attachSession(pump.sessions);
    try {
      await pump.submit({ kind: 'message', text: '看一下 /dot.png。' }).catch(() => {});
      // **第二輪是主角**：帶圖的工具結果若留在歷史裡，這一輪一樣被拒。
      await pump.submit({ kind: 'message', text: '那算了。' }).catch(() => {});

      const outcomes = pump.sessions.root.events
        .filter((event) => event.type === 'turn/end' || event.type === 'turn/failed')
        .map((event) => event.type);
      expect(outcomes).toEqual(['turn/end', 'turn/end']);
      expect(upstream.requests.map((request) => request.rejected)).toEqual([false, false, false]);

      const seen = upstream.requests[1]?.messages.find((message) => message.role === 'tool');
      expect(seen?.content).toEqual([
        { type: 'text', text: 'Error: cannot read "/dot.png": binary file' },
      ]);
      const result = pump.sessions.root.events.find((event) => event.type === 'tool/result');
      expect(result?.data).toMatchObject({ isError: true });
    } finally {
      detach();
      await built.dispose();
      await upstream.close();
    }
  }, 20000);
});
