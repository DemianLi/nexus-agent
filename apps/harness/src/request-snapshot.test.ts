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
import { ChatOpenAI } from '@langchain/openai';
import { SessionRegistry } from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionEventMap } from '@nexus/core';
import { createEchoPlugin } from '@nexus/plugin-echo';
import { createMemoryPlugin } from '@nexus/plugin-memory';
import { createPlanModePlugin, DEFAULT_PLAN_GUIDANCE } from '@nexus/plugin-plan-mode';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import type { CreateNexusAgentOptions } from './agent-factory.js';
import { runRepl } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';

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

/** 餵幾行進 REPL，收回日誌與端點收到的 body。 */
async function run(
  lines: string,
  plugins: readonly PluginEntry[],
  systemPrompt = '你是測試助手。',
  extra: Partial<Pick<CreateNexusAgentOptions, 'backgroundSubagents'>> & {
    /** 上一個行程留下的事件：新行程從它續接（`SessionRegistry` 的 `rootSeed`）。 */
    readonly seed?: readonly SessionEvent[];
  } = {},
) {
  const upstream = await fakeEndpoint();
  const root = await mkdtemp(join(tmpdir(), 'nexus-snap-'));
  await writeFile(join(root, 'AGENTS.md'), MEMORY_TEXT);
  const { agent, commands, attachSession, dispose } = await createNexusAgent({
    model: new ChatOpenAI({
      model: 'fake',
      apiKey: 'sk-loopback',
      maxRetries: 0,
      temperature: 0.3,
      configuration: { baseURL: upstream.baseURL },
    }),
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    systemPrompt,
    plugins: [...plugins],
    checkpointer: new MemorySaver(),
    ...(extra.backgroundSubagents !== undefined && {
      backgroundSubagents: extra.backgroundSubagents,
    }),
  });
  const sessions = new SessionRegistry(
    'snapshot',
    extra.seed === undefined ? {} : { rootSeed: extra.seed },
  );
  const detach = attachSession(sessions);
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
    detach();
    await dispose();
    await upstream.close();
  }
  return { events: [...sessions.root.events], bodies: upstream.bodies };
}

describe('請求快照 = 端點實際收到的（產品組裝）', () => {
  it('系統提示詞、工具清單、取樣設定逐項等於 body；/plan 之後只新記系統提示詞', async () => {
    const { events, bodies } = await run('一\n二\n/plan\n三\n/exit\n', [
      createEchoPlugin(),
      createMemoryPlugin(),
      createPlanModePlugin(),
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
    expect(systems[1]!.system).toContain(DEFAULT_PLAN_GUIDANCE);
    expect(systems[0]!.system).not.toContain(DEFAULT_PLAN_GUIDANCE);

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
    const { events } = await run('一\n/plan\n二\n/exit\n', [createPlanModePlugin()]);
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
