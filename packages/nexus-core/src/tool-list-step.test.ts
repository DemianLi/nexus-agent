/**
 * `tool-list-step.ts` 的轉接：一步回 `undefined` 時往內交原本那個請求、回清單時只換 `tools`、同步的一步在同一個 tick 往內交、
 * 回 `Promise` 的等它解開，有 `inner` 時交給它，以及 `createToolListStepMiddleware` 造的那顆登記了這一步、`withToolListStep` 登記時核對
 * `wrapModelCall` 就是用那一步與 `inner` 造的。
 * 掛進各顆 middleware 之後的行為在各顆自己的測試；native 的 root 直接呼叫這一步見 `native-loop/model-cells.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import {
  createToolListStepMiddleware,
  toolListCellOf,
  withToolListStep,
  wrapModelCallWith,
} from './tool-list-step.js';
import type { ToolListRequest } from './tool-list-step.js';

const alpha = { name: 'alpha' };
const beta = { name: 'beta' };
const request = {
  tools: [alpha, beta],
  messages: ['hi'],
  state: { messages: [] },
  runtime: { configurable: { thread_id: 't1' } },
};

describe('wrapModelCallWith', () => {
  it('回 undefined：往內交的就是原本那個請求物件', () => {
    let seen: unknown;
    const result = wrapModelCallWith(() => undefined)(request, (r: unknown) => {
      seen = r;
      return 'done';
    });
    expect(seen).toBe(request);
    expect(result).toBe('done');
  });

  it('回清單：只換 tools，其餘鍵照舊', () => {
    let seen: (typeof request & ToolListRequest) | undefined;
    wrapModelCallWith((r) => r.tools.slice(1))(request, (r: typeof request) => {
      seen = r;
      return undefined;
    });
    expect(seen).toEqual({ ...request, tools: [beta] });
    expect(seen?.messages).toBe(request.messages);
    expect(seen?.state).toBe(request.state);
  });

  it('同步的一步：在同一個 tick 往內交，回的就是 handler 回的那一個', () => {
    const order: string[] = [];
    const response = Promise.resolve('model');
    const result = wrapModelCallWith(() => {
      order.push('step');
      return [alpha];
    })(request, () => {
      order.push('handler');
      return response;
    });
    order.push('returned');
    expect(order).toEqual(['step', 'handler', 'returned']);
    expect(result).toBe(response);
  });

  it('回 Promise 的一步：解開之後才往內交', async () => {
    const order: string[] = [];
    const result = wrapModelCallWith(async () => {
      order.push('step');
      return [beta];
    })(request, (r: ToolListRequest) => {
      order.push(`handler ${String(r.tools.length)}`);
      return 'model';
    });
    order.push('returned');
    await expect(result).resolves.toBe('model');
    expect(order).toEqual(['step', 'returned', 'handler 1']);
  });

  it('有 inner：交給它，由它再交給 handler', () => {
    const seen: unknown[] = [];
    const handler = (r: unknown) => r;
    const result = wrapModelCallWith(
      () => [alpha],
      (r: ToolListRequest, h: typeof handler) => {
        seen.push(r.tools, h);
        return 'inner';
      },
    )(request, handler);
    expect(seen).toEqual([[alpha], handler]);
    expect(result).toBe('inner');
  });
});

describe('登記', () => {
  it('createToolListStepMiddleware 造的那顆登記了這一步，wrapModelCall 跑的是同一步', () => {
    const step = () => [alpha];
    const middleware = createToolListStepMiddleware('nexusListOnly', step) as unknown as {
      name: string;
      wrapModelCall: (r: unknown, h: (r: ToolListRequest) => unknown) => unknown;
    };
    expect(middleware.name).toBe('nexusListOnly');
    expect(toolListCellOf(middleware)).toEqual({ step });
    expect(middleware.wrapModelCall(request, (r) => r.tools)).toEqual([alpha]);
  });

  it('withToolListStep 連 inner 一起登記；沒登記的查不到，複製出來的也查不到', () => {
    const step = () => undefined;
    const inner = () => 'inner';
    const middleware = withToolListStep(
      { name: 'm', wrapModelCall: wrapModelCallWith(step, inner) },
      step,
      inner,
    );
    expect(toolListCellOf(middleware)).toEqual({ step, inner });
    expect(toolListCellOf({ ...middleware })).toBeUndefined();
    expect(toolListCellOf({ name: 'other' })).toBeUndefined();
  });

  it('同一步配同一支 inner，wrapModelCallWith 每次給同一支；換 inner 就不是', () => {
    const step = () => undefined;
    const inner = () => 'inner';
    expect(wrapModelCallWith(step)).toBe(wrapModelCallWith(step));
    expect(wrapModelCallWith(step, inner)).toBe(wrapModelCallWith(step, inner));
    expect(wrapModelCallWith(step, inner)).not.toBe(wrapModelCallWith(step));
  });

  it('wrapModelCall 不是用登記的那一步造的：登記時就拋，不登記', () => {
    const running = () => [alpha];
    const registered = () => undefined;
    const middleware = { name: 'm', wrapModelCall: wrapModelCallWith(running) };
    expect(() => withToolListStep(middleware, registered)).toThrow(/"m" 的 wrapModelCall/);
    expect(toolListCellOf(middleware)).toBeUndefined();
  });

  it('wrapModelCall 是同一步、但 inner 不同：登記時就拋', () => {
    const step = () => undefined;
    const inner = () => 'inner';
    const middleware = { name: 'm', wrapModelCall: wrapModelCallWith(step, inner) };
    expect(() => withToolListStep(middleware, step)).toThrow(/"m" 的 wrapModelCall/);
    expect(() => withToolListStep(middleware, step, () => 'other')).toThrow(/"m" 的 wrapModelCall/);
  });
});
