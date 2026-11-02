/**
 * **日誌上的請求快照，就是模型端點實際收到的那一份**——[#1020](https://github.com/DemianLi/nexus-agent/issues/1020)。
 *
 * 走產品組裝：真的 `createNexusAgent`、真的 `ChatOpenAI`（打本機假端點）、真的 REPL 與 `/plan`。假端點把每次
 * 收到的 HTTP body 原樣留下，快照的每一格都拿它對——不是拿我們自己算的東西對我們自己。
 *
 * 這一組釘四件事：
 *
 * 1. **內容對得上 body**：系統提示詞、工具清單（名字／說明／參數）、取樣設定逐項等於端點收到的。
 * 2. **變了才記**：連著幾次設定不變，只有第一次有；`/plan` 切換後系統提示詞變了，新記一顆 `request/system`，
 *    `request/header` 沒變就沒有第二顆。呼叫幾次，日誌都不隨呼叫數長。
 * 3. **記錄點在模型呼叫上，不在 middleware 這一層**：基座的 `memory` 注入發生在我們的 middleware 之後，
 *    站在外面看的 middleware 看不到記憶內容，快照看得到；最內側改寫提示詞與工具的 middleware，快照也跟著。
 * 4. **不進遙測**：見 `packages/nexus-core/src/session-telemetry-coordinator.test.ts`；這裡只確認它確實是 `ignorable`。
 * 5. **記不進去，這次請求不送**（[#1726](https://github.com/DemianLi/nexus-agent/issues/1726)）：端點收到 0 個請求，呼叫原樣拋出寫入的錯。
 *
 * **零憑證、零外部連線**。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { SessionRegistry } from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionEventMap, SessionLog } from '@nexus/core';
import { createEchoPlugin } from './echo.fixture.js';
import { createMemoryPlugin } from '@nexus/plugin-memory';
import { describe, expect, it, vi } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import type { CreateNexusAgentOptions } from './agent-factory.js';
import { runRepl, runTurn } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { TEST_PLAN_GUIDANCE, testPlanModePlugin } from './fixtures.js';

/** 一次請求的 body 裡我們關心的那幾格。 */
interface Body {
  readonly model?: string;
  readonly temperature?: number;
  readonly messages: readonly { role: string; content: unknown }[];
  readonly tools?: readonly {
    function: { name: string; description?: string; parameters?: unknown };
  }[];
}

/** 本機的 OpenAI 相容端點：每次都回「好。」，並把收到的 body 原樣留下。 */
async function fakeEndpoint() {
  const bodies: Body[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${bodies.length}`,
          object: 'chat.completion',
          created: 0,
          model: 'fake',
          choices: [
            { index: 0, message: { role: 'assistant', content: '好。' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** body 裡 system 訊息的文字（多則依序併起來，同 `extractRequest`）。 */
const systemOf = (body: Body): string =>
  body.messages
    .filter((message) => message.role === 'system')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : (message.content as { text?: string }[]).map((part) => part.text ?? '').join(''),
    )
    .join('\n\n');

function eventsOf<T extends keyof SessionEventMap>(
  events: readonly SessionEvent[],
  type: T,
): (SessionEventMap[T] & { readonly seq: number })[] {
  return events
    .filter((event) => event.type === type)
    .map((event) => ({ ...(event.data as SessionEventMap[T]), seq: event.seq }));
}

const INNER_MARK = '<<最內側改寫>>';
const MEMORY_TEXT = '使用者的代號是胡桃。';

/** 不改動任何東西，只記它看到的提示詞與工具名。`where` 決定它站在我們這串的最外面或最內側。 */
function observer(
  name: string,
  where: 'outermost' | 'innermost',
  seen: { system: string[]; tools: string[][] },
): PluginEntry {
  return {
    plugin: {
      name,
      apply: (registry) =>
        void registry.middleware.use(
          {
            name,
            wrapModelCall: (
              request: { systemMessage?: { text: string }; tools?: { name?: string }[] },
              handler: (next: unknown) => unknown,
            ) => {
              seen.system.push(request.systemMessage?.text ?? '');
              seen.tools.push((request.tools ?? []).map((tool) => tool.name ?? ''));
              return handler(request);
            },
          } as never,
          where === 'outermost' ? { prepend: true } : { last: true },
        ),
    },
  };
}

/** 站在最內側：往提示詞附一段記號，並把 `echo` 工具從這次請求拿掉。 */
function innerRewriter(): PluginEntry {
  return {
    plugin: {
      name: 'inner-rewriter',
      apply: (registry) =>
        void registry.middleware.use(
          {
            name: 'innerRewriter',
            wrapModelCall: (
              request: {
                systemMessage: { concat: (text: string) => unknown };
                tools?: { name?: string }[];
              },
              handler: (next: unknown) => unknown,
            ) =>
              handler({
                ...request,
                systemMessage: request.systemMessage.concat(`\n${INNER_MARK}`),
                tools: (request.tools ?? []).filter((tool) => tool.name !== 'echo'),
              }),
          } as never,
          { last: true },
        ),
    },
  };
}

const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-source',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

type Extra = Partial<
  Pick<CreateNexusAgentOptions, 'backgroundSubagents' | 'streamRetry' | 'summarization'>
> & {
  /** 上一個行程留下的事件：新行程從它續接（`SessionRegistry` 的 `rootSeed`）。 */
  readonly seed?: readonly SessionEvent[];
  /** 模型的 `temperature`；省略即 0.3。 */
  readonly temperature?: number;
  /** 模型的 `modelKwargs`（其餘 body 參數，進 `invocation_params`，也就是快照的 `config.extra`）。 */
  readonly modelKwargs?: Record<string, unknown>;
};

/** 產品組裝接上本機假端點與一份 root 日誌；`close` 收掉三樣。 */
async function assemble(plugins: readonly PluginEntry[], systemPrompt: string, extra: Extra) {
  const upstream = await fakeEndpoint();
  const root = await mkdtemp(join(tmpdir(), 'nexus-snap-'));
  await writeFile(join(root, 'AGENTS.md'), MEMORY_TEXT);
  const { agent, commands, attachSession, dispose } = await createNexusAgent({
    model: new ChatOpenAI({
      model: 'fake',
      apiKey: 'sk-loopback',
      maxRetries: 0,
      temperature: extra.temperature ?? 0.3,
      ...(extra.modelKwargs !== undefined && { modelKwargs: extra.modelKwargs }),
      configuration: { baseURL: upstream.baseURL },
    }),
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    systemPrompt,
    plugins: [...plugins],
    checkpointer: new MemorySaver(),
    ...(extra.backgroundSubagents !== undefined && {
      backgroundSubagents: extra.backgroundSubagents,
    }),
    ...(extra.streamRetry !== undefined && { streamRetry: extra.streamRetry }),
    ...(extra.summarization !== undefined && { summarization: extra.summarization }),
  });
  const sessions = new SessionRegistry(
    'snapshot',
    extra.seed === undefined ? {} : { rootSeed: extra.seed },
  );
  const detach = attachSession(sessions);
  const close = async () => {
    detach();
    await dispose();
    await upstream.close();
  };
  return { agent, commands, sessions, bodies: upstream.bodies, close };
}

/** 餵幾行進 REPL，收回日誌與端點收到的 body。 */
async function run(
  lines: string,
  plugins: readonly PluginEntry[],
  systemPrompt = '你是測試助手。',
  extra: Extra = {},
) {
  const { agent, commands, sessions, bodies, close } = await assemble(plugins, systemPrompt, extra);
  const input = new PassThrough();
  input.end(lines);
  try {
    await runRepl(
      agent,
      { input, output: new PassThrough() },
      { log: () => {}, error: () => {} },
      sessions.root,
      commands,
    );
  } finally {
    await close();
  }
  return { events: [...sessions.root.events], bodies };
}

describe('請求快照 = 端點實際收到的（產品組裝）', () => {
  it('系統提示詞、工具清單、取樣設定逐項等於 body；/plan 之後只新記系統提示詞', async () => {
    const { events, bodies } = await run('一\n二\n/plan\n三\n/exit\n', [
      createEchoPlugin(),
      createMemoryPlugin(),
      testPlanModePlugin(),
      WORKER,
    ]);
    expect(bodies).toHaveLength(3);

    const systems = eventsOf(events, 'request/system');
    const headers = eventsOf(events, 'request/header');
    // 三次呼叫：第二次什麼都沒變，第三次只有系統提示詞變了（計劃指引）。
    expect(systems.map((each) => each.reason)).toEqual(['initial', 'change']);
    expect(headers.map((each) => each.reason)).toEqual(['initial']);

    expect(systems[0]!.system).toBe(systemOf(bodies[0]!));
    expect(systems[1]!.system).toBe(systemOf(bodies[2]!));
    expect(systems[1]!.system).toContain(TEST_PLAN_GUIDANCE);
    expect(systems[0]!.system).not.toContain(TEST_PLAN_GUIDANCE);

    const header = headers[0]!.header;
    expect(header.tools).toEqual(
      bodies[0]!.tools!.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    );
    // 前提：有註冊 worker，所以清單裡有基座的子代理工具 `task`，而且它的說明裡看得到 worker——快照記的是
    // 基座組出來、真的送出去的那份，不是我們註冊時的原樣。
    const task = header.tools!.find((tool) => tool.name === 'task');
    expect(task?.description).toContain('worker');
    expect(header.config).toMatchObject({ model: 'fake', temperature: 0.3 });
    expect(bodies[0]).toMatchObject({ model: 'fake', temperature: 0.3 });
  });

  it('每筆指回它那次呼叫的 model/start，且寫在 model/end 之前', async () => {
    const { events } = await run('一\n/plan\n二\n/exit\n', [testPlanModePlugin()]);
    const starts = eventsOf(events, 'model/start');
    const ends = eventsOf(events, 'model/end');
    const snapshots = [
      ...eventsOf(events, 'request/system'),
      ...eventsOf(events, 'request/header'),
    ];
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      const start = starts.find((each) => each.seq === snapshot.modelCall);
      expect(start, `快照 ${String(snapshot.seq)} 沒指到 model/start`).toBeDefined();
      const end = ends.find((each) => each.modelCall === start!.seq);
      expect(snapshot.seq).toBeLessThan(end!.seq);
    }
  });

  it('長提示詞：呼叫六次，日誌上只有一份', async () => {
    const long = '很長的系統提示詞。'.repeat(500);
    const { events, bodies } = await run('一\n二\n三\n四\n五\n六\n/exit\n', [], long);
    expect(bodies).toHaveLength(6);
    expect(eventsOf(events, 'request/system')).toHaveLength(1);
    expect(eventsOf(events, 'request/header')).toHaveLength(1);
  });

  it('兩顆都是 ignorable（純資訊：舊 runtime 讀得回，不升格式版本）', async () => {
    const { events } = await run('一\n/exit\n', []);
    const snapshots = events.filter(
      (event) => event.type === 'request/system' || event.type === 'request/header',
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((event) => event.ignorable === true)).toBe(true);
  });
});

describe('續接', () => {
  /** 落盤再讀回來的樣子：純 JSON，沒有任何活的參考。 */
  const reloaded = (events: readonly SessionEvent[]) =>
    JSON.parse(JSON.stringify(events)) as SessionEvent[];

  it('設定沒變：續接後再問一輪，快照一顆都不多；改了系統提示詞才新記一顆', async () => {
    const plugins = [createEchoPlugin()];
    const first = await run('一\n/exit\n', plugins);
    const before = first.events.filter((event) => event.type.startsWith('request/')).length;
    expect(before).toBe(2);

    const same = await run('二\n/exit\n', plugins, '你是測試助手。', {
      seed: reloaded(first.events),
    });
    expect(same.events.filter((event) => event.type.startsWith('request/'))).toHaveLength(before);

    const changed = await run('二\n/exit\n', plugins, '你是另一個助手。', {
      seed: reloaded(first.events),
    });
    expect(eventsOf(changed.events, 'request/system').map((each) => each.reason)).toEqual([
      'initial',
      'change',
    ]);
    expect(eventsOf(changed.events, 'request/header')).toHaveLength(1);
  });
});

describe('記錄點在模型呼叫上，不在 middleware 這一層', () => {
  it('連我們這串最內側的 middleware 都看不到記憶；快照看得到，改寫的提示詞與工具也跟著', async () => {
    const outer = { system: [] as string[], tools: [] as string[][] };
    const inner = { system: [] as string[], tools: [] as string[][] };
    const { events, bodies } = await run('一\n/exit\n', [
      createEchoPlugin(),
      createMemoryPlugin(),
      observer('outerObserver', 'outermost', outer),
      innerRewriter(),
      // 排在改寫者之後註冊的 `last`：我們這串的最內層，緊貼基座自己的那幾顆。
      observer('innerObserver', 'innermost', inner),
    ]);
    expect(bodies).toHaveLength(1);

    const system = eventsOf(events, 'request/system')[0]!.system;
    const tools = eventsOf(events, 'request/header')[0]!.header.tools!.map((tool) => tool.name);

    // 最外面的看的是進來的那一份：沒有改寫，工具還有 echo。
    expect(outer.system[0]).not.toContain(INNER_MARK);
    expect(outer.tools[0]).toContain('echo');
    // 最內側的已經吃到改寫（記號在、echo 沒了），**但基座後來才注入的記憶它也看不到**——這就是記錄點不能放在 middleware 的理由。
    expect(inner.system[0]).toContain(INNER_MARK);
    expect(inner.tools[0]).not.toContain('echo');
    expect(inner.system[0]).not.toContain(MEMORY_TEXT);
    expect(outer.system[0]).not.toContain(MEMORY_TEXT);

    // 快照是模型實際收到的：記憶、改寫都在，echo 已被拿掉——而且逐項等於 body。
    expect(system).toContain(MEMORY_TEXT);
    expect(system).toContain(INNER_MARK);
    expect(system).toBe(systemOf(bodies[0]!));
    expect(tools).not.toContain('echo');
    expect(tools).toEqual(bodies[0]!.tools!.map((tool) => tool.function.name));
  });

  it('背景委派開著：快照裡是 `subagent`、沒有 `task`，清單與說明逐項等於 body', async () => {
    const outer = { system: [] as string[], tools: [] as string[][] };
    const { events, bodies } = await run(
      '一\n/exit\n',
      [WORKER, observer('outerObserver', 'outermost', outer)],
      '你是測試助手。',
      { backgroundSubagents: {} },
    );
    expect(bodies).toHaveLength(1);

    const snapshot = eventsOf(events, 'request/header')[0]!.header.tools!;
    const names = snapshot.map((tool) => tool.name);
    // 取代發生在模型呼叫的 `wrapModelCall` 裡（`background-delegation.ts`），所以最外面的 middleware 看到的仍是 `task`，
    // 送出去的才是 `subagent`——快照記的是後者。
    expect(outer.tools[0]).toContain('task');
    expect(outer.tools[0]).not.toContain('subagent');
    expect(names).toContain('subagent');
    expect(names).not.toContain('task');
    expect(snapshot.find((tool) => tool.name === 'subagent')?.description).toContain('worker');
    expect(snapshot).toEqual(
      bodies[0]!.tools!.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    );
  });
});

describe('記不進去，這次請求不送（#1726，照 dsh agent.ts:637-650）', () => {
  const quiet = { log: () => {}, error: () => {} };
  /** 掛上重打（產品路徑由 `retryPolicy` 給），「沒有 `llm/retry`」那一格才不是空的。 */
  const retrying: Extra = { streamRetry: { maxRetries: 2, initialDelayMs: 1 } };

  /** 讓 `type` 那種事件的**第一次**寫入拋 `broken`，其餘照寫。 */
  function breakFirst(log: SessionLog, type: string, broken: Error): void {
    const append = log.append.bind(log);
    let armed = true;
    (log as { append: unknown }).append = (...args: Parameters<SessionLog['append']>) => {
      if (armed && args[0] === type) {
        armed = false;
        throw broken;
      }
      return append(...args);
    };
  }

  /** 第一輪撞上壞掉的寫入，第二輪照常；分開收兩輪的日誌與端點請求數。 */
  async function failThenSucceed(type: 'request/header' | 'request/system') {
    const broken = new Error(`${type} 寫不進去`);
    const { agent, sessions, bodies, close } = await assemble(
      [createEchoPlugin()],
      '你是測試助手。',
      retrying,
    );
    breakFirst(sessions.root, type, broken);
    // LangChain 重拋 handler 的錯之前自己印一行（`@langchain/core` `callbacks/manager.js:376`）：收起來，也斷言它真的印了。
    const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const thrown = await runTurn(agent, '一', quiet, sessions.root).then(
        () => undefined,
        (error: unknown) => error,
      );
      const first = { events: [...sessions.root.events], requests: bodies.length };
      const lines = printed.mock.calls.map((call) => call.map(String).join(' '));
      await runTurn(agent, '二', quiet, sessions.root);
      return { broken, thrown, first, lines, events: [...sessions.root.events], bodies };
    } finally {
      printed.mockRestore();
      await close();
    }
  }

  /**
   * 沿 `cause` 往下找到最裡面那一個。基座的 `createAgent` 把 middleware 裡拋的錯包成 `MiddlewareError`、原錯放在
   * `cause`（`langchain` `dist/agents/errors.js:62-81`），每一種模型呼叫的錯到這一層都長這樣，不是這張卡的形狀。
   */
  const innermost = (error: unknown): unknown =>
    error instanceof Error && error.cause !== undefined ? innermost(error.cause) : error;

  /** 兩種情境共有的：沒送、原樣拋、有配對的 error 收尾、沒有重試、LangChain 印了一行。 */
  function expectNotSent(result: Awaited<ReturnType<typeof failThenSucceed>>): void {
    // 先斷言沒送：這一格是卡的判準，突變（吞掉錯、`raiseError` 改回 false）都先紅在這裡。
    expect(result.first.requests).toBe(0);
    expect(innermost(result.thrown)).toBe(result.broken);
    const starts = eventsOf(result.first.events, 'model/start');
    expect(starts).toHaveLength(1);
    expect(eventsOf(result.first.events, 'model/end')).toEqual([
      expect.objectContaining({ outcome: 'error', modelCall: starts[0]!.seq }),
    ]);
    expect(result.first.events.some((event) => event.type.startsWith('llm/retry'))).toBe(false);
    expect(eventsOf(result.first.events, 'turn/failed')).toEqual([
      expect.objectContaining({ message: result.broken.message }),
    ]);
    // chat model 也標 `handleLLMStart`（`manager.js` 那一行寫死的字），一行、帶原錯。
    expect(result.lines).toEqual([
      `Error in handler RequestSnapshotHandler, handleLLMStart: Error: ${result.broken.message}`,
    ]);
    // 第二輪照常送出，那一份快照指回第二次呼叫。
    expect(result.bodies).toHaveLength(1);
  }

  it('request/header 寫不進去：這次不送；system 已先記下，下一次只補記 header（initial）', async () => {
    const result = await failThenSucceed('request/header');
    expectNotSent(result);
    // system 寫在 header 之前，那一顆已經落下、指向沒送出的那次呼叫（PR 內文交 PM 定）。
    expect(eventsOf(result.first.events, 'request/system')).toHaveLength(1);
    expect(eventsOf(result.first.events, 'request/header')).toHaveLength(0);

    const second = eventsOf(result.events, 'model/start')[1]!;
    expect(eventsOf(result.events, 'request/system')).toHaveLength(1);
    expect(eventsOf(result.events, 'request/header')).toEqual([
      expect.objectContaining({ reason: 'initial', modelCall: second.seq }),
    ]);
  });

  it('request/system 寫不進去：這次不送、header 沒試；下一次兩顆都記（initial）', async () => {
    const result = await failThenSucceed('request/system');
    expectNotSent(result);
    expect(result.first.events.some((event) => event.type.startsWith('request/'))).toBe(false);

    const second = eventsOf(result.events, 'model/start')[1]!;
    for (const type of ['request/system', 'request/header'] as const) {
      expect(eventsOf(result.events, type)).toEqual([
        expect.objectContaining({ reason: 'initial', modelCall: second.seq }),
      ]);
    }
  });

  it('設定寫了 temperature: -0：照送，header 記 0（供應商收到的就是 0；寫入那一關拒收 -0）', async () => {
    const { agent, sessions, bodies, close } = await assemble([], '你是測試助手。', {
      ...retrying,
      temperature: -0,
    });
    try {
      await runTurn(agent, '一', quiet, sessions.root);
    } finally {
      await close();
    }
    expect(bodies).toHaveLength(1);
    const header = eventsOf(sessions.root.events, 'request/header')[0]!.header;
    expect(Object.is(header.config.temperature, 0)).toBe(true);
  });

  it('工具參數巢狀超過寫入上限（600 層，#1661）：這次請求失敗、不是爆堆疊，這條 thread 之後每一次都一樣', async () => {
    // 每層 `{ type, properties: { next } }` 佔兩層，400 層 ≈ 800 層巢狀。
    let schema: Record<string, unknown> = { type: 'string' };
    for (let level = 0; level < 400; level++) {
      schema = { type: 'object', properties: { next: schema } };
    }
    const deep: PluginEntry = {
      plugin: {
        name: 'deep-tool',
        apply: (registry) =>
          void registry.tools.register(
            tool(() => '好', { name: 'deep', description: '很深。', schema: schema as never }),
          ),
      },
    };
    const { agent, sessions, bodies, close } = await assemble([deep], '你是測試助手。', retrying);
    const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const text of ['一', '二']) {
        await expect(runTurn(agent, text, quiet, sessions.root)).rejects.toThrow(/超過上限 600 層/);
      }
      expect(bodies).toHaveLength(0);
      expect(eventsOf(sessions.root.events, 'request/header')).toHaveLength(0);
      expect(eventsOf(sessions.root.events, 'turn/failed')).toHaveLength(2);
      // 管理者看到的那一行（`turn/failed` 的訊息）要點得出是哪一顆工具（#1731）：寫入那一關的路徑只印前 8 段，只有索引。
      for (const failed of eventsOf(sessions.root.events, 'turn/failed')) {
        expect(failed.message).toContain('tools["deep"].parameters');
      }
    } finally {
      printed.mockRestore();
      await close();
    }
  });

  it('工具參數有循環參照（#1731）：這次請求不送、日誌上沒有少了參數的 header，失敗訊息點名那顆工具', async () => {
    // **要關掉 summarization 才走得到快照這一格。** 預設組裝裡 deepagents 的 summarization 在模型被叫之前先 `JSON.stringify`
    // 整串工具（`countTokensApproximately`），循環在那裡就爆了：訊息是原生的 `Converting circular structure to JSON`、不帶
    // 工具名稱，而且 #1731 之前這個結果就已經成立，分不出對錯。部署可以關掉摘要（`fold.ts` 的 `summarization: false`），
    // 那時只剩快照這一格擋：改寫前它把 `parameters` 拿掉、照樣記一份 header 並送出。
    const looped: Record<string, unknown> = { type: 'object', properties: {} };
    looped['self'] = looped;
    const broken: PluginEntry = {
      plugin: {
        name: 'looped-tool',
        apply: (registry) =>
          void registry.tools.register(
            tool(() => '好', {
              name: 'looped',
              description: '繞回自己。',
              schema: looped as never,
            }),
          ),
      },
    };
    const { agent, sessions, bodies, close } = await assemble([broken], '你是測試助手。', {
      ...retrying,
      summarization: false,
    });
    const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const text of ['一', '二']) {
        await expect(runTurn(agent, text, quiet, sessions.root)).rejects.toThrow(
          /tools\["looped"\]\.parameters/,
        );
      }
      expect(bodies).toHaveLength(0);
      expect(eventsOf(sessions.root.events, 'request/header')).toHaveLength(0);
      const failures = eventsOf(sessions.root.events, 'turn/failed');
      expect(failures).toHaveLength(2);
      for (const failed of failures) expect(failed.message).toContain('tools["looped"].parameters');
      expect(sessions.root.events.some((event) => event.type.startsWith('llm/retry'))).toBe(false);
    } finally {
      printed.mockRestore();
      await close();
    }
  });

  it('預設組裝下工具參數有循環：照樣沒送、沒有 header（summarization 先拋，訊息不帶工具名稱）', async () => {
    // 不變量，不管是誰先拋；這條在改寫前就綠，分不出快照這一格的對錯，所以上面那條才是驗收。
    const looped: Record<string, unknown> = { type: 'object' };
    looped['self'] = looped;
    const broken: PluginEntry = {
      plugin: {
        name: 'looped-tool-default',
        apply: (registry) =>
          void registry.tools.register(
            tool(() => '好', {
              name: 'looped',
              description: '繞回自己。',
              schema: looped as never,
            }),
          ),
      },
    };
    const { agent, sessions, bodies, close } = await assemble([broken], '你是測試助手。', retrying);
    const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runTurn(agent, '一', quiet, sessions.root)).rejects.toThrow();
      expect(bodies).toHaveLength(0);
      expect(eventsOf(sessions.root.events, 'request/header')).toHaveLength(0);
    } finally {
      printed.mockRestore();
      await close();
    }
  });

  it('modelKwargs 裡有循環（預設組裝就走得到 config.extra）：沒送、沒有 header，失敗訊息帶 config.extra.<鍵>', async () => {
    // 改寫前：`extra` 那一格被靜靜拿掉，記下一份 `thinking` 不見了的 header 並照常送出。
    const loop: Record<string, unknown> = { type: 'disabled' };
    loop['self'] = loop;
    const { agent, sessions, bodies, close } = await assemble([], '你是測試助手。', {
      ...retrying,
      modelKwargs: { thinking: loop },
    });
    const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const text of ['一', '二']) {
        await expect(runTurn(agent, text, quiet, sessions.root)).rejects.toThrow(
          /config\.extra\.thinking/,
        );
      }
      expect(bodies).toHaveLength(0);
      expect(eventsOf(sessions.root.events, 'request/header')).toHaveLength(0);
      const failures = eventsOf(sessions.root.events, 'turn/failed');
      expect(failures).toHaveLength(2);
      for (const failed of failures) expect(failed.message).toContain('config.extra.thinking');
    } finally {
      printed.mockRestore();
      await close();
    }
  });
});
