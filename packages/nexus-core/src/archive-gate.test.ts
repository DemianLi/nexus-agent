/**
 * 封存的準入閘門（#633），直接呼叫 `createTurnCancelGuard` 的鉤子量規則。
 *
 * 掛進真的組裝之後的行為（日誌上的 `blocked`、背景子代理、存檔點）在 `apps/harness`。
 */

import { AIMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { MiddlewareError } from 'langchain';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_GATE_CONFIG_KEY,
  archiveGateOf,
  isTurnBlocked,
  TurnBlockedError,
} from './archive-gate.js';
import { INTERRUPTED_REPLY_MARKER } from './turn-cancel.js';
import { createTurnCancelGuard, TURN_CANCEL_CONFIG_KEY } from './turn-cancel.js';

type Hook = (request: never, handler: (request: never) => Promise<unknown>) => Promise<unknown>;

const guard = (createTurnCancelGuard() as unknown as { wrapModelCall: Hook }).wrapModelCall;

function request(configurable: Record<string, unknown>, checkpointNs = 'model_request:def') {
  return {
    model: new FakeListChatModel({ responses: ['好'] }),
    messages: [],
    runtime: { configurable: { checkpoint_ns: checkpointNs, ...configurable } },
  } as never;
}

const SUBAGENT_NS = 'tools:abc|model_request:def';

describe('root：被擋下就拋 TurnBlockedError，不叫模型', () => {
  it('閘門回 true：當場拋，handler 一次都沒被叫', async () => {
    let called = false;
    await expect(
      guard(request({ [ARCHIVE_GATE_CONFIG_KEY]: () => true }), async () => {
        called = true;
        return undefined;
      }),
    ).rejects.toBeInstanceOf(TurnBlockedError);
    expect(called).toBe(false);
  });

  it('閘門回 false：原樣放行；沒有閘門也是', async () => {
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return 'ok';
    };
    expect(await guard(request({ [ARCHIVE_GATE_CONFIG_KEY]: () => false }), handler)).toBe('ok');
    expect(await guard(request({}), handler)).toBe('ok');
    expect(calls).toBe(2);
  });

  it('每次呼叫都問一次（不是只問第一次）', async () => {
    let asked = 0;
    const gate = () => (asked += 1) >= 2;
    const configurable = { [ARCHIVE_GATE_CONFIG_KEY]: gate };
    expect(await guard(request(configurable), async () => 'first')).toBe('first');
    await expect(guard(request(configurable), async () => 'second')).rejects.toBeInstanceOf(
      TurnBlockedError,
    );
    expect(asked).toBe(2);
  });

  it('中止先於閘門：已中止的拋 TurnCancelledError，且不問閘門', async () => {
    const controller = new AbortController();
    controller.abort();
    let asked = false;
    await expect(
      guard(
        request({
          [TURN_CANCEL_CONFIG_KEY]: controller.signal,
          [ARCHIVE_GATE_CONFIG_KEY]: () => {
            asked = true;
            return true;
          },
        }),
        async () => undefined,
      ),
    ).rejects.not.toBeInstanceOf(TurnBlockedError);
    expect(asked).toBe(false);
  });
});

describe('子代理那一層不拋，回空訊息收尾', () => {
  it('閘門回 true：回一則空的 AI 訊息（帶中斷標記），不拋也不叫模型；閘門被問到了', async () => {
    let called = false;
    let asked = 0;
    const result = await guard(
      request(
        {
          [ARCHIVE_GATE_CONFIG_KEY]: () => {
            asked += 1;
            return true;
          },
        },
        SUBAGENT_NS,
      ),
      async () => {
        called = true;
        return undefined;
      },
    );
    expect(called).toBe(false);
    expect(asked).toBe(1);
    expect(AIMessage.isInstance(result)).toBe(true);
    expect((result as AIMessage).tool_calls ?? []).toEqual([]);
    expect((result as AIMessage).additional_kwargs).toMatchObject({
      [INTERRUPTED_REPLY_MARKER]: true,
    });
  });
});

describe('isTurnBlocked', () => {
  it('沿 MiddlewareError 拆到底再認——基座每經過一層可能包一層', () => {
    const blocked = new TurnBlockedError();
    expect(isTurnBlocked(blocked)).toBe(true);
    expect(isTurnBlocked(MiddlewareError.wrap(MiddlewareError.wrap(blocked, 'a'), 'b'))).toBe(true);
  });

  it('其餘的錯不是擋下，也不比對訊息', () => {
    expect(isTurnBlocked(MiddlewareError.wrap(new Error('429'), 'a'))).toBe(false);
    expect(isTurnBlocked(new Error('這一輪被準入閘門擋下了（會話已封存）'))).toBe(false);
    expect(isTurnBlocked(undefined)).toBe(false);
  });
});

describe('archiveGateOf', () => {
  it('只認函式，別的東西放在那個鍵上當作沒有', () => {
    const gate = () => true;
    expect(archiveGateOf({ configurable: { [ARCHIVE_GATE_CONFIG_KEY]: gate } })).toBe(gate);
    expect(archiveGateOf({ configurable: { [ARCHIVE_GATE_CONFIG_KEY]: true } })).toBeUndefined();
    expect(archiveGateOf({})).toBeUndefined();
    expect(archiveGateOf(undefined)).toBeUndefined();
  });
});
