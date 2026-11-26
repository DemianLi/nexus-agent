/**
 * {@link toolCallOwner}（[#2355](https://github.com/DemianLi/nexus-agent/issues/2355)）：`log` 的 root 讀日誌，請求帶著 loop 交下來的
 * 那則就讀它，其餘（`langgraph`）讀 state。state、日誌與交下來的那則刻意做成不一樣，看得出讀的是哪一份；一樣的話這幾條永遠是綠的。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { markHistoryFromLog } from './history-shadow.js';
import { INVALID_ARGUMENTS_KEY, rawArgumentsOf } from './invalid-tool-args.js';
import { toLoggedMessage } from './logged-message.js';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';
import { ownerRequestOf, toolCallOwner } from './tool-call-owner.js';
import type { ToolCallOwner } from './tool-call-owner.js';

/** 日誌上那一則：兩顆呼叫，`b` 的參數解不開。 */
function logWithTwoCalls(): SessionLog {
  const log = new SessionLog('owner');
  log.append('turn/start', { kind: 'message', text: '查' });
  log.append('model/start', {});
  log.append('assistant/message', {
    message: toLoggedMessage(
      new AIMessage({
        id: 'from-log',
        content: '',
        tool_calls: [
          { id: 'a', name: 'grep', args: {}, type: 'tool_call' },
          { id: 'b', name: 'grep', args: {}, type: 'tool_call' },
        ],
        additional_kwargs: { [INVALID_ARGUMENTS_KEY]: { b: '{壞' } },
      }),
    ),
  });
  log.append('model/end', {});
  return log;
}

/** state 那一份：同一個 id 只有一顆、沒有記號。 */
const decoyState = {
  messages: [
    new HumanMessage('查'),
    new AIMessage({
      id: 'from-state',
      content: '',
      tool_calls: [{ id: 'b', name: 'grep', args: {}, type: 'tool_call' }],
    }),
  ],
};

const request = { toolCall: { id: 'b' }, state: decoyState, runtime: { configurable: {} } };

/** loop 交下來的那一則：兩顆呼叫，`b` 帶記號。 */
const handed: ToolCallOwner = {
  id: 'from-loop',
  tool_calls: [{ id: 'a' }, { id: 'b' }],
  additional_kwargs: { [INVALID_ARGUMENTS_KEY]: { b: '{交' } },
};

const handedRequest = { ...request, owner: handed };

const sessionsAt = (lookup: SessionLookup) => ({ forCall: (): SessionLookup => lookup });

describe('toolCallOwner', () => {
  it('沒標 log：讀 state', () => {
    const sessions = sessionsAt({ kind: 'ok', address: { kind: 'root' }, log: logWithTwoCalls() });
    expect(toolCallOwner(request, sessions)?.id).toBe('from-state');
    expect(toolCallOwner(request)?.id).toBe('from-state');
    expect(rawArgumentsOf(request, sessions)).toBeUndefined();
  });

  it('標了 log、root：讀日誌，不讀 state', () => {
    const sessions = sessionsAt({ kind: 'ok', address: { kind: 'root' }, log: logWithTwoCalls() });
    markHistoryFromLog(sessions);
    const owner = toolCallOwner(request, sessions);
    expect(owner?.id).toBe('from-log');
    expect(owner?.tool_calls.map((call) => call.id)).toEqual(['a', 'b']);
    expect(rawArgumentsOf(request, sessions)).toBe('{壞');
  });

  it('標了 log、子代理：讀子代理自己的日誌，不讀 state', () => {
    const sessions = sessionsAt({
      kind: 'ok',
      address: { kind: 'subagent', runId: 'r' },
      log: logWithTwoCalls(),
    });
    markHistoryFromLog(sessions);
    expect(toolCallOwner(request, sessions)?.id).toBe('from-log');
  });

  it('標了 log、找不到日誌：拋，不退回 state', () => {
    const sessions = sessionsAt({ kind: 'unknown-caller' } as SessionLookup);
    markHistoryFromLog(sessions);
    expect(() => toolCallOwner(request, sessions)).toThrow(
      /工具呼叫找不到這次的日誌（unknown-caller）/u,
    );
  });

  it('請求帶著 loop 交下來的那則：沒標 log 讀它，不讀 state', () => {
    expect(toolCallOwner(handedRequest)).toBe(handed);
    expect(rawArgumentsOf(handedRequest)).toBe('{交');
    const sessions = sessionsAt({
      kind: 'ok',
      address: { kind: 'subagent', runId: 'r' },
      log: logWithTwoCalls(),
    });
    expect(toolCallOwner(handedRequest, sessions)).toBe(handed);
  });

  it('標了 log、子代理：交下來的那則也不讀，讀日誌', () => {
    const sessions = sessionsAt({
      kind: 'ok',
      address: { kind: 'subagent', runId: 'r' },
      log: logWithTwoCalls(),
    });
    markHistoryFromLog(sessions);
    expect(toolCallOwner(handedRequest, sessions)?.id).toBe('from-log');
  });

  it('交下來的那則不含這個 callId：undefined，不退回 state', () => {
    expect(toolCallOwner({ ...request, toolCall: { id: 'c' }, owner: handed })).toBeUndefined();
    expect(toolCallOwner({ ...request, owner: undefined })).toBeUndefined();
  });

  it('標了 log、root：交下來的那則也不讀，讀日誌', () => {
    const sessions = sessionsAt({ kind: 'ok', address: { kind: 'root' }, log: logWithTwoCalls() });
    markHistoryFromLog(sessions);
    expect(toolCallOwner(handedRequest, sessions)?.id).toBe('from-log');
  });

  it('ownerRequestOf：一步拿到的呼叫有 owner 就照帶，沒有就不帶這個鍵', () => {
    const site = { callId: 'b', state: decoyState, configurable: {} };
    expect(toolCallOwner(ownerRequestOf({ ...site, owner: handed }))).toBe(handed);
    expect('owner' in ownerRequestOf(site)).toBe(false);
    expect(toolCallOwner(ownerRequestOf(site))?.id).toBe('from-state');
  });

  it('callId 是空的：不找', () => {
    expect(toolCallOwner({ toolCall: { id: '' }, state: decoyState })).toBeUndefined();
  });
});
