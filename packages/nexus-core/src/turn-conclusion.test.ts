/**
 * 「這一輪在這一批工具之後收」的落點（[#1607](https://github.com/DemianLi/nexus-agent/issues/1607)）：
 * `returnDirect` 工具的結果，**標了才保留 `name`**；沒標、混批、拋錯、被拒絕都拿掉 `name`。
 *
 * 直接餵圍堵一個假 handler，看它交回什麼——`name` 在不在就是基座路由（`ReactAgent.js:359-365`）收不收的判準
 * （`apps/harness/src/returndirect-route.test.ts` 釘基座那一側）。
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { createContainmentMiddleware } from './containment.js';
import { markToolError, toolErrorOf } from './tool-events.js';
import { concludeTurn } from './tool-result-meta.js';
import { settleTurnConclusion } from './turn-conclusion.js';

type Wrapper = (
  request: unknown,
  handler: (request: unknown) => Promise<unknown>,
) => Promise<unknown>;

const wrap = (createContainmentMiddleware() as unknown as { wrapToolCall: Wrapper }).wrapToolCall;

const TOOL = 'concluder';

/** 一次 `wrapToolCall` 請求；`batch` 是同一則 AI 訊息叫了哪幾顆工具（第一顆是這一次）。 */
function requestFor(options: { returnDirect?: boolean; batch?: string[] } = {}) {
  const names = options.batch ?? [TOOL];
  return {
    toolCall: { name: TOOL, args: {}, id: 'c1' },
    tool: { name: TOOL, ...(options.returnDirect === false ? {} : { returnDirect: true }) },
    state: {
      messages: [
        new AIMessage({
          content: '',
          tool_calls: names.map((name, at) => ({
            id: at === 0 ? 'c1' : `c${at + 1}`,
            name,
            args: {},
          })),
        }),
      ],
    },
    runtime: {},
  };
}

const named = (content = '好', extra: Partial<ConstructorParameters<typeof ToolMessage>[0]> = {}) =>
  new ToolMessage({ content, tool_call_id: 'c1', name: TOOL, status: 'success', ...extra });

describe('settleTurnConclusion', () => {
  it('標了、批裡只有這一個 → 原物返回（帶 name，路由收）', () => {
    const result = named();
    expect(settleTurnConclusion(requestFor(), result, true)).toBe(result);
  });

  it('沒標 → 拿掉 name；內容、狀態、id、artifact、additional_kwargs、response_metadata、metadata 原樣', () => {
    const original = named('錯', {
      status: 'error',
      id: 'm-1',
      artifact: { k: 1 },
      additional_kwargs: { a: 1 },
      response_metadata: { r: 1 },
      metadata: { versions: { x: '1' } },
    });
    const out = settleTurnConclusion(requestFor(), original, false) as ToolMessage;
    expect(out).not.toBe(original);
    expect(out.name).toBeUndefined();
    expect(out.content).toBe('錯');
    expect(out.status).toBe('error');
    expect(out.id).toBe('m-1');
    expect(out.tool_call_id).toBe('c1');
    expect(out.artifact).toEqual({ k: 1 });
    expect(out.additional_kwargs).toEqual({ a: 1 });
    expect(out.response_metadata).toEqual({ r: 1 });
    expect(out.metadata).toEqual({ versions: { x: '1' } });
  });

  it('沒標、原物上掛著錯誤碼 → 複本帶同一個碼（B2：WeakMap 掛在物件上，換物件要重掛）', () => {
    const original = markToolError(named('擋下', { status: 'error' }), {
      name: 'ApprovalDenied',
      code: 'APPROVAL_POLICY_NEVER',
    });
    const out = settleTurnConclusion(requestFor(), original, false);
    expect(out).not.toBe(original);
    expect(toolErrorOf(out)).toEqual({ name: 'ApprovalDenied', code: 'APPROVAL_POLICY_NEVER' });
  });

  it('標了、但同一批還有別的呼叫 → 也拿掉 name（基座混批會擲 InvalidUpdateError）', () => {
    const out = settleTurnConclusion(
      requestFor({ batch: [TOOL, 'write_todos'] }),
      named(),
      true,
    ) as ToolMessage;
    expect(out.name).toBeUndefined();
  });

  it.each([
    ['不是 returnDirect 工具', requestFor({ returnDirect: false }), named()],
    ['本來就沒有 name', requestFor(), new ToolMessage({ content: 'x', tool_call_id: 'c1' })],
    ['不是 ToolMessage（Command 這類）', requestFor(), { goto: 'x' }],
  ])('%s → 原物返回', (_label, request, value) => {
    expect(settleTurnConclusion(request, value, false)).toBe(value);
  });
});

describe('圍堵在最外層替 returnDirect 工具落定', () => {
  it('本體呼叫 concludeTurn → 保留 name；沒呼叫 → 拿掉', async () => {
    const kept = await wrap(requestFor(), async () => {
      concludeTurn(TOOL);
      return named();
    });
    expect((kept as ToolMessage).name).toBe(TOOL);

    const dropped = await wrap(requestFor(), async () => named());
    expect((dropped as ToolMessage).name).toBeUndefined();
  });

  it('別顆工具的名字標不到這一顆的槽', async () => {
    const out = await wrap(requestFor(), async () => {
      concludeTurn('another_tool');
      return named();
    });
    expect((out as ToolMessage).name).toBeUndefined();
  });

  it('本體拋錯（圍堵翻成錯誤訊息）→ 拿掉 name，仍是錯誤', async () => {
    const out = (await wrap(requestFor(), async () => {
      throw new Error('壞了');
    })) as ToolMessage;
    expect(out.name).toBeUndefined();
    expect(out.status).toBe('error');
    expect(out.text).toContain('壞了');
  });

  it('槽外呼叫 concludeTurn 什麼都不做', () => {
    expect(() => concludeTurn(TOOL)).not.toThrow();
  });
});
