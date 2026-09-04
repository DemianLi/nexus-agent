/**
 * `@nexus/plugin-validation` 的單元驗收。
 *
 * 這一層只驗 schema 校驗 middleware 自己的邏輯——直接餵它一個假的 `handler`，看它把什麼
 * 交回來。「掛進真的 agent 之後行為對不對」在 `apps/harness/src/validation.test.ts`。
 *
 * **圍堵不在這裡了。** 它連同它的單元測試搬進 `@nexus/core`
 * （[#159](https://github.com/DemianLi/nexus-agent/issues/159)，測試在
 * `packages/nexus-core/src/containment.test.ts`）——它是每次組裝都該有的性質，不是這個
 * plugin 的選配功能。下面「plugin 掛上去的形狀」那組因此**翻了面**：它們現在釘的是
 * 這個 plugin **不再**掛圍堵。
 */

import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { CONTAINMENT_MIDDLEWARE_NAME, loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
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
  /**
   * **這一條是翻過面的絆索。** 它以前釘的是「圍堵永遠掛、而且 prepend」；圍堵搬進 fold
   * 打底之後（#159），這個 plugin 再掛一份就是**兩個擁有者**——比任一個單獨擁有更糟。
   * 這裡紅了代表有人把它掛回來了。
   */
  it('**沒 schema 就一個 middleware 都不掛**——圍堵不再歸這個 plugin', async () => {
    const { registry } = await loadPlugins([createValidationPlugin()]);
    expect(registry.middleware.list()).toEqual([]);
    expect(registry.capabilities.has(VALIDATION_CAPABILITY)).toBe(true);
  });

  it('有 schema 就只掛校驗那一個，而且不 prepend', async () => {
    const { registry } = await loadPlugins([
      createValidationPlugin({ schemas: { probe: z.object({ count: z.number() }) } }),
    ]);
    const entries = registry.middleware.list();
    expect(
      entries.map((entry) => [
        (entry.value.middleware as { name: string }).name,
        entry.value.prepend,
      ]),
    ).toEqual([[OUTPUT_SCHEMA_MIDDLEWARE_NAME, false]]);
    // 名字還從這裡 re-export 得出來（相容），但那跟「有沒有掛」是兩件事。
    expect(
      entries.some(
        (entry) =>
          (entry.value.middleware as { name: string }).name === CONTAINMENT_MIDDLEWARE_NAME,
      ),
    ).toBe(false);
  });
});
