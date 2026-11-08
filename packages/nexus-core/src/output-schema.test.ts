/**
 * 輸出 schema 校驗監聽者自己的邏輯——掛進 `tools/execute` 生產者的內層，直接餵一個假的 `handler`，看生產者把什麼交回來。
 * 「fold 有沒有把它打底進去、排在哪」在 `fold.test.ts`；「掛進真的 agent 之後行為對不對」在
 * `apps/harness/src/validation.test.ts`。
 */

import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createOutputSchemaListener } from './output-schema.js';
import type { OutputSchemaLookup } from './output-schema.js';
import { INVALID_TOOL_OUTPUT, toolErrorOf } from './tool-events.js';
import { createToolExecuteMiddleware } from './tool-pipeline.js';

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

/** 校驗監聽者掛在 `tools/execute` 內層、沒有派發面的那一顆生產者。 */
function outputSchemaProducer(schemaOf: OutputSchemaLookup): unknown {
  return createToolExecuteMiddleware(undefined, { inner: [createOutputSchemaListener(schemaOf)] });
}

/** 兩顆同名、不同實例的工具——校驗器以實例查 schema。 */
const probe = { name: 'probe' };
const otherProbe = { name: 'probe' };

/** 一次工具呼叫的假請求，`tool` 是那一顆實例。 */
function requestFor(tool: unknown): unknown {
  return { toolCall: { name: 'probe', args: {}, id: 'call-1' }, tool, state: {}, runtime: {} };
}

/** 一則成功的 ToolMessage。 */
function ok(content: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: 'call-1', name: 'probe' });
}

describe('輸出 schema 校驗', () => {
  const schema = z.object({ count: z.number() });
  const wrap = wrapperOf(outputSchemaProducer((tool) => (tool === probe ? schema : undefined)));

  it('合的原樣放行', async () => {
    const message = ok('{"count":3}');
    expect(await wrap(requestFor(probe), async () => message)).toBe(message);
  });

  it('不合的換成帶原因與碼的 error ToolMessage，**而且原輸出不跟著出去**', async () => {
    const result = (await wrap(requestFor(probe), async () => ok('{"count":"三"}'))) as ToolMessage;
    expect(result.status).toBe('error');
    expect(String(result.content)).toContain('count');
    expect(String(result.content)).not.toContain('三');
    expect(toolErrorOf(result)?.code).toBe(INVALID_TOOL_OUTPUT);
  });

  it('不是合法 JSON 也算不合', async () => {
    const result = (await wrap(requestFor(probe), async () => ok('三個'))) as ToolMessage;
    expect(result.status).toBe('error');
    expect(String(result.content)).toContain('合法的 JSON');
  });

  it('**以實例查，不以名字查**——同名的另一顆沒宣告，原樣放行', async () => {
    const message = ok('隨便什麼都行');
    expect(await wrap(requestFor(otherProbe), async () => message)).toBe(message);
  });

  it('已經是 error 的結果不重寫——蓋掉會把真正的原因弄丟', async () => {
    const failed = new ToolMessage({
      content: '工具 probe 執行失敗：磁碟滿了',
      tool_call_id: 'call-1',
      name: 'probe',
      status: 'error',
    });
    expect(await wrap(requestFor(probe), async () => failed)).toBe(failed);
  });

  it('**Command 不是旁路**——夾在 update.messages 裡的輸出照樣驗', async () => {
    const bad = new Command({
      update: {
        messages: [new ToolMessage({ content: '{"count":"三"}', tool_call_id: 'call-1' })],
      },
    });
    const result = (await wrap(requestFor(probe), async () => bad)) as ToolMessage;
    expect(ToolMessage.isInstance(result)).toBe(true);
    expect(result.status).toBe('error');
  });

  it('Command 裡合格的輸出原樣放行（上一條的對照組）', async () => {
    const good = new Command({
      update: { messages: [new ToolMessage({ content: '{"count":3}', tool_call_id: 'call-1' })] },
    });
    expect(await wrap(requestFor(probe), async () => good)).toBe(good);
  });

  it('校驗器自己壞掉是 fail-closed，不是放行，也不標碼', async () => {
    const brokenSchema = {
      safeParse() {
        throw new Error('schema 自己炸了');
      },
    } as unknown as z.ZodType;
    const broken = wrapperOf(outputSchemaProducer(() => brokenSchema));
    const result = (await broken(requestFor(probe), async () => ok('{"count":3}'))) as ToolMessage;
    expect(result.status).toBe('error');
    expect(String(result.content)).toContain('不予採信');
    expect(toolErrorOf(result)).toBeUndefined();
  });
});
