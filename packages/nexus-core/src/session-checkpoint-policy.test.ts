/**
 * 耐久檢查點（#599），直接呼叫鉤子量規則。後面接的是真的持久化協調器
 * （`attachSessionPersistence`），窗口開到上限——**這些測試裡的東西只有檢查點排空得下去**，
 * 所以 handler 裡看到的「後端已經收到」一定是檢查點做的，不是窗口剛好到期。
 *
 * 掛進真的組裝、真的 serve 之後的行為在 `apps/harness` 的 `serve-shutdown.test.ts`。
 */

import { ToolMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, expect, it } from 'vitest';
import { loadPlugins } from './load.js';
import { createSessionCheckpointMiddleware } from './session-checkpoint-policy.js';
import type { SessionEvent } from './session-log.js';
import { attachSessionPersistence, MAX_PERSISTENCE_WINDOW_MS } from './session-persistence.js';
import { SessionRegistry } from './session-registry.js';
import type { SessionStore, StoredSession } from './session-store.js';
import { TOOL_ABORTED_BEFORE_DISPATCH, toolErrorOf } from './tool-events.js';
import { TOOL_ABORTED_BEFORE_DISPATCH_TEXT, TURN_CANCEL_CONFIG_KEY } from './turn-cancel.js';

type Hook = (request: never, handler: (request: never) => Promise<unknown>) => Promise<unknown>;

/** 後端的一個把手：記下寫進來的與 flush 了幾次；`fail` 打開之後 `append` 一律拒絕。 */
interface FakeStored extends StoredSession {
  readonly written: SessionEvent[];
  flushes: number;
  fail: Error | undefined;
}

function fakeStored(): FakeStored {
  const written: SessionEvent[] = [];
  return {
    written,
    flushes: 0,
    fail: undefined,
    append(events) {
      if (this.fail !== undefined) return Promise.reject(this.fail);
      written.push(...events);
      return Promise.resolve();
    },
    flush() {
      this.flushes += 1;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}

/**
 * 一套組裝：root 日誌、接上持久化（窗口開到上限）、綁上 plugin 的 `sessions` 通道。
 *
 * @param persist - 要不要接持久化。不接就是「沒開 `--session-log`」那種組裝。
 */
async function assemble(persist = true) {
  const sessions = new SessionRegistry('root-1');
  const handles = new Map<string, FakeStored>();
  const store: SessionStore = {
    create(header) {
      const stored = fakeStored();
      handles.set(header.id, stored);
      return stored;
    },
    resume: () => Promise.reject(new Error('這裡不續接')),
  };
  if (persist) attachSessionPersistence(sessions, store, { windowMs: MAX_PERSISTENCE_WINDOW_MS });
  const { registry } = await loadPlugins([]);
  registry.sessions.bind(sessions);
  const hooks = createSessionCheckpointMiddleware(registry.sessions) as unknown as {
    wrapModelCall: Hook;
    wrapToolCall: Hook;
  };
  return { sessions, handles, hooks };
}

const ROOT_MODEL_NS = 'model_request:m1';
const SUBAGENT_MODEL_NS = 'tools:t1|model_request:m2';
const ROOT_TOOL_NS = 'tools:c1';
const SUBAGENT_TOOL_NS = 'tools:t1|tools:c2';

function modelRequest(checkpointNs: string) {
  return {
    model: new FakeListChatModel({ responses: ['好'] }),
    messages: [],
    runtime: { configurable: { checkpoint_ns: checkpointNs } },
  } as never;
}

function toolRequest(checkpointNs: string, signal?: AbortSignal) {
  return {
    toolCall: { id: 'c1', name: 'write_file', args: {} },
    runtime: {
      configurable: {
        checkpoint_ns: checkpointNs,
        ...(signal !== undefined && { [TURN_CANCEL_CONFIG_KEY]: signal }),
      },
    },
  } as never;
}

const success = () =>
  new ToolMessage({ content: '寫好了', tool_call_id: 'c1', name: 'write_file' });

describe('模型請求之前', () => {
  it('root：handler 被叫的那一刻，這一份已經寫到後端而且 flush 過', async () => {
    const { sessions, handles, hooks } = await assemble();
    sessions.root.append('turn/start', { kind: 'message', text: '把檔案讀一遍' });
    sessions.root.append('model/start', {});
    const root = handles.get('root-1')!;
    // 前提：窗口開到上限，沒有檢查點的話這時候後端一顆都沒有。
    expect(root.written).toHaveLength(0);

    let seen: { written: string[]; flushes: number } | undefined;
    await hooks.wrapModelCall(modelRequest(ROOT_MODEL_NS), async () => {
      seen = { written: root.written.map((event) => event.type), flushes: root.flushes };
      return 'reply';
    });
    expect(seen).toEqual({ written: ['turn/start', 'model/start'], flushes: 1 });
  });

  it('子代理：排空的是子代理那一份，不是 root', async () => {
    const { sessions, handles, hooks } = await assemble();
    sessions.root.append('turn/start', { kind: 'message', text: 'p' });
    sessions.open({ kind: 'subagent', runId: 'tools:t1' }).append('model/start', {});

    let seen: { root: number; child: number } | undefined;
    await hooks.wrapModelCall(modelRequest(SUBAGENT_MODEL_NS), async () => {
      seen = {
        root: handles.get('root-1')!.written.length,
        child: handles.get('root-1/tools:t1')!.written.length,
      };
      return 'reply';
    });
    expect(seen).toEqual({ root: 0, child: 1 });
  });

  it('排空被拒：模型不被叫，錯誤往外走（fail-closed）', async () => {
    const { sessions, handles, hooks } = await assemble();
    sessions.root.append('turn/start', { kind: 'message', text: 'p' });
    handles.get('root-1')!.fail = new Error('磁碟滿了');
    let called = false;
    await expect(
      hooks.wrapModelCall(modelRequest(ROOT_MODEL_NS), async () => {
        called = true;
        return 'reply';
      }),
    ).rejects.toThrow('磁碟滿了');
    expect(called).toBe(false);
  });
});

describe('頂層工具動手之前', () => {
  it('root 的工具呼叫：handler 被叫的那一刻，之前記的已經在後端', async () => {
    const { sessions, handles, hooks } = await assemble();
    sessions.root.append('turn/start', { kind: 'message', text: 'p' });
    let written: number | undefined;
    const result = await hooks.wrapToolCall(toolRequest(ROOT_TOOL_NS), async () => {
      written = handles.get('root-1')!.written.length;
      return success();
    });
    expect(written).toBe(1);
    expect((result as ToolMessage).content).toBe('寫好了');
  });

  it('子代理裡的工具呼叫不排空——同 dsh 只管 `exec.parent === undefined`', async () => {
    const { sessions, handles, hooks } = await assemble();
    const child = sessions.open({ kind: 'subagent', runId: 'tools:t1' });
    child.append('todo/write', { todos: [] });
    let written: number | undefined;
    await hooks.wrapToolCall(toolRequest(SUBAGENT_TOOL_NS), async () => {
      written = handles.get('root-1/tools:t1')!.written.length;
      return success();
    });
    expect(written).toBe(0);
  });

  it('排空的那段時間裡被中止：工具本體不跑，回「還沒動手就被中止」', async () => {
    const { sessions, hooks } = await assemble();
    const controller = new AbortController();
    // 排空途中按下停止：再登記一位排空者，它被問到的時候舉起訊號。
    sessions.onFlush(() => {
      controller.abort();
      return Promise.resolve();
    });
    let called = false;
    const result = await hooks.wrapToolCall(
      toolRequest(ROOT_TOOL_NS, controller.signal),
      async () => {
        called = true;
        return success();
      },
    );
    expect(called).toBe(false);
    expect((result as ToolMessage).content).toBe(TOOL_ABORTED_BEFORE_DISPATCH_TEXT);
    expect(toolErrorOf(result as ToolMessage)?.code).toBe(TOOL_ABORTED_BEFORE_DISPATCH);
  });

  it('排空被拒：工具本體不跑，錯誤往外走（fail-closed）', async () => {
    const { sessions, handles, hooks } = await assemble();
    sessions.root.append('turn/start', { kind: 'message', text: 'p' });
    handles.get('root-1')!.fail = new Error('磁碟滿了');
    let called = false;
    await expect(
      hooks.wrapToolCall(toolRequest(ROOT_TOOL_NS), async () => {
        called = true;
        return success();
      }),
    ).rejects.toThrow('磁碟滿了');
    expect(called).toBe(false);
  });
});

describe('沒有東西可排空的時候照常放行', () => {
  it('沒接持久化：一位排空者都沒有，模型與工具都照叫', async () => {
    const { sessions, hooks } = await assemble(false);
    sessions.root.append('turn/start', { kind: 'message', text: 'p' });
    expect(await hooks.wrapModelCall(modelRequest(ROOT_MODEL_NS), async () => 'reply')).toBe(
      'reply',
    );
    const result = await hooks.wrapToolCall(toolRequest(ROOT_TOOL_NS), async () => success());
    expect((result as ToolMessage).content).toBe('寫好了');
  });

  it('認不出這次呼叫（沒有 `checkpoint_ns`）：不排空、照叫', async () => {
    const { sessions, handles, hooks } = await assemble();
    sessions.root.append('turn/start', { kind: 'message', text: 'p' });
    const request = { model: undefined, messages: [], runtime: { configurable: {} } } as never;
    expect(await hooks.wrapModelCall(request, async () => 'reply')).toBe('reply');
    expect(handles.get('root-1')!.written).toHaveLength(0);
  });
});
