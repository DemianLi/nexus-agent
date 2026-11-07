/**
 * 插件與 harness 的三格在 native 的工具鏈上（#2416）：workspace-changes、host-tools、background-delegation
 * 都登記了工具步驟（`@nexus/core` 的 `withToolCallStep`），root 由 native 直接呼叫那一步、不經那顆的 `wrapToolCall`；
 * 子代理在 native 下仍是 LangGraph 子圖（TODO(#2359)），照舊經 `wrapToolCall`。`langgraph` 兩邊都經 `wrapToolCall`。
 *
 * 走 `createCliAgent` 的真組裝。清單最前面一列在 `registry.middleware.use` 上包一層：之後每一顆登記過步驟的 middleware，
 * 掛上去之前先把那一步與 `wrapToolCall` 各包一個計數。跑一輪「root 叫 `ls` → root 前景委派 `worker` → worker 叫 `ls` → 回答」，
 * 數每一格對每一次呼叫各被叫了幾次。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { SessionRegistry, toolCallStepOf, withToolCallStep, wrapToolCallWith } from '@nexus/core';
import type { PluginEntry, ToolCallStep } from '@nexus/core';
import { SANDBOX_POLICY_SERVICE } from '@nexus/plugin-sandbox-policy';
import type { SandboxModeController } from '@nexus/plugin-sandbox-policy';
import {
  WORKSPACE_CHANGES_MIDDLEWARE_NAME,
  workspaceChangesPlugin,
} from '@nexus/plugin-workspace-changes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { BACKGROUND_DELEGATION_MIDDLEWARE_NAME } from './background-delegation.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { createHostToolsSlot, HOST_TOOLS_MIDDLEWARE_NAME, hostToolsEntry } from './host-tools.js';
import { ScriptedChatModel } from './scripted-model.js';

const shipped = await shippedPlugins();

const CELLS = [
  BACKGROUND_DELEGATION_MIDDLEWARE_NAME,
  HOST_TOOLS_MIDDLEWARE_NAME,
  WORKSPACE_CHANGES_MIDDLEWARE_NAME,
] as const;

type Via = 'native' | 'wrapToolCall';

/** 每一格（照名字）對每個 `callId` 各被叫了幾次，分成兩條路；另記那一步看到的工具名。 */
interface Seen {
  readonly counts: Map<string, Map<string, Record<Via, number>>>;
  readonly names: Map<string, Map<string, string[]>>;
}

function bump(
  seen: Seen,
  cell: string,
  call: { readonly id?: string | undefined; readonly name: string },
  via: Via,
): void {
  const key = call.id ?? '';
  let byCall = seen.counts.get(cell);
  if (byCall === undefined) seen.counts.set(cell, (byCall = new Map()));
  const entry = byCall.get(key) ?? { native: 0, wrapToolCall: 0 };
  entry[via] += 1;
  byCall.set(key, entry);
  let names = seen.names.get(cell);
  if (names === undefined) seen.names.set(cell, (names = new Map()));
  names.set(key, [...(names.get(key) ?? []), call.name]);
}

/** 清單最前面那一列：之後 `middleware.use` 掛上的每一顆登記過步驟的，先包計數。 */
function instrumentEntry(seen: Seen): PluginEntry {
  return {
    plugin: {
      name: 'zz-tool-cell-counter',
      apply(registry) {
        const use = registry.middleware.use.bind(registry.middleware);
        registry.middleware.use = (middleware, options) => {
          const step = toolCallStepOf(middleware);
          if (step !== undefined) {
            const name = (middleware as { name: string }).name;
            const counted: ToolCallStep = (call, next) => {
              bump(seen, name, { id: call.callId, name: call.name }, 'native');
              return step(call, next);
            };
            const target = middleware as unknown as {
              wrapToolCall: (
                request: { toolCall: { id?: string; name: string } },
                handler: unknown,
              ) => unknown;
            };
            const wrap = target.wrapToolCall;
            // `withToolCallStep` 只在登記那一刻核對 `wrapToolCall` 是 `wrapToolCallWith(counted)`；登記後換上的這支經原本的 `wrap` 跑、不經 `counted`，native 與 `wrapToolCall` 兩條路徑才各記各的。
            target.wrapToolCall = wrapToolCallWith(counted) as never;
            withToolCallStep(middleware, counted);
            target.wrapToolCall = (request, handler) => {
              bump(seen, name, request.toolCall, 'wrapToolCall');
              return wrap(request, handler);
            };
          }
          return use(middleware, options);
        };
      },
    },
  };
}

const worker: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
        model: new ScriptedChatModel({
          turns: [
            { content: '', toolCalls: [{ name: 'ls', args: { path: '/' }, id: 'sub-ls' }] },
            { content: '子代理好了' },
          ],
        }),
      });
    },
  },
};

/**
 * 一位 `tools/execute` 監聽者，登記在沙箱政策之前（匯流排上排在它外側）：委派那一次呼叫同步往內交，**回來的下一行**就把
 * root 切成 `read-only`。沙箱的監聽者在被派發的同一個 tick 拍快照的話，子代理拿到的是切之前的模式；它晚一個 `await` 才拍，
 * 拍到的就是切之後的。順便記下匯流排上看到的工具名。
 */
function flipAfterDelegating(flipped: string[], names: Map<string, string>): PluginEntry {
  return {
    plugin: {
      name: 'zz-flip-after-delegating',
      apply(registry) {
        const { controller } = registry.services.get(SANDBOX_POLICY_SERVICE) as {
          readonly controller: SandboxModeController;
        };
        registry.events.on('tools/execute', (exec, next) => {
          names.set(exec.callId, exec.name);
          const result = next();
          if (exec.callId === 'root-sub') {
            controller.switchTo('read-only');
            flipped.push(controller.current);
          }
          return result;
        });
      },
    },
  };
}

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'nexus-plugin-tool-cells-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/**
 * @param beforeSandbox - 插在出貨清單 `sandbox-policy` 那一列之前的條目：它們掛的 `tools/execute` 監聽者在匯流排上緊貼沙箱外側。
 */
async function run(loop: 'native' | 'langgraph', beforeSandbox: readonly PluginEntry[] = []) {
  const seen: Seen = { counts: new Map(), names: new Map() };
  const built = await createCliAgent(
    {
      live: false,
      workspace,
      sandbox: 'workspace-write',
      agentLoop: loop,
      backgroundSubagents: { maxActive: 2 },
    },
    withScriptedModel(
      [
        instrumentEntry(seen),
        ...shipped.flatMap((entry) =>
          entry.id === 'sandbox-policy' ? [...beforeSandbox, entry] : [entry],
        ),
        { plugin: workspaceChangesPlugin, config: {} },
        worker,
        hostToolsEntry(createHostToolsSlot()),
      ],
      [
        { content: '', toolCalls: [{ name: 'ls', args: { path: '/' }, id: 'root-ls' }] },
        {
          content: '',
          toolCalls: [
            {
              name: 'subagent',
              args: { description: '叫一下 ls', subagent_type: 'worker', run_in_background: false },
              id: 'root-sub',
            },
          ],
        },
        { content: '好了' },
      ],
    ),
    workspace,
  );
  const sessions = new SessionRegistry('root-1');
  const detach = built.attachSession(sessions);
  try {
    const state = (await built.agent.invoke(
      { messages: [new HumanMessage('動手')] },
      { configurable: { thread_id: 'plugin-tool-cells' } },
    )) as { messages: BaseMessage[] };
    const toolEvents = sessions.root.events
      .filter((event) => event.type === 'tool/call' || event.type === 'tool/result')
      .map((event) => ({ type: event.type, data: event.data }));
    const childModes = sessions
      .list()
      .filter((entry) => entry.address.kind === 'subagent')
      .flatMap((entry) => entry.log.events.filter((event) => event.type === 'sandbox/mode'))
      .map((event) => event.data);
    return { seen, messages: state.messages, toolEvents, childModes };
  } finally {
    detach();
    await built.dispose();
  }
}

const count = (seen: Seen, cell: string, callId: string) =>
  seen.counts.get(cell)?.get(callId) ?? { native: 0, wrapToolCall: 0 };

describe.each(['native', 'langgraph'] as const)(
  '%s：插件與 harness 的三格每次呼叫只跑一次',
  (loop) => {
    const root =
      loop === 'native' ? { native: 1, wrapToolCall: 0 } : { native: 0, wrapToolCall: 1 };

    it('root 的兩次呼叫與子代理的那一次：每一格各跑一次，走對的那一條路', async () => {
      const { seen, messages } = await run(loop);
      expect(messages.at(-1)?.text).toBe('好了');
      for (const cell of CELLS) {
        expect([cell, count(seen, cell, 'root-ls')]).toEqual([cell, root]);
        expect([cell, count(seen, cell, 'root-sub')]).toEqual([cell, root]);
        expect([cell, count(seen, cell, 'sub-ls')]).toEqual([cell, { native: 0, wrapToolCall: 1 }]);
      }
    });

    it('前景委派：內層看到 task，模型拿回的結果叫 subagent，日誌記的是 subagent', async () => {
      const { seen, messages, toolEvents } = await run(loop);
      // 改名的那一格在 workspace-changes 外面：它自己看到 `subagent`，workspace-changes 看到 `task`。
      expect(seen.names.get(BACKGROUND_DELEGATION_MIDDLEWARE_NAME)?.get('root-sub')).toEqual([
        'subagent',
      ]);
      expect(seen.names.get(WORKSPACE_CHANGES_MIDDLEWARE_NAME)?.get('root-sub')).toEqual(['task']);
      const result = messages.find(
        (message): message is ToolMessage =>
          ToolMessage.isInstance(message) && message.tool_call_id === 'root-sub',
      );
      expect(result?.name).toBe('subagent');
      expect(result?.text).toContain('子代理好了');
      expect(
        toolEvents.filter(
          (event) => (event.data as { callId?: unknown; id?: unknown }).callId === 'root-sub',
        ),
      ).toMatchInlineSnapshot(`
      [
        {
          "data": {
            "arguments": "{"description":"叫一下 ls","subagent_type":"worker","run_in_background":false}",
            "callId": "root-sub",
            "name": "subagent",
          },
          "type": "tool/call",
        },
        {
          "data": {
            "callId": "root-sub",
            "isError": false,
            "message": {
              "data": {
                "additional_kwargs": {},
                "content": "子代理好了",
                "name": "subagent",
                "response_metadata": {},
                "tool_call_id": "root-sub",
              },
              "type": "tool",
            },
          },
          "type": "tool/result",
        },
      ]
    `);
    });

    it('委派那一刻同步拍沙箱快照：模型叫的是 subagent、改名成 task 的那一次，往內交之後才切的那一格，子代理看不到', async () => {
      const flipped: string[] = [];
      const names = new Map<string, string>();
      const { childModes, messages } = await run(loop, [flipAfterDelegating(flipped, names)]);
      expect(messages.at(-1)?.text).toBe('好了');
      // 沙箱的監聽者認的是 `exec.name`：改名那一格在 `tools/execute` 外面，匯流排上看到的已經是 `task`。
      expect(names.get('root-sub')).toBe('task');
      // 切了，root 的模式真的變了：子代理沒跟著變，不是因為根本沒切。
      expect(flipped).toEqual(['read-only']);
      expect(childModes).toEqual([{ mode: 'workspace-write', source: 'delegation' }]);
    });
  },
);
