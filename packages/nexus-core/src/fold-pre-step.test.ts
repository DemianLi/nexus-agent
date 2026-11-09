/**
 * fold 什麼時候掛 pre-step 轉接格與補回 `name` 那一顆、掛在哪：
 *
 * - pre-step 轉接格：只在 `langgraph` 下、派發面上有 `agent/pre-step` 監聽者時掛，只折進 root，排在插件 `prepend` 那一批正前面；
 * - 補回 `name`：只在那一份工具清單裡有 `returnDirect` 工具時掛，root 與每個子代理各看自己的清單，排在 pre-step 轉接格之後、
 *   插件 `prepend` 那一批之前。
 *
 * 兩顆各自做什麼見 `pre-step-adapter.test.ts`、`tool-name-restore.test.ts`。
 */

import type { StructuredTool } from '@langchain/core/tools';
import type { SubAgent } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { EventBus } from './events.js';
import type { FoldOptions } from './fold.js';
import { foldRegistry } from './fold.js';
import { fakeMiddleware, fakePlugin, fakeSubAgent, fakeTool } from './fixtures.js';
import { loadPlugins } from './load.js';
import type { PluginEntry } from './plugin.js';
import { PRE_STEP_ADAPTER_MIDDLEWARE_NAME } from './pre-step-adapter.js';
import { TOOL_NAME_RESTORE_MIDDLEWARE_NAME } from './tool-name-restore.js';

async function fold(plugins: PluginEntry[], options: FoldOptions = {}) {
  const { registry } = await loadPlugins(plugins);
  return foldRegistry(registry, {
    summarization: false,
    repeatReminder: false,
    observationPolicy: false,
    ...options,
  });
}

const namesOf = (middleware: readonly unknown[] | undefined): string[] =>
  (middleware ?? []).map((each) => (each as { name: string }).name);

/** 宣告了 `returnDirect` 的工具（`NexusTool` 的 `concludesTurn` 經轉接器轉成的就是這一格）。 */
function concluding(name: string): StructuredTool {
  const tool = fakeTool(name);
  tool.returnDirect = true;
  return tool;
}

function listening(): EventBus {
  const bus = new EventBus();
  bus.on('agent/pre-step', (_payload, next) => next());
  return bus;
}

const prepended = fakePlugin(
  'early',
  (r) => void r.middleware.use(fakeMiddleware('early'), { prepend: true }),
);

describe('pre-step 轉接格什麼時候掛', () => {
  it('langgraph、有監聽者：掛在 root，排在插件 prepend 那一批正前面；子代理沒有', async () => {
    const params = await fold(
      [prepended, fakePlugin('team', (r) => void r.subagents.register(fakeSubAgent('helper')))],
      {
        events: listening(),
      },
    );
    const root = namesOf(params.middleware);
    expect(root).toContain(PRE_STEP_ADAPTER_MIDDLEWARE_NAME);
    expect(root.indexOf(PRE_STEP_ADAPTER_MIDDLEWARE_NAME)).toBe(root.indexOf('early') - 1);
    for (const subagent of params.subagents) {
      expect(namesOf(subagent.middleware), subagent.name).not.toContain(
        PRE_STEP_ADAPTER_MIDDLEWARE_NAME,
      );
    }
  });

  it.each([
    ['native', { loop: 'native', events: listening() }],
    ['沒有監聽者', { events: new EventBus() }],
    ['沒有派發面', {}],
  ] as const)('%s：不掛', async (_label, options) => {
    const params = await fold([prepended], options as FoldOptions);
    expect(namesOf(params.middleware)).not.toContain(PRE_STEP_ADAPTER_MIDDLEWARE_NAME);
  });
});

describe('補回 name 那一顆什麼時候掛', () => {
  it('工具清單裡沒有 returnDirect 工具：root 與子代理都不掛', async () => {
    const params = await fold([
      fakePlugin('tools', (r) => void r.tools.register(fakeTool('plain'))),
      fakePlugin('team', (r) => void r.subagents.register(fakeSubAgent('helper'))),
    ]);
    expect(namesOf(params.middleware)).not.toContain(TOOL_NAME_RESTORE_MIDDLEWARE_NAME);
    for (const subagent of params.subagents) {
      expect(namesOf(subagent.middleware), subagent.name).not.toContain(
        TOOL_NAME_RESTORE_MIDDLEWARE_NAME,
      );
    }
  });

  it('全域有 returnDirect 工具：root 與繼承它的子代理都掛，排在插件 prepend 那一批正前面、pre-step 轉接格之後', async () => {
    const params = await fold(
      [
        prepended,
        fakePlugin('tools', (r) => void r.tools.register(concluding('finish'))),
        fakePlugin('team', (r) => void r.subagents.register(fakeSubAgent('helper'))),
      ],
      { events: listening() },
    );
    const root = namesOf(params.middleware);
    expect(
      root.slice(root.indexOf(PRE_STEP_ADAPTER_MIDDLEWARE_NAME), root.indexOf('early') + 1),
    ).toEqual([PRE_STEP_ADAPTER_MIDDLEWARE_NAME, TOOL_NAME_RESTORE_MIDDLEWARE_NAME, 'early']);
    for (const subagent of params.subagents) {
      const names = namesOf(subagent.middleware);
      expect(names.indexOf(TOOL_NAME_RESTORE_MIDDLEWARE_NAME), subagent.name).toBe(
        names.indexOf('early') - 1,
      );
    }
  });

  it('只有某個子代理自帶 returnDirect 工具：只有那個子代理掛', async () => {
    const params = await fold([
      fakePlugin('team', (r) => {
        r.subagents.register({
          ...fakeSubAgent('closer'),
          tools: [concluding('finish')],
        } as SubAgent);
        r.subagents.register(fakeSubAgent('plain'));
      }),
    ]);
    expect(namesOf(params.middleware)).not.toContain(TOOL_NAME_RESTORE_MIDDLEWARE_NAME);
    for (const subagent of params.subagents) {
      expect(
        namesOf(subagent.middleware).includes(TOOL_NAME_RESTORE_MIDDLEWARE_NAME),
        subagent.name,
      ).toBe(subagent.name === 'closer');
    }
  });
});
