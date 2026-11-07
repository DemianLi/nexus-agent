/**
 * 子代理的工具允許／拒絕清單（[#707](https://github.com/DemianLi/nexus-agent/issues/707)）在 fold 這一層的規則。
 *
 * 判準：只靠 fold 的輸入輸出斷言（子代理拿到哪些 `tools`、stack 裡有沒有那顆遮基座工具的 middleware）；
 * 遮罩真的擋住一次呼叫、真的不出現在模型的請求裡，由 `apps/harness` 的產品路徑測試量（真組裝、真子代理）。
 */

import { ToolMessage } from '@langchain/core/messages';
import type { SubAgent } from 'deepagents';
import { GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { fakePlugin, fakeSubAgent, fakeTool } from './fixtures.js';
import { foldRegistry, ROOT_ONLY_NOTICE } from './fold.js';
import type { FoldOptions } from './fold.js';
import { loadPlugins } from './load.js';
import type { PluginEntry } from './plugin.js';
import {
  assertToolFilter,
  createSubagentToolFilterMiddleware,
  filteredToolRefusal,
  SUBAGENT_TOOL_FILTER_MIDDLEWARE_NAME,
  toolKept,
} from './subagent-tool-filter.js';
import { TOOL_PRE_EXECUTE_MIDDLEWARE_NAME } from './tool-pipeline.js';

const BASE = ['ls', 'read_file', 'write_file', 'edit_file', 'delete', 'glob', 'grep', 'task'];

async function fold(plugins: PluginEntry[], options: FoldOptions = {}) {
  const { registry } = await loadPlugins(plugins);
  return foldRegistry(registry, {
    summarization: false,
    repeatReminder: false,
    observationPolicy: false,
    baseToolNames: BASE,
    ...options,
  });
}

const names = (tools: readonly { name: string }[] | undefined) => (tools ?? []).map((t) => t.name);
const middlewareNamesOf = (subagent: SubAgent) =>
  (subagent.middleware ?? []).map((each) => (each as { name: string }).name);

/** 兩個全域工具、一個 root-only、一個有自帶工具與 scoped 工具的子代理。 */
function team(): PluginEntry[] {
  return [
    fakePlugin('tools', (r) => {
      r.tools.register(fakeTool('alpha'));
      r.tools.register(fakeTool('beta'));
      r.tools.register(fakeTool('goal'), { rootOnly: true });
    }),
    fakePlugin('team', (r) => {
      r.subagents.register({ ...fakeSubAgent('researcher'), tools: [fakeTool('own')] });
      r.tools.register(fakeTool('scoped'), { scope: 'researcher' });
      r.subagents.register(fakeSubAgent('writer'));
    }),
  ];
}
const byName = (subagents: SubAgent[], name: string) => {
  const found = subagents.find((each) => each.name === name);
  if (found === undefined) throw new Error(`沒有子代理 ${name}`);
  return found;
};

describe('toolKept／assertToolFilter（純）', () => {
  it('deny 拿掉；allow 只留；兩邊都列到同一個名字時 deny 贏', () => {
    expect(toolKept({ deny: ['a'] }, 'a')).toBe(false);
    expect(toolKept({ deny: ['a'] }, 'b')).toBe(true);
    expect(toolKept({ allow: ['a'] }, 'a')).toBe(true);
    expect(toolKept({ allow: ['a'] }, 'b')).toBe(false);
    expect(toolKept({ allow: ['a'], deny: ['a'] }, 'a')).toBe(false);
  });

  it('allow: [] 是一個都不留（不是沒講）', () => {
    expect(toolKept({ allow: [] }, 'a')).toBe(false);
    expect(toolKept({ deny: [] }, 'a')).toBe(true);
  });

  it('{} 拋；給了空陣列不拋；未知名字拋並列出已知名單', () => {
    const known = new Set(['alpha', 'beta']);
    expect(() => assertToolFilter({}, known)).toThrow(/不能是空的/);
    expect(() => assertToolFilter({ allow: [] }, known)).not.toThrow();
    expect(() => assertToolFilter({ deny: ['gamma'] }, known)).toThrow(
      /deny 列了不認得的工具 "gamma"（已知的：alpha、beta）/,
    );
    expect(() => assertToolFilter({ allow: ['alpha', 'nope'] }, known)).toThrow(/allow.*"nope"/);
  });
});

describe('fold：registry 工具', () => {
  it('不給過濾：每個子代理的 tools 與 middleware 名單與沒有這一格時一樣（包括 general-purpose）', async () => {
    const plain = await fold(team());
    const explicitUndefined = await fold(team(), { subagentToolFilter: undefined });
    expect(explicitUndefined.subagents.map((s) => names(s.tools))).toEqual(
      plain.subagents.map((s) => names(s.tools)),
    );
    for (const subagent of plain.subagents) {
      expect(middlewareNamesOf(subagent)).not.toContain(SUBAGENT_TOOL_FILTER_MIDDLEWARE_NAME);
    }
  });

  it('deny 一個 registry 工具：每個子代理（含 general-purpose）都沒有；root 與其他工具仍在', async () => {
    const params = await fold(team(), { subagentToolFilter: { deny: ['alpha'] } });
    expect(names(params.tools)).toContain('alpha');
    expect(params.subagents.map((s) => s.name)).toContain(GENERAL_PURPOSE_SUBAGENT.name);
    for (const subagent of params.subagents) {
      expect(names(subagent.tools)).not.toContain('alpha');
      expect(names(subagent.tools)).toContain('beta');
    }
  });

  it('allow：繼承來的只剩列到的；子代理自帶的與它那層註冊的照舊在', async () => {
    const params = await fold(team(), { subagentToolFilter: { allow: ['alpha'] } });
    expect(names(byName(params.subagents, 'writer').tools)).toEqual(['alpha']);
    expect(names(byName(params.subagents, 'researcher').tools).sort()).toEqual([
      'alpha',
      'own',
      'scoped',
    ]);
  });

  it('allow: []：繼承來的全部遮光，自帶的與 scoped 仍在', async () => {
    const params = await fold(team(), { subagentToolFilter: { allow: [] } });
    expect(names(byName(params.subagents, 'writer').tools)).toEqual([]);
    expect(names(byName(params.subagents, 'researcher').tools).sort()).toEqual(['own', 'scoped']);
  });

  it('root-only：deny 列到就整顆消失；allow 留下時仍是拒絕樁', async () => {
    const denied = await fold(team(), { subagentToolFilter: { deny: ['goal'] } });
    expect(names(byName(denied.subagents, 'writer').tools)).not.toContain('goal');

    const kept = await fold(team(), { subagentToolFilter: { allow: ['goal'] } });
    const stub = byName(kept.subagents, 'writer').tools?.[0];
    expect(stub?.name).toBe('goal');
    expect(stub?.description).toContain(ROOT_ONLY_NOTICE);
    const answer = await stub?.invoke({});
    expect(ToolMessage.isInstance(answer) && answer.status).toBe('error');
  });

  it('明著往子代理註冊的同名工具不被遮（遮的只有繼承來的）', async () => {
    const plugins = [
      fakePlugin('g', (r) => void r.tools.register(fakeTool('alpha'))),
      fakePlugin('t', (r) => {
        r.subagents.register(fakeSubAgent('researcher'));
        r.tools.register(fakeTool('alpha'), { scope: 'researcher' });
      }),
    ];
    const params = await fold(plugins, { subagentToolFilter: { deny: ['alpha'] } });
    expect(names(byName(params.subagents, 'researcher').tools)).toEqual(['alpha']);
    expect(names(byName(params.subagents, GENERAL_PURPOSE_SUBAGENT.name).tools)).toEqual([]);
  });

  it('組裝期驗名字：{}、未知名字、只有子代理自己那層才有的名字，都拋', async () => {
    await expect(fold(team(), { subagentToolFilter: {} })).rejects.toThrow(/不能是空的/);
    await expect(fold(team(), { subagentToolFilter: { deny: ['alpah'] } })).rejects.toThrow(
      /"alpah"[\s\S]*alpha/,
    );
    // `scoped`、`own` 遮不到：照 dsh 只有繼承來的可遮，列了就是寫錯。
    await expect(fold(team(), { subagentToolFilter: { deny: ['scoped'] } })).rejects.toThrow(
      /"scoped"/,
    );
    await expect(fold(team(), { subagentToolFilter: { deny: ['own'] } })).rejects.toThrow(/"own"/);
  });
});

describe('fold：基座工具', () => {
  it('deny write_file：每個子代理的 stack 多一顆遮罩 middleware；root 的 middleware 沒有', async () => {
    const params = await fold(team(), { subagentToolFilter: { deny: ['write_file'] } });
    for (const subagent of params.subagents) {
      expect(middlewareNamesOf(subagent)).toContain(SUBAGENT_TOOL_FILTER_MIDDLEWARE_NAME);
    }
    expect(params.middleware.map((each) => (each as { name: string }).name)).not.toContain(
      SUBAGENT_TOOL_FILTER_MIDDLEWARE_NAME,
    );
  });

  it('遮罩 middleware 排在核准閘門外側（被遮的呼叫碰不到閘門）', async () => {
    const params = await fold(team(), {
      subagentToolFilter: { deny: ['write_file'] },
      checkpointer: true,
    });
    const order = middlewareNamesOf(byName(params.subagents, 'writer'));
    const filter = order.indexOf(SUBAGENT_TOOL_FILTER_MIDDLEWARE_NAME);
    const gate = order.findIndex((each) => each.toLowerCase().includes('approval'));
    expect(filter).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(filter);
  });

  it('只遮 registry 工具時沒有基座工具被遮：不放那顆 middleware', async () => {
    const params = await fold(team(), {
      subagentToolFilter: { deny: ['alpha'] },
      baseToolNames: [],
    });
    for (const subagent of params.subagents) {
      expect(middlewareNamesOf(subagent)).not.toContain(SUBAGENT_TOOL_FILTER_MIDDLEWARE_NAME);
    }
  });

  it('allow 一個 registry 工具：基座工具（除了列到的）也被遮', async () => {
    // 用遮罩 middleware 的行為反推被遮名單：請求裡的基座工具被拿掉，registry 工具不在它的射程。
    const params = await fold(team(), { subagentToolFilter: { allow: ['alpha', 'read_file'] } });
    const middleware = (byName(params.subagents, 'writer').middleware ?? []).find(
      (each) => (each as { name: string }).name === SUBAGENT_TOOL_FILTER_MIDDLEWARE_NAME,
    ) as unknown as {
      wrapModelCall: (
        request: { tools: { name: string }[] },
        handler: (request: { tools: { name: string }[] }) => unknown,
      ) => unknown;
    };
    let seen: string[] = [];
    await middleware.wrapModelCall(
      { tools: [...BASE, 'alpha'].map((name) => ({ name })) },
      (request) => {
        seen = names(request.tools);
        return undefined;
      },
    );
    expect(seen.sort()).toEqual(['alpha', 'read_file']);
  });
});

describe('遮罩 middleware 本身', () => {
  const middleware = createSubagentToolFilterMiddleware(new Set(['write_file'])) as unknown as {
    wrapModelCall: (
      request: { tools: { name: string }[] },
      handler: (request: { tools: { name: string }[] }) => unknown,
    ) => unknown;
  };

  it('把被遮的從請求拿掉，別的原樣', async () => {
    let seen: string[] = [];
    await middleware.wrapModelCall(
      { tools: [{ name: 'read_file' }, { name: 'write_file' }] },
      (request) => {
        seen = names(request.tools);
      },
    );
    expect(seen).toEqual(['read_file']);
  });
});

describe('遮罩的工具那一半：子代理那一份 pre 的外層 core 段', () => {
  type Pre = {
    wrapToolCall: (request: unknown, handler: (request: unknown) => unknown) => Promise<unknown>;
  };
  const preOf = (middleware: readonly unknown[] | undefined): Pre | undefined =>
    (middleware ?? []).find(
      (each) => (each as { name: string }).name === TOOL_PRE_EXECUTE_MIDDLEWARE_NAME,
    ) as Pre | undefined;
  const body = (counter: { ran: number }, id: string) => () => {
    counter.ran += 1;
    return new ToolMessage({ content: 'ok', tool_call_id: id });
  };
  const call = (pre: Pre, name: string, id: string, run: () => unknown) =>
    pre.wrapToolCall({ toolCall: { name, id, args: {} } }, run);

  /** 掛一位 `prepend` 的插件 pre 監聽者，記下它看到的每一個名字。 */
  async function foldWithHook(heard: string[], events: boolean) {
    const { registry } = await loadPlugins([
      ...team(),
      fakePlugin(
        'hook',
        (r) =>
          void r.events.on(
            'tools/pre-execute',
            (exec, next) => {
              heard.push(exec.name);
              return next();
            },
            { prepend: true },
          ),
      ),
    ]);
    return foldRegistry(registry, {
      summarization: false,
      repeatReminder: false,
      observationPolicy: false,
      baseToolNames: BASE,
      subagentToolFilter: { deny: ['write_file'] },
      ...(events && { events: registry.dispatch }),
    });
  }

  it('叫到被遮的：拒絕，`prepend` 的插件監聽者與工具本體都不跑；沒被遮的照常往下', async () => {
    const heard: string[] = [];
    const params = await foldWithHook(heard, true);
    const pre = preOf(byName(params.subagents, 'writer').middleware)!;
    const counter = { ran: 0 };

    const answer = await call(pre, 'write_file', 'c1', body(counter, 'c1'));
    expect(counter.ran).toBe(0);
    expect(heard).toEqual([]);
    expect(ToolMessage.isInstance(answer)).toBe(true);
    const message = answer as ToolMessage;
    expect(message.status).toBe('error');
    expect(message.tool_call_id).toBe('c1');
    expect(String(message.content)).toContain(filteredToolRefusal('write_file'));

    await call(pre, 'read_file', 'c2', body(counter, 'c2'));
    expect(counter.ran).toBe(1);
    expect(heard).toEqual(['read_file']);
  });

  it('root 那一份沒有遮罩；子代理之間共用同一份', async () => {
    const heard: string[] = [];
    const params = await foldWithHook(heard, true);
    const pre = preOf(byName(params.subagents, 'writer').middleware)!;
    const rootPre = preOf(params.middleware)!;
    expect(rootPre).not.toBe(pre);
    for (const subagent of params.subagents) expect(preOf(subagent.middleware)).toBe(pre);

    const counter = { ran: 0 };
    await call(rootPre, 'write_file', 'c3', body(counter, 'c3'));
    expect(counter.ran).toBe(1);
    expect(heard).toEqual(['write_file']);
  });

  it('沒給派發面：子代理照樣有那一份 pre、照樣拒絕；root 沒有', async () => {
    const heard: string[] = [];
    const params = await foldWithHook(heard, false);
    expect(preOf(params.middleware)).toBeUndefined();
    const pre = preOf(byName(params.subagents, 'writer').middleware);
    expect(pre).toBeDefined();

    const counter = { ran: 0 };
    const answer = await call(pre!, 'write_file', 'c4', body(counter, 'c4'));
    expect(counter.ran).toBe(0);
    expect((answer as ToolMessage).status).toBe('error');
    await call(pre!, 'read_file', 'c5', body(counter, 'c5'));
    expect(counter.ran).toBe(1);
  });
});
