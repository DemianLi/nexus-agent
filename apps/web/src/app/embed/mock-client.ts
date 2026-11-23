/**
 * `<nexus-chat>` 的瀏覽器內模擬模式（#3175）：不接 serve，照宿主頁給的劇本推 frame。給宿主頁的前端在沒有 harness 時開發宿主頁工具的串接。
 *
 * 劇本放在 `globalThis.nexusChatMock`（形狀見 `nexus-chat.d.ts` 的 `NexusChatMock`），每送出一句話才讀一次，中途改了下一句生效。
 * 每一步是一段回覆，或叫一支宿主頁工具：預設先出核准卡（同 serve 的出廠設定），核准後元素發 `nexus-host-tool`，宿主頁交回的結果
 * 畫在工具卡上，再接劇本的下一步。不模擬模型：不看使用者說了什麼，除非宿主頁用 `reply` 自己判斷。
 *
 * @module
 */
import type {
  Event,
  HostToolDeclaration,
  InboxPayload,
  PageContext,
  UplinkResult,
  WireClient,
} from '@nexus/wire';
import { HOST_TOOL_PREFIX, INBOX } from '@nexus/wire';

/** 劇本的形狀就是 `nexus-chat.d.ts` 給宿主頁的那幾個全域型別，兩邊對不上就編不過。 */
export type MockStep = globalThis.NexusChatMockStep;
export type MockTurnInput = globalThis.NexusChatMockTurnInput;
export type NexusChatMock = globalThis.NexusChatMock;

export const MOCK_DEFAULT_REPLY =
  '（模擬模式）劇本用完了，見 docs/embed-chat.md 的〈本機模擬模式〉。';
export const MOCK_UNSUPPORTED = '模擬模式不支援';

const REJECTED = { kind: 'rejected' as const, code: 'not_supported', message: MOCK_UNSUPPORTED };
const UPLINK_REJECTED: UplinkResult = {
  type: 'error',
  id: 0,
  error: 'not_supported',
  message: MOCK_UNSUPPORTED,
};
const OK: UplinkResult = { type: 'success', id: 0, result: { accepted: true } };

interface Pending {
  readonly resolve: (response: unknown) => void;
}

/** 每個元素一個；下行、排程與待決的中斷都在這裡。 */
export function createMockClient(
  script: () => NexusChatMock | undefined = () => globalThis.nexusChatMock,
): WireClient {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const pending = new Map<string, Pending>();
  const turnIndex = new Map<string, number>();
  const cancelled = new Set<string>();
  let seq = 1;
  let ids = 0;

  function emit(threadId: string, method: string, namespace: readonly string[], data: unknown) {
    const current = seq++;
    const event = {
      type: 'event',
      seq: current,
      event_id: `mock:${current}`,
      method,
      params: { namespace, timestamp: Date.now(), data },
    } as Event;
    for (const listener of listeners.get(threadId) ?? []) listener(event);
  }

  function inbox(threadId: string, payload: InboxPayload) {
    emit(threadId, 'custom', [], { name: INBOX, payload });
  }

  function waitFor(threadId: string, interruptId: string): Promise<unknown> {
    return new Promise((resolve) => pending.set(`${threadId}\n${interruptId}`, { resolve }));
  }

  async function stepsFor(threadId: string, input: MockTurnInput): Promise<readonly MockStep[]> {
    const mock = script();
    if (mock?.reply !== undefined) return mock.reply(input);
    const index = turnIndex.get(threadId) ?? 0;
    turnIndex.set(threadId, index + 1);
    return mock?.turns?.[index] ?? [{ say: MOCK_DEFAULT_REPLY }];
  }

  function say(threadId: string, runId: string, text: string) {
    const id = `${runId}-m${++ids}`;
    emit(threadId, 'messages', [], { event: 'message-start', id: `run-${id}`, run_id: id });
    emit(threadId, 'messages', [], {
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text },
      run_id: id,
    });
    emit(threadId, 'messages', [], { event: 'message-finish', reason: 'stop', run_id: id });
  }

  function resumed(threadId: string) {
    emit(threadId, 'lifecycle', [], { event: 'running', graph_name: 'root' });
  }

  async function callTool(
    threadId: string,
    step: Extract<MockStep, { tool: string }>,
  ): Promise<void> {
    const n = ++ids;
    const callId = `mock-call-${n}`;
    const name = `${HOST_TOOL_PREFIX}${step.tool}`;
    const args = step.args ?? {};
    emit(threadId, 'tools', [], {
      event: 'tool-started',
      tool_call_id: callId,
      tool_name: name,
      input: JSON.stringify(args),
    });
    if (step.approval !== false) {
      const approvalId = `mock-approval-${n}`;
      emit(threadId, 'input.requested', [], {
        interrupt_id: approvalId,
        payload: {
          actionRequests: [{ name, args }],
          reviewConfigs: [{ actionName: name, allowedDecisions: ['approve', 'reject'] }],
        },
      });
      const response = (await waitFor(threadId, approvalId)) as {
        readonly decisions?: readonly { readonly type?: string }[];
      };
      if (cancelled.has(threadId)) return;
      resumed(threadId);
      if (response.decisions?.[0]?.type !== 'approve') {
        emit(threadId, 'tools', [], {
          event: 'tool-finished',
          tool_call_id: callId,
          failed: true,
          message: '使用者拒絕了這次呼叫',
        });
        return;
      }
    }
    const hostId = `mock-host-${n}`;
    const namespace = [`tools:${callId}`];
    emit(threadId, 'input.requested', namespace, {
      interrupt_id: hostId,
      payload: { kind: 'host_tool', name: step.tool, args },
    });
    const reply = (await waitFor(threadId, hostId)) as
      | { readonly ok: true; readonly result: unknown }
      | { readonly ok: false; readonly error: string };
    if (cancelled.has(threadId)) return;
    resumed(threadId);
    emit(
      threadId,
      'tools',
      [],
      reply.ok
        ? { event: 'tool-finished', tool_call_id: callId, message: JSON.stringify(reply.result) }
        : { event: 'tool-finished', tool_call_id: callId, failed: true, message: reply.error },
    );
  }

  async function run(threadId: string, runId: string, input: MockTurnInput): Promise<void> {
    cancelled.delete(threadId);
    emit(threadId, 'lifecycle', [], { event: 'running', graph_name: 'root' });
    try {
      for (const step of await stepsFor(threadId, input)) {
        if (cancelled.has(threadId)) return;
        if ('say' in step) say(threadId, runId, step.say);
        else await callTool(threadId, step);
      }
    } catch (error) {
      say(threadId, runId, `（模擬模式）劇本出錯：${String(error)}`);
    }
    if (cancelled.has(threadId)) return;
    emit(threadId, 'lifecycle', [], { event: 'completed', graph_name: 'root' });
  }

  const label = (context: PageContext | undefined) => context?.label;
  const names = (tools: readonly HostToolDeclaration[] | undefined) =>
    (tools ?? []).map((tool) => tool.name);

  return {
    openEvents: async (threadId) => {
      const queue: Event[] = [];
      let wake: (() => void) | undefined;
      const listener = (event: Event) => {
        queue.push(event);
        wake?.();
      };
      const set = listeners.get(threadId) ?? new Set();
      set.add(listener);
      listeners.set(threadId, set);
      return (async function* stream() {
        try {
          for (;;) {
            while (queue.length > 0) yield queue.shift()!;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        } finally {
          set.delete(listener);
        }
      })();
    },
    runStart: async (threadId, text, options) => {
      const runId = `mock-run-${++ids}`;
      const item = { id: runId, text, source: { kind: 'user' as const } };
      inbox(threadId, { items: [item], nextStep: [] });
      inbox(threadId, { items: [], nextStep: [], claimed: { id: runId, text } });
      void run(threadId, runId, {
        text,
        context: label(options?.context),
        hostTools: names(options?.hostTools),
      });
      return { type: 'success', id: 0, result: { run_id: runId } };
    },
    inputRespond: async (threadId, params) => {
      const key = `${threadId}\n${params.interrupt_id}`;
      const waiting = pending.get(key);
      if (waiting === undefined) {
        return { type: 'error', id: 0, error: 'no_such_interrupt', message: '那顆中斷已經不在了' };
      }
      pending.delete(key);
      waiting.resolve(params.response);
      return OK;
    },
    runCancel: async (threadId) => {
      cancelled.add(threadId);
      for (const [key, waiting] of pending) {
        if (!key.startsWith(`${threadId}\n`)) continue;
        pending.delete(key);
        waiting.resolve({});
      }
      emit(threadId, 'lifecycle', [], { event: 'completed', graph_name: 'root', aborted: true });
      return OK;
    },
    threadHistory: async () => ({
      kind: 'ok',
      result: { events: [], firstSeq: 0, throughSeq: -1, hasMore: false, legacy: false },
    }),
    slashList: async () => ({ kind: 'ok', commands: [] }),
    openThreadFeed: () => new Promise<never>(() => undefined),
    searchThreads: () => new Promise<never>(() => undefined),
    listThreads: async () => REJECTED,
    slashRun: async () => ({ kind: 'unknown' }),
    queueUpdate: async () => UPLINK_REJECTED,
    subagentSend: async () => UPLINK_REJECTED,
    subagentInterrupt: async () => UPLINK_REJECTED,
    subagentHistory: async () => REJECTED,
    trajectoryTurn: async () => REJECTED,
    feedbackPut: async () => REJECTED,
    feedbackDelete: async () => REJECTED,
    feedbackList: async () => REJECTED,
    feedbackRecord: async () => REJECTED,
    fileReferences: async () => REJECTED,
    sessionReferences: async () => REJECTED,
    modelCatalog: async () => REJECTED,
    selectModel: async () => REJECTED,
    permissionCatalog: async () => REJECTED,
    uploadFile: async () => REJECTED,
    readAttachment: async () => REJECTED,
    threadPin: async () => REJECTED,
    threadUnpin: async () => REJECTED,
    threadArchive: async () => REJECTED,
    threadUnarchive: async () => REJECTED,
    threadRename: async () => REJECTED,
    subagentList: async () => REJECTED,
    goalPause: async () => REJECTED,
    threadFork: async () => REJECTED,
    threadDelete: async () => REJECTED,
    threadRestore: async () => REJECTED,
    deletedThreads: async () => REJECTED,
    skillList: async () => REJECTED,
  };
}
