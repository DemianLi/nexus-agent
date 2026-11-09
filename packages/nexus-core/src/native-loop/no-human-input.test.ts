/**
 * 每一顆工具呼叫上放的是什麼（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：native 帶 thread 的 `streamEvents` 放等人
 * 服務，其餘（`invoke`、子代理那一層）放「這裡沒人可問」（`NO_HUMAN_INPUT`）；`langgraph` 一律不放。讀到標記的閘門走沒有核准管道
 * 那一格，不問人、不跑工具本體。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { assembleAgent } from '../agent-assembly.js';
import type { PreToolListener } from '../approval.js';
import { fakePlugin } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { humanInputOf, humanInputUnavailable } from '../human-input.js';
import { loadPlugins } from '../load.js';
import {
  FOREGROUND_SUBAGENT_DELEGATION_CONTEXT,
  SUBAGENT_DELEGATION_CONTEXT,
} from '../subagent-delegation.js';
import { interruptIds, LOOPS, type LoopEvent } from './human-input-loops.fixture.js';

interface Seen {
  readonly at: string;
  readonly service: boolean;
  readonly unavailable: boolean;
}

/** 記下這顆呼叫的 config 上放的是什麼。 */
const reader = (seen: Seen[]) =>
  tool(
    async ({ at }, runConfig) => {
      seen.push({
        at,
        service: humanInputOf(runConfig) !== undefined,
        unavailable: humanInputUnavailable(runConfig),
      });
      return at;
    },
    { name: 'reader', description: 'reader', schema: z.object({ at: z.string() }) },
  );

/** 本體跑了就記一筆；閘門要它核准。 */
const danger = (ran: string[]) =>
  tool(
    async ({ at }) => {
      ran.push(at);
      return `${at} 做了`;
    },
    { name: 'danger', description: 'danger', schema: z.object({ at: z.string() }) },
  );

const askForDanger: PreToolListener = async (exec, next) =>
  exec.name === 'danger' ? { kind: 'ask', reason: '要人核准' } : next();

async function assemble(
  loop: (typeof LOOPS)[number],
  tools: Parameters<typeof fakePlugin>[1],
  model: ReturnType<typeof fakeModel>,
  results: Record<string, string> = {},
) {
  const { registry } = await loadPlugins([
    fakePlugin('tools', (r) => {
      void tools(r);
      r.approvals.gate(askForDanger);
      void r.events.on('tools/result', (exec, result) => {
        results[exec.callId] = result.content;
      });
    }),
  ]);
  const backend = new StateBackend();
  const checkpointer = new MemorySaver();
  const params = foldRegistry(registry, {
    summarization: false,
    defaultBackend: backend,
    events: registry.dispatch,
    checkpointer,
    loop,
  });
  return assembleAgent({
    ...params,
    model,
    backend: params.backend ?? backend,
    checkpointer,
    loop,
    events: registry.dispatch,
  }) as unknown as {
    streamEvents(input: unknown, config: object): Promise<AsyncIterable<LoopEvent>>;
    invoke(input: unknown, config: object): Promise<unknown>;
  };
}

const drain = async (stream: Promise<AsyncIterable<LoopEvent>>): Promise<LoopEvent[]> => {
  const events: LoopEvent[] = [];
  for await (const event of await stream) events.push(event);
  return events;
};

const options = { version: 'v3', configurable: { thread_id: 't' } };
const input = { messages: [new HumanMessage('動手')] };

describe.each(LOOPS)('%s：每顆呼叫的 config 上放什麼', (loop) => {
  it('帶 thread 的 streamEvents：root 那一層與子代理那一層', async () => {
    const seen: Seen[] = [];
    const agent = await assemble(
      loop,
      (r) => r.tools.register(reader(seen)),
      fakeModel()
        .respondWithTools([
          { name: 'reader', args: { at: 'root' }, id: 'r1' },
          { name: 'task', args: { description: '讀', subagent_type: 'general-purpose' }, id: 'r2' },
        ])
        .respondWithTools([{ name: 'reader', args: { at: 'sub' }, id: 's1' }])
        .respond(new AIMessage('子代理收完'))
        .respond(new AIMessage('root 收完')),
    );
    await drain(agent.streamEvents(input, options));

    const expected =
      loop === 'native'
        ? [
            { at: 'root', service: true, unavailable: false },
            { at: 'sub', service: false, unavailable: true },
          ]
        : [
            { at: 'root', service: false, unavailable: false },
            { at: 'sub', service: false, unavailable: false },
          ];
    expect(seen).toEqual(expected);
  });

  it('invoke：root 那一層', async () => {
    const seen: Seen[] = [];
    const agent = await assemble(
      loop,
      (r) => r.tools.register(reader(seen)),
      fakeModel()
        .respondWithTools([{ name: 'reader', args: { at: 'root' }, id: 'r1' }])
        .respond(new AIMessage('root 收完')),
    );
    await agent.invoke(input, options);

    expect(seen).toEqual([
      { at: 'root', service: false, unavailable: loop === 'native' },
    ]);
  });
});

describe.each(LOOPS)('%s：前景子代理的委派聲明', (loop) => {
  it('跟子代理那一層的閘門一致：native 沒人可問，講自動回絕；langgraph 講等使用者', async () => {
    const model = fakeModel()
      .respondWithTools([
        { name: 'task', args: { description: '讀', subagent_type: 'general-purpose' }, id: 'r1' },
      ])
      .respond(new AIMessage('子代理收完'))
      .respond(new AIMessage('root 收完'));
    const agent = await assemble(loop, (r) => void r.tools.register(reader([])), model);
    await drain(agent.streamEvents(input, options));

    const subagent = model.calls[1]?.messages ?? [];
    const system = subagent
      .filter((message) => message.getType() === 'system')
      .map((message) => message.text)
      .join('\n');
    const [said, notSaid] =
      loop === 'native'
        ? [SUBAGENT_DELEGATION_CONTEXT, FOREGROUND_SUBAGENT_DELEGATION_CONTEXT]
        : [FOREGROUND_SUBAGENT_DELEGATION_CONTEXT, SUBAGENT_DELEGATION_CONTEXT];
    expect(system).toContain(said);
    expect(system).not.toContain(notSaid);
  });
});

describe('native：讀到「這裡沒人可問」的閘門', () => {
  it('子代理那一層要核准：沒有管道那一格，本體不跑；root 那一層照常停下來問，核准了才跑', async () => {
    const ran: string[] = [];
    const results: Record<string, string> = {};
    const agent = await assemble(
      'native',
      (r) => void r.tools.register(danger(ran)),
      fakeModel()
        .respondWithTools([
          { name: 'task', args: { description: '做', subagent_type: 'general-purpose' }, id: 'r1' },
        ])
        .respondWithTools([{ name: 'danger', args: { at: 'sub' }, id: 's1' }])
        .respond(new AIMessage('子代理收完'))
        .respondWithTools([{ name: 'danger', args: { at: 'root' }, id: 'r2' }])
        .respond(new AIMessage('root 收完')),
      results,
    );
    const parked = await drain(agent.streamEvents(input, options));
    // 子代理那一顆沒問就回絕（它那則訊息在子代理自己的對話裡，不在 root 的事件上），停下來問的只有 root 那一顆。
    expect(ran).toEqual([]);
    expect(results['s1']).toContain('沒有可用的核准管道');
    const ids = interruptIds(parked);
    expect(ids).toHaveLength(1);
    const [id] = ids;

    const done = await drain(
      agent.streamEvents(
        new Command({ resume: { [id!]: { decisions: [{ type: 'approve' }] } } }),
        options,
      ),
    );
    expect(ran).toEqual(['root']);
    expect(JSON.stringify(done)).toContain('root 收完');
  });

  it('invoke：root 那一層要核准也是沒有管道那一格，本體不跑，照常收尾', async () => {
    const ran: string[] = [];
    const agent = await assemble(
      'native',
      (r) => void r.tools.register(danger(ran)),
      fakeModel()
        .respondWithTools([{ name: 'danger', args: { at: 'root' }, id: 'r1' }])
        .respond(new AIMessage('root 收完')),
    );
    const result = await agent.invoke(input, options);

    expect(ran).toEqual([]);
    expect(JSON.stringify(result)).toContain('沒有可用的核准管道');
    expect(JSON.stringify(result)).toContain('root 收完');
  });
});
