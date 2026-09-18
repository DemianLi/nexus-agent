/**
 * 薄測試：`apply` 真的往那兩個註冊點放了東西，加上這個套件自己拒絕的那一種，以及
 * 「discover 讀得到什麼」這一層（backend 是替身，不經過 agent）。
 *
 * **基線真的有沒有進到模型、會不會重複**的驗收在組裝點（`apps/harness/src/agent-instructions.test.ts`），
 * 而且那裡用的是零設定的 `DEFAULT_PLUGINS`。兩件事。
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import {
  AGENT_INSTRUCTIONS_CAPABILITY,
  AGENT_INSTRUCTIONS_MARKER,
  createAgentInstructionsMiddleware,
  createAgentInstructionsPlugin,
  DEFAULT_MAX_BYTES,
  INSTRUCTION_FILE_CANDIDATES,
  isAgentInstructionsMessage,
} from './index.js';

/** 只回得出指定那幾個檔的假 backend；其餘一律「讀不到」。 */
function fakeBackend(files: Record<string, string>) {
  return {
    read: (path: string) =>
      Object.prototype.hasOwnProperty.call(files, path)
        ? Promise.resolve({ content: files[path] })
        : Promise.resolve({ error: 'file_not_found' }),
  };
}

async function inject(
  files: Record<string, string>,
  messages: readonly BaseMessage[] = [],
  maxBytes = DEFAULT_MAX_BYTES,
  summarizationEvent?: unknown,
): Promise<BaseMessage[] | undefined> {
  const middleware = createAgentInstructionsMiddleware(
    fakeBackend(files) as never,
    maxBytes,
  ) as unknown as {
    beforeAgent: (state: {
      messages: readonly BaseMessage[];
      _summarizationEvent?: unknown;
    }) => Promise<unknown>;
  };
  const result = (await middleware.beforeAgent({
    messages,
    ...(summarizationEvent !== undefined && { _summarizationEvent: summarizationEvent }),
  })) as { messages: BaseMessage[] } | undefined;
  return result?.messages;
}

function baselineMessage(): HumanMessage {
  return new HumanMessage({
    content: '舊的基線',
    additional_kwargs: { [AGENT_INSTRUCTIONS_MARKER]: true },
  });
}

describe('createAgentInstructionsPlugin', () => {
  it('宣告能力，並且註冊的是「要 backend 才建得出來」的那一種', async () => {
    const { registry } = await loadPlugins([createAgentInstructionsPlugin()]);

    expect(registry.capabilities.has(AGENT_INSTRUCTIONS_CAPABILITY)).toBe(true);
    const entries = registry.middleware.list();
    expect(entries).toHaveLength(1);
    // **不是 `use()`。** 走 `use()` 的話它拿不到工作區，會變成一顆永遠讀不到檔的 middleware。
    expect(entries[0]?.value.build).toBeTypeOf('function');
    expect(entries[0]?.value.middleware).toBeUndefined();
  });

  it('上限不是正的有限數就當場拋，不會靜默變成「沒有工作區指令」', () => {
    expect(() => createAgentInstructionsPlugin({ maxBytes: 0 })).toThrow('正的有限數');
    expect(() => createAgentInstructionsPlugin({ maxBytes: -1 })).toThrow('正的有限數');
    expect(() => createAgentInstructionsPlugin({ maxBytes: Number.NaN })).toThrow('正的有限數');
  });
});

describe('讀工作區根那一層', () => {
  it('四個候選依序讀：基礎檔在前、local overlay 在後', async () => {
    expect([...INSTRUCTION_FILE_CANDIDATES]).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'AGENTS.local.md',
      'CLAUDE.local.md',
    ]);
    const messages = await inject({
      '/AGENTS.md': '一。',
      '/CLAUDE.md': '二。',
      '/AGENTS.local.md': '三。',
      '/CLAUDE.local.md': '四。',
    });
    const text = messages?.[0]?.text ?? '';
    const order = INSTRUCTION_FILE_CANDIDATES.map((name) =>
      text.indexOf(`Instructions from: ${name}`),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((left, right) => left - right));
  });

  it('一個候選都讀不到就不加訊息', async () => {
    expect(await inject({})).toBeUndefined();
  });

  it('空檔與不存在同形——空字串不值得佔一個標頭', async () => {
    expect(await inject({ '/AGENTS.md': '' })).toBeUndefined();
  });

  it('backend 拋錯不會把這一輪弄倒，只是少了那一份', async () => {
    const backend = {
      read: (path: string) =>
        path === '/AGENTS.md'
          ? Promise.reject(new Error('backend 壞了'))
          : Promise.resolve({ content: '還在。' }),
    };
    const middleware = createAgentInstructionsMiddleware(
      backend as never,
      DEFAULT_MAX_BYTES,
    ) as unknown as {
      beforeAgent: (state: { messages: readonly BaseMessage[] }) => Promise<unknown>;
    };
    const result = (await middleware.beforeAgent({ messages: [] })) as { messages: BaseMessage[] };
    expect(result.messages[0]?.text).toContain('Instructions from: CLAUDE.md');
    expect(result.messages[0]?.text).not.toContain('Instructions from: AGENTS.md');
  });

  it('同一層內容相同（去掉首尾空白之後）的只渲染一次，留先出現的那個路徑', async () => {
    const messages = await inject({ '/AGENTS.md': '同一份。', '/CLAUDE.md': '  同一份。\n' });
    const text = messages?.[0]?.text ?? '';
    expect(text).toContain('Instructions from: AGENTS.md');
    expect(text).not.toContain('Instructions from: CLAUDE.md');
  });
});

describe('一個 agent 一份', () => {
  it('訊息串裡已經有基線就不再加', async () => {
    const existing = baselineMessage();
    expect(isAgentInstructionsMessage(existing)).toBe(true);
    expect(await inject({ '/AGENTS.md': '規矩。' }, [existing])).toBeUndefined();
  });

  it('認的是記號不是文字：一則長得一模一樣但沒有記號的使用者訊息擋不住注入', async () => {
    const rendered = await inject({ '/AGENTS.md': '規矩。' });
    const copy = new HumanMessage({ content: rendered?.[0]?.text ?? '' });
    expect(isAgentInstructionsMessage(copy)).toBe(false);
    expect(await inject({ '/AGENTS.md': '規矩。' }, [copy])).toHaveLength(1);
  });
});

/**
 * 摘要之後（[#397](https://github.com/DemianLi/nexus-agent/issues/397)）。基座的摘要器不改寫
 * `state.messages`，只記一顆 `_summarizationEvent`，模型看到的是 `[summary, ...messages.slice(cutoffIndex)]`。
 * 這裡餵的是那顆事件的形狀；它真的是基座寫的那個形狀，由組裝點那側的上游絆索負責。
 */
describe('摘要之後：模型看得到一則才算有', () => {
  const summary = new HumanMessage({
    content: '前情提要。',
    additional_kwargs: { lc_source: 'summarization' },
  });
  const history = (): BaseMessage[] => [
    new HumanMessage('第一句'),
    baselineMessage(),
    new HumanMessage('第二句'),
    new HumanMessage('第三句'),
  ];

  it('舊基線落在切點之前：補一則新的', async () => {
    const event = { cutoffIndex: 2, summaryMessage: summary, filePath: null };
    const messages = await inject({ '/AGENTS.md': '規矩。' }, history(), DEFAULT_MAX_BYTES, event);
    expect(messages).toHaveLength(1);
    expect(isAgentInstructionsMessage(messages?.[0] as BaseMessage)).toBe(true);
  });

  it('舊基線就在切點上（模型看得到）：不補', async () => {
    const event = { cutoffIndex: 1, summaryMessage: summary, filePath: null };
    expect(
      await inject({ '/AGENTS.md': '規矩。' }, history(), DEFAULT_MAX_BYTES, event),
    ).toBeUndefined();
  });

  it('摘要訊息本身不會被當成基線——它是判準唯一可能的假陽性來源', () => {
    expect(isAgentInstructionsMessage(summary)).toBe(false);
  });

  it('認不出形狀的事件當成沒摘要過：退回「state 裡有一則就不補」', async () => {
    for (const event of [null, { cutoffIndex: '2', summaryMessage: summary }, { cutoffIndex: 2 }]) {
      expect(
        await inject({ '/AGENTS.md': '規矩。' }, history(), DEFAULT_MAX_BYTES, event),
      ).toBeUndefined();
    }
  });
});
