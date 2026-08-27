/**
 * `@nexus/plugin-validation` 的單元驗收。
 *
 * 這一層只驗兩個 middleware 自己的邏輯——直接餵它一個假的 `handler`，看它把什麼交回來。
 * 「掛進真的 agent 之後行為對不對」在 `apps/harness/src/validation.test.ts`，
 * 那一層才碰得到基座那條「工具拋錯就整場死」的路。
 */

import { ToolMessage } from '@langchain/core/messages';
import { Command, GraphInterrupt } from '@langchain/langgraph';
import { loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CONTAINMENT_MIDDLEWARE_NAME,
  createContainmentMiddleware,
  createOutputSchemaMiddleware,
  createValidationPlugin,
  OUTPUT_SCHEMA_MIDDLEWARE_NAME,
  VALIDATION_CAPABILITY,
} from './index.js';

/** middleware 的 `wrapToolCall` 拿出來直接呼叫用的形狀。 */
type Wrapper = (
  request: unknown,
  handler: (request: unknown) => Promise<unknown>,
) => Promise<unknown>;

/** 從 middleware 上取出 `wrapToolCall`，沒有就當場失敗。 */
function wrapperOf(middleware: unknown): Wrapper {
  const wrap = (middleware as { wrapToolCall?: Wrapper }).wrapToolCall;
  if (wrap === undefined) throw new Error('這個 middleware 沒有 wrapToolCall');
  return wrap;
}

/** 一次工具呼叫的假請求。 */
function requestFor(toolName: string): unknown {
  return {
    toolCall: { name: toolName, args: {}, id: 'call-1' },
    tool: undefined,
    state: {},
    runtime: {},
  };
}

/** 一則成功的 ToolMessage。 */
function ok(content: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: 'call-1', name: 'probe' });
}

describe('圍堵', () => {
  const wrap = wrapperOf(createContainmentMiddleware());

  it('工具拋錯 → 一則 status error 的 ToolMessage，不再往外拋', async () => {
    const result = (await wrap(requestFor('probe'), () => {
      throw new Error('磁碟滿了');
    })) as ToolMessage;
    expect(ToolMessage.isInstance(result)).toBe(true);
    expect(result.status).toBe('error');
    expect(String(result.content)).toContain('probe');
    expect(String(result.content)).toContain('磁碟滿了');
    expect(result.tool_call_id).toBe('call-1');
  });

  it('訊息裡不帶堆疊、也不帶原始參數', async () => {
    const boom = new Error('炸了');
    boom.stack = 'Error: 炸了\n    at /Users/someone/secret/path.ts:1:1';
    const result = (await wrap(
      { toolCall: { name: 'probe', args: { key: 'sk-機密值' }, id: 'c' } },
      () => {
        throw boom;
      },
    )) as ToolMessage;
    expect(String(result.content)).not.toContain('/Users/someone/secret/path.ts');
    expect(String(result.content)).not.toContain('sk-機密值');
  });

  it('**中斷放行**——GraphBubbleUp 原樣往外拋', async () => {
    const interrupt = new GraphInterrupt([{ value: '要核准嗎', id: 'i1' }]);
    await expect(
      wrap(requestFor('probe'), () => {
        throw interrupt;
      }),
    ).rejects.toBe(interrupt);
  });

  it('沒出錯就原樣交回去', async () => {
    const message = ok('好了');
    expect(await wrap(requestFor('probe'), async () => message)).toBe(message);
  });
});

describe('輸出 schema 校驗', () => {
  const schema = z.object({ count: z.number() });
  const wrap = wrapperOf(createOutputSchemaMiddleware({ probe: schema }));

  it('合的原樣放行', async () => {
    const message = ok('{"count":3}');
    expect(await wrap(requestFor('probe'), async () => message)).toBe(message);
  });

  it('不合的換成帶原因的 error ToolMessage，**而且原輸出不跟著出去**', async () => {
    const result = (await wrap(requestFor('probe'), async () =>
      ok('{"count":"三"}'),
    )) as ToolMessage;
    expect(result.status).toBe('error');
    expect(String(result.content)).toContain('count');
    expect(String(result.content)).not.toContain('三');
  });

  it('不是合法 JSON 也算不合', async () => {
    const result = (await wrap(requestFor('probe'), async () => ok('三個'))) as ToolMessage;
    expect(result.status).toBe('error');
    expect(String(result.content)).toContain('合法的 JSON');
  });

  it('沒宣告 schema 的工具原樣放行', async () => {
    const message = ok('隨便什麼都行');
    expect(await wrap(requestFor('other'), async () => message)).toBe(message);
  });

  it('已經是 error 的結果不重寫——蓋掉會把真正的原因弄丟', async () => {
    const failed = new ToolMessage({
      content: '工具 probe 執行失敗：磁碟滿了',
      tool_call_id: 'call-1',
      name: 'probe',
      status: 'error',
    });
    expect(await wrap(requestFor('probe'), async () => failed)).toBe(failed);
  });

  it('**Command 不是旁路**——夾在 update.messages 裡的輸出照樣驗', async () => {
    const bad = new Command({
      update: {
        messages: [new ToolMessage({ content: '{"count":"三"}', tool_call_id: 'call-1' })],
      },
    });
    const result = (await wrap(requestFor('probe'), async () => bad)) as ToolMessage;
    expect(ToolMessage.isInstance(result)).toBe(true);
    expect(result.status).toBe('error');
  });

  it('Command 裡合格的輸出原樣放行（上一條的對照組）', async () => {
    const good = new Command({
      update: { messages: [new ToolMessage({ content: '{"count":3}', tool_call_id: 'call-1' })] },
    });
    expect(await wrap(requestFor('probe'), async () => good)).toBe(good);
  });

  it('校驗器自己壞掉是 fail-closed，不是放行', async () => {
    const brokenSchema = {
      safeParse() {
        throw new Error('schema 自己炸了');
      },
    } as unknown as z.ZodType;
    const broken = wrapperOf(createOutputSchemaMiddleware({ probe: brokenSchema }));
    const result = (await broken(requestFor('probe'), async () =>
      ok('{"count":3}'),
    )) as ToolMessage;
    expect(result.status).toBe('error');
    expect(String(result.content)).toContain('不予採信');
  });
});

describe('plugin 掛上去的形狀', () => {
  it('圍堵永遠掛、而且 prepend；沒 schema 就不掛校驗那一半', async () => {
    const { registry } = await loadPlugins([createValidationPlugin()]);
    const entries = registry.middleware.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value.prepend).toBe(true);
    expect((entries[0]?.value.middleware as { name: string }).name).toBe(
      CONTAINMENT_MIDDLEWARE_NAME,
    );
    expect(registry.capabilities.has(VALIDATION_CAPABILITY)).toBe(true);
  });

  it('有 schema 就兩個都掛，圍堵 prepend、校驗不 prepend', async () => {
    const { registry } = await loadPlugins([
      createValidationPlugin({ schemas: { probe: z.object({ count: z.number() }) } }),
    ]);
    const entries = registry.middleware.list();
    expect(
      entries.map((entry) => [
        (entry.value.middleware as { name: string }).name,
        entry.value.prepend,
      ]),
    ).toEqual([
      [CONTAINMENT_MIDDLEWARE_NAME, true],
      [OUTPUT_SCHEMA_MIDDLEWARE_NAME, false],
    ]);
  });
});
