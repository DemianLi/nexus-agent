/**
 * `task` 的 description 超過門檻時，兩個 loop 對前景子代理做的事一樣：基座的 `FilesystemMiddleware.beforeAgent` 把它搬到
 * `/conversation_history`，模型看到的是搬走後的那句；搬出去的檔在子代理自己的 state 裡，內容是原本那段。搬檔路徑的編號每次
 * 不同，比對前換成 `<id>`。檔的內容用 `peek` 從工具拿到的 state 直接讀：`read_file` 會替每行加行號、把超過 5000 字的行切段，
 * 整份輸出超過 80,000 字還會截斷，讀回的字串不等於原文。
 */

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { assembleAgent } from '../agent-assembly.js';
import { HUMAN_MESSAGE_LIMIT_CHARS } from '../human-message-admission.js';
import { fakePlugin } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { loadPlugins } from '../load.js';
import { LOOPS, type Loop } from './human-input-loops.fixture.js';

const LONG = '長'.repeat(HUMAN_MESSAGE_LIMIT_CHARS + 1);

interface Seen {
  /** 子代理第一次叫模型收到的人話。 */
  readonly human: readonly string[];
  /** 子代理照那句裡的路徑叫 `peek` 拿回的結果。 */
  readonly peek: string | undefined;
}

/**
 * 子代理沒宣告 model，跟 root 共用同一顆 fakeModel：第 0 次是 root 叫 `task`，第 1 次是子代理（照人話裡的路徑叫 `peek`），
 * 第 2 次是子代理收到 `peek` 的結果。
 */
async function delegateLong(loop: Loop): Promise<Seen> {
  const { registry } = await loadPlugins([
    fakePlugin('worker', (r) => {
      r.tools.register(
        tool(
          ({ path }, runtime) => {
            const { state } = runtime as { state?: { files?: Record<string, unknown> } };
            const file = state?.files?.[path] as { content?: unknown } | undefined;
            const content = file?.content;
            const text = Array.isArray(content) ? content.join('\n') : String(content);
            return JSON.stringify({
              found: file !== undefined,
              chars: text.length,
              same: text === LONG,
            });
          },
          {
            name: 'peek',
            description: '看 state 裡的檔。',
            schema: z.object({ path: z.string() }),
          },
        ),
      );
      r.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
      });
    }),
  ]);
  const model = fakeModel()
    .respondWithTools([
      { name: 'task', args: { description: LONG, subagent_type: 'worker' }, id: 'task-1' },
    ])
    .respond((messages) => {
      const human = (messages as BaseMessage[]).find((m) => HumanMessage.isInstance(m));
      const path = /\/conversation_history\/[0-9a-f]+/.exec(human?.text ?? '')?.[0];
      return new AIMessage({
        content: '',
        tool_calls: [{ name: 'peek', args: { path: path ?? '/missing' }, id: 'peek-1' }],
      });
    })
    .respond(new AIMessage('子代理收完'))
    .respond(new AIMessage('root 收完'));
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    summarization: false,
    defaultBackend: backend,
    events: registry.dispatch,
    loop,
  });
  const agent = assembleAgent({
    ...params,
    model,
    backend: params.backend ?? backend,
    loop,
    events: registry.dispatch,
  }) as unknown as { invoke(input: unknown, config: object): Promise<unknown> };
  await agent.invoke(
    { messages: [new HumanMessage('動手')] },
    { configurable: { thread_id: 't' } },
  );
  const read = (model.calls[2]?.messages as BaseMessage[]).findLast((m) =>
    ToolMessage.isInstance(m),
  );
  return {
    human: (model.calls[1]?.messages as BaseMessage[])
      .filter((m) => HumanMessage.isInstance(m))
      .map((m) =>
        m.text.replace(/\/conversation_history\/[0-9a-f]+/, '/conversation_history/<id>'),
      ),
    peek: read?.text,
  };
}

describe('task 的 description 超過門檻', () => {
  it('兩個 loop 送進子代理模型的人話一樣，搬出去的檔都在子代理的 state 裡、是原本那段', async () => {
    const [langgraph, native] = await Promise.all(LOOPS.map(delegateLong));
    // 以 langgraph 為基準：兩邊都沒搬或都讀不到時，下面的 toEqual 也會綠，所以先釘 langgraph 真的搬了、檔讀得到。
    expect(langgraph?.human[0]).toContain('/conversation_history/<id>');
    expect(langgraph?.peek).toBe(JSON.stringify({ found: true, chars: LONG.length, same: true }));
    expect(native).toEqual(langgraph);
  });
});
