import { describe, expect, it } from 'vitest';
import type { ConversationState, Event } from './index.js';
import {
  answerResponse,
  appendAnswers,
  appendDecision,
  appendQuestionCancel,
  cancelResponse,
  emptyConversation,
  isApprovalPending,
  isBackgroundSubagentMeta,
  prependEntries,
  reduceAll,
  reduceConversation,
  UNFINISHED_TOOL_CODE,
  UNFINISHED_TOOL_TEXT,
  uniformDecisions,
} from './conversation.js';
import type { ConversationEntry, PendingApproval } from './conversation.js';
import { COMPACTION } from './compaction.js';
import { DELIVERABLES_PRESENTED } from './deliverables.js';
import { AGENT_MESSAGE, INBOX, SETTLE_NOTICE } from './inbox.js';
import { WORKSPACE_CHANGES } from './workspace-changes.js';

/**
 * 取第 n 顆，並斷言它是核准請求。
 *
 * **窄化寫成會拋的斷言而不是 `?.`**：`pendings` 現在裝得下兩種中斷，而「拿到的是問答那
 * 一顆」與「一顆都沒有」在 `?.` 之下都變成 `undefined`——那會讓一條測錯東西的測試綠著。
 */
function approvalAt(state: ConversationState, index: number): PendingApproval {
  const pending = state.pendings[index];
  if (pending === undefined || !isApprovalPending(pending)) {
    throw new Error(`pendings[${index}] 不是核准請求：${JSON.stringify(pending)}`);
  }
  return pending;
}

/**
 * 折疊器自己那幾個口子。
 *
 * **對著真的線的驗證在 `@nexus/harness` 的 `conversation-wire.test.ts`**——那邊拿真的
 * agent 跑過真的 pump 再折進來，跟 `invoke` 對照。這裡只驗那條路徑製造不出來的幾種
 * 情況：重連之後才接上、重複與亂序的 frame、以及使用者自己那句話。
 */

let seq = 0;

function frame(method: string, namespace: readonly string[], data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `t:${current}`,
    method,
    params: { namespace, timestamp: 0, data },
  } as Event;
}

function text(id: string, namespace: readonly string[], body: string): Event[] {
  return [
    frame('messages', namespace, { event: 'message-start', id: `run-${id}`, run_id: id }),
    ...[...body].map((character) =>
      frame('messages', namespace, {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: character },
        run_id: id,
      }),
    ),
    frame('messages', namespace, { event: 'message-finish', reason: 'stop', run_id: id }),
  ];
}

function aiEntries(state: ConversationState) {
  return state.entries
    .filter((entry) => entry.kind === 'ai')
    .map((entry) =>
      entry.kind === 'ai' ? { text: entry.text, attribution: entry.attribution } : null,
    );
}

describe('折疊器', () => {
  it('重連之後接上的巢狀訊息標成未歸屬——鑰匙已經過去了', () => {
    seq = 0;
    // 這條線沒有重播也沒有歷史重抓（決策 6），所以 `task` 那顆 tools frame 收不到了。
    const state = reduceAll(
      emptyConversation(),
      text('sub', ['tools:abc', 'model_request:x'], '半路接上'),
    );
    expect(aiEntries(state)).toEqual([
      {
        text: '半路接上',
        attribution: { kind: 'unattributed', namespace: ['tools:abc', 'model_request:x'] },
      },
    ]);
  });

  it('同一顆 frame 折兩次不會變成兩則', () => {
    seq = 0;
    const frames = text('one', ['model_request:x'], '嗨');
    const once = reduceAll(emptyConversation(), frames);
    const twice = reduceAll(once, frames);
    expect(aiEntries(twice)).toEqual(aiEntries(once));
    expect(twice.entries.length).toBe(1);
  });

  it('同一則回覆的第二個開頭不再長一格（#953：歷史已有它、下行又補送一次）', () => {
    seq = 0;
    // 歷史那一側：`run_id` 是 `history-<seq>`、`id` 是日誌記的訊息 id；補送那一側：`run_id` 是即時的 uuid、`id` 同上。
    const history: Event[] = [
      frame('messages', [], {
        event: 'message-start',
        role: 'ai',
        run_id: 'history-7',
        id: 'run-X',
      }),
      frame('messages', [], {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: '講完了' },
        run_id: 'history-7',
      }),
      frame('messages', [], { event: 'message-finish', reason: 'stop', run_id: 'history-7' }),
    ];
    const replayed = text('X', [], '講完了');
    const state = reduceAll(reduceAll(emptyConversation(), history), replayed);
    expect(aiEntries(state)).toEqual([{ text: '講完了', attribution: { kind: 'root' } }]);
  });

  it('不同訊息 id 的兩則照常各長一格', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [...text('a', [], '一'), ...text('b', [], '二')]);
    expect(aiEntries(state).map((entry) => entry?.text)).toEqual(['一', '二']);
  });

  it('seq 退回去的 frame 一律丟掉', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), text('one', ['model_request:x'], '嗨'));
    const stale = frame('messages', ['model_request:x'], {
      event: 'content-block-delta',
      delta: { type: 'text-delta', text: '不該出現' },
      run_id: 'one',
    });
    const replayed = reduceConversation(state, { ...stale, seq: 0 } as Event);
    expect(aiEntries(replayed)).toEqual(aiEntries(state));
  });

  it('推理（#527）：只收 `reasoning-delta`，推理簽章與工具參數的 `block-delta` 都不進來', () => {
    seq = 0;
    const delta = (value: Record<string, unknown>) =>
      frame('messages', [], {
        event: 'content-block-delta',
        index: 1,
        delta: value,
        run_id: 'r',
      });
    const state = reduceAll(emptyConversation(), [
      frame('messages', [], { event: 'message-start', id: 'run-r', run_id: 'r' }),
      delta({ type: 'reasoning-delta', reasoning: '我在' }),
      // 形狀照 `@langchain/core` 在線上實際送的（#527 量過）：簽章與工具參數都走 `block-delta`。
      delta({ type: 'block-delta', fields: { type: 'reasoning', signature: '簽章' } }),
      delta({ type: 'block-delta', fields: { type: 'tool_call_chunk', args: '{"a"' } }),
      delta({ type: 'reasoning-delta', reasoning: '想' }),
      frame('messages', [], {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: '答案' },
        run_id: 'r',
      }),
      frame('messages', [], { event: 'message-finish', reason: 'stop', run_id: 'r' }),
    ]);
    expect(state.entries).toMatchObject([{ kind: 'ai', text: '答案', reasoning: '我在想' }]);
    // 沒有推理的那則不帶這一格，不是空字串：畫面據「有沒有」決定畫不畫摺疊區塊。**這一句才守得住
    // 「正面比對」**：簽章與工具參數都沒有 `reasoning` 欄位，放寬成「不是 text 就收」的話上面那則照樣是
    // 「我在想」，只有這一則會多長出一格空字串。
    // 逐顆照順序建：`frame` 建的當下就編 `seq`，插隊的那幾顆會讓後面的被當成退回去的丟掉。
    const plain = reduceAll(emptyConversation(), [
      frame('messages', [], { event: 'message-start', id: 'run-p', run_id: 'p' }),
      frame('messages', [], {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: '嗨' },
        run_id: 'p',
      }),
      frame('messages', [], {
        event: 'content-block-delta',
        index: 1,
        delta: { type: 'block-delta', fields: { type: 'tool_call_chunk', args: '{}' } },
        run_id: 'p',
      }),
      frame('messages', [], {
        event: 'content-block-delta',
        index: 2,
        delta: { type: 'block-delta', fields: { type: 'reasoning', signature: '簽章' } },
        run_id: 'p',
      }),
      frame('messages', [], { event: 'message-finish', reason: 'stop', run_id: 'p' }),
    ]);
    expect(plain.entries).toMatchObject([{ kind: 'ai', text: '嗨' }]);
    expect(plain.entries[0]).not.toHaveProperty('reasoning');
  });

  it('工具的參數原樣留著，不在這一層猜它的形狀', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      frame('tools', ['tools:a'], {
        event: 'tool-started',
        tool_call_id: 'call_1_0',
        tool_name: 'take_note',
        input: '{"text":"甲"}',
      }),
      frame('tools', ['tools:a'], {
        event: 'tool-error',
        tool_call_id: 'call_1_0',
        message: '工具自己炸了',
      }),
    ]);
    expect(state.entries).toEqual([
      {
        kind: 'tool',
        id: 'tool-call_1_0',
        callId: 'call_1_0',
        name: 'take_note',
        input: '{"text":"甲"}',
        status: 'failed',
        error: '工具自己炸了',
        attribution: { kind: 'root' },
      },
    ]);
  });

  it('`tool-suspended` 是「等人」那一格，而且不留錯誤字', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      frame('tools', ['tools:a'], {
        event: 'tool-started',
        tool_call_id: 'call_1_0',
        tool_name: 'ask_user_question',
        input: '{}',
      }),
      frame('tools', ['tools:a'], { event: 'tool-suspended', tool_call_id: 'call_1_0' }),
    ]);
    const entry = state.entries[0];
    if (entry?.kind !== 'tool') throw new Error('沒有工具條目');
    expect(entry.status).toBe('suspended');
    expect(entry.error).toBeUndefined();
  });

  it('**第二顆 `tool-started` 是同一次呼叫的續行**，不長第二個條目', () => {
    seq = 0;
    const started = {
      event: 'tool-started',
      tool_call_id: 'call_1_0',
      tool_name: 'ask_user_question',
      input: '{}',
    };
    const state = reduceAll(emptyConversation(), [
      frame('tools', ['tools:a'], started),
      frame('tools', ['tools:a'], { event: 'tool-suspended', tool_call_id: 'call_1_0' }),
      // 人回答之後圖從 tools 節點重跑，基座再發一顆一模一樣的 `tool-started`（實測）。
      frame('tools', ['tools:a'], started),
    ]);
    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0];
    if (entry?.kind !== 'tool') throw new Error('沒有工具條目');
    // 續行回到執行中，而且中斷那段留下的東西要清乾淨。
    expect(entry.status).toBe('running');
    expect(entry.error).toBeUndefined();
  });

  it('`tool-finished` 的 meta 原樣進條目；同一個 id 再開一次時跟 `text` 一起清掉，失敗的不留（#617）', () => {
    seq = 0;
    const meta = { shape: 'paths', paths: ['/a.md'], truncated: false, total: 1 };
    const started = {
      event: 'tool-started',
      tool_call_id: 'call_1_0',
      tool_name: 'glob',
      input: '{}',
    };
    // frame 照送達順序建：`seq` 在建的時候發，倒著建的那顆會被當成舊幀丟掉。
    const done = reduceAll(emptyConversation(), [
      frame('tools', ['tools:a'], started),
      frame('tools', ['tools:a'], {
        event: 'tool-finished',
        tool_call_id: 'call_1_0',
        message: '/a.md',
        meta,
      }),
    ]);
    const entry = done.entries[0];
    if (entry?.kind !== 'tool') throw new Error('沒有工具條目');
    expect(entry.meta).toEqual(meta);

    const restarted = reduceAll(done, [frame('tools', ['tools:a'], started)]);
    const again = restarted.entries[0];
    if (again?.kind !== 'tool') throw new Error('沒有工具條目');
    expect(again.status).toBe('running');
    expect(again.text).toBeUndefined();
    expect(again.meta).toBeUndefined();

    // 同一個 id 的更正幀把它改判成失敗：meta 跟著拿掉，不留成功那一顆的。
    const failed = reduceAll(done, [
      frame('tools', ['tools:a'], {
        event: 'tool-finished',
        tool_call_id: 'call_1_0',
        failed: true,
        message: '被擋下',
        meta,
      }),
    ]);
    const last = failed.entries[0];
    if (last?.kind !== 'tool') throw new Error('沒有工具條目');
    expect(last.status).toBe('failed');
    expect(last.meta).toBeUndefined();
  });

  it('**收尾了不等於成功了**：帶 `failed` 的 `tool-finished` 是失敗不是完成', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      frame('tools', ['tools:a'], {
        event: 'tool-started',
        tool_call_id: 'call_1_0',
        tool_name: 'ask_user_question',
        input: '{}',
      }),
      frame('tools', ['tools:a'], {
        event: 'tool-finished',
        tool_call_id: 'call_1_0',
        failed: true,
        message: '人放棄了這一組問題',
        output: { kwargs: { status: 'error' } },
      }),
    ]);
    const entry = state.entries[0];
    if (entry?.kind !== 'tool') throw new Error('沒有工具條目');
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('人放棄了這一組問題');
  });

  it('**沒有 `failed` 的照舊是完成**——不是把每一格都畫成失敗', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      frame('tools', ['tools:a'], {
        event: 'tool-started',
        tool_call_id: 'call_1_0',
        tool_name: 'take_note',
        input: '{}',
      }),
      frame('tools', ['tools:a'], {
        event: 'tool-finished',
        tool_call_id: 'call_1_0',
        output: '寫好了',
      }),
    ]);
    const entry = state.entries[0];
    if (entry?.kind !== 'tool') throw new Error('沒有工具條目');
    expect(entry.status).toBe('done');
    expect(entry.error).toBeUndefined();
  });

  it('task 的參數不是合法 JSON 時歸屬不出來，但不會炸', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      frame('tools', ['tools:a'], {
        event: 'tool-started',
        tool_call_id: 'call_1_0',
        tool_name: 'task',
        input: '{壞掉的',
      }),
      ...text('sub', ['tools:a', 'model_request:x'], '子代理說話'),
    ]);
    expect(aiEntries(state)).toEqual([
      {
        text: '子代理說話',
        attribution: { kind: 'unattributed', namespace: ['tools:a', 'model_request:x'] },
      },
    ]);
  });
});

/** 一顆核准請求的 frame。`configs` 省略即每一筆都是完整詞彙。 */
function inputRequested(
  actions: readonly string[],
  configs?: readonly (readonly string[])[],
  interruptId = 'int-1',
): Event {
  return frame('input.requested', ['tools:a'], {
    interrupt_id: interruptId,
    payload: {
      actionRequests: actions.map((name) => ({ name, args: { n: name } })),
      reviewConfigs: actions.map((name, index) => ({
        actionName: name,
        allowedDecisions: [...(configs?.[index] ?? ['approve', 'reject'])],
      })),
    },
  });
}

/** 一顆問答請求的 frame。 */
function questionRequested(interruptId = 'q-1'): Event {
  return frame('input.requested', ['tools:a'], {
    interrupt_id: interruptId,
    payload: {
      kind: 'question',
      questions: [
        { id: 'name', question: '訪客姓名？', header: '姓名' },
        {
          id: 'day',
          question: '哪一天？',
          options: [{ label: '週一' }, { label: '週二' }],
          multiSelect: true,
        },
      ],
    },
  });
}

describe('按了停止（#276）', () => {
  it('root 收尾那顆帶 aborted：狀態是已停止不是失敗，還在吐字的那則標成被打斷', () => {
    const state = reduceAll(emptyConversation(), [
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      frame('messages', ['model_request:1'], { event: 'message-start', id: 'run-a', run_id: 'a' }),
      frame('messages', ['model_request:1'], {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: '甲乙' },
        run_id: 'a',
      }),
      // 被切斷的那一次基座發的是 `failed`；pump 補上 `aborted`。
      frame('lifecycle', [], {
        event: 'failed',
        graph_name: 'root',
        error: '這一輪被中止了',
        aborted: true,
      }),
    ]);
    expect(state.status).toBe('stopped');
    expect(state.error).toBeUndefined();
    expect(state.entries).toMatchObject([
      { kind: 'ai', text: '甲乙', streaming: false, stopped: true },
    ]);
  });

  it('講完的那則不標：被打斷的只有那一刻還在吐字的', () => {
    const state = reduceAll(emptyConversation(), [
      frame('messages', ['model_request:1'], { event: 'message-start', id: 'run-a', run_id: 'a' }),
      frame('messages', ['model_request:1'], { event: 'message-finish', run_id: 'a' }),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root', aborted: true }),
    ]);
    expect(state.status).toBe('stopped');
    expect(state.entries[0]).not.toHaveProperty('stopped');
  });

  it('停在核准點時收回：合成的那顆收尾把卡片一起收掉', () => {
    const state = reduceAll(emptyConversation(), [
      frame('input.requested', [], {
        interrupt_id: 'i1',
        payload: {
          actionRequests: [{ name: 'danger', args: {} }],
          reviewConfigs: [{ actionName: 'danger', allowedDecisions: ['approve', 'reject'] }],
        },
      }),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root', aborted: true }),
    ]);
    expect(state.status).toBe('stopped');
    expect(state.pendings).toEqual([]);
  });

  it('對照：沒帶 aborted 的 failed 照舊是失敗', () => {
    const state = reduceAll(emptyConversation(), [
      frame('lifecycle', [], { event: 'failed', graph_name: 'root', error: '供應商掛了' }),
    ]);
    expect(state.status).toBe('failed');
    expect(state.error).toBe('供應商掛了');
  });
});

/**
 * 還沒有結果的卡收成失敗時也補碼（[#667](https://github.com/DemianLi/nexus-agent/issues/667)）：照 dsh 合成的
 * `{ code: 'interrupted' }`（`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:217`），停止、失敗、收尾三條
 * 路都補——dsh 也不分關閉的原因。所以每一列多比一格碼。
 */
describe('一輪收掉時還沒有結果的工具卡（#297，照 dsh 的 `Interrupted`）', () => {
  const open = (id: string, namespace: string[] = ['tools:a']) =>
    frame('tools', namespace, {
      event: 'tool-started',
      tool_call_id: id,
      tool_name: id,
      input: '{}',
    });
  const cards = (state: ReturnType<typeof emptyConversation>) =>
    state.entries.flatMap((entry) =>
      entry.kind === 'tool' ? [[entry.callId, entry.status, entry.error, entry.errorCode]] : [],
    );

  it('碼的值照 dsh', () => {
    expect(UNFINISHED_TOOL_CODE).toBe('interrupted');
  });

  it('停止：執行中與掛著的收成失敗，已經有結果的不動', () => {
    const state = reduceAll(emptyConversation(), [
      open('running'),
      open('suspended'),
      frame('tools', ['tools:a'], { event: 'tool-suspended', tool_call_id: 'suspended' }),
      open('done'),
      frame('tools', ['tools:a'], { event: 'tool-finished', tool_call_id: 'done', output: 'ok' }),
      open('failed'),
      frame('tools', ['tools:a'], {
        event: 'tool-finished',
        tool_call_id: 'failed',
        failed: true,
        message: '被擋下',
      }),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root', aborted: true }),
    ]);
    expect(cards(state)).toEqual([
      ['running', 'failed', UNFINISHED_TOOL_TEXT, UNFINISHED_TOOL_CODE],
      ['suspended', 'failed', UNFINISHED_TOOL_TEXT, UNFINISHED_TOOL_CODE],
      ['done', 'done', undefined, undefined],
      ['failed', 'failed', '被擋下', undefined],
    ]);
  });

  it('失敗也收：這一輪關了，不會再有結果', () => {
    const state = reduceAll(emptyConversation(), [
      open('running'),
      frame('lifecycle', [], { event: 'failed', graph_name: 'root', error: '供應商掛了' }),
    ]);
    expect(cards(state)).toEqual([
      ['running', 'failed', UNFINISHED_TOOL_TEXT, UNFINISHED_TOOL_CODE],
    ]);
  });

  it('正常收尾也收：dsh 不分關閉的原因，一輪關了還沒結果就是沒有結果', () => {
    const state = reduceAll(emptyConversation(), [
      open('running'),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    expect(state.status).toBe('idle');
    expect(cards(state)).toEqual([
      ['running', 'failed', UNFINISHED_TOOL_TEXT, UNFINISHED_TOOL_CODE],
    ]);
  });

  it('對照：停在核准點那顆 `completed` 不收——那一輪還沒關，卡還在等人', () => {
    const state = reduceAll(emptyConversation(), [
      open('running', []),
      frame('input.requested', [], {
        interrupt_id: 'i1',
        payload: {
          actionRequests: [{ name: 'running', args: {} }],
          reviewConfigs: [{ actionName: 'running', allowedDecisions: ['approve', 'reject'] }],
        },
      }),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    expect(state.status).toBe('awaiting-input');
    expect(cards(state)).toEqual([['running', 'running', undefined, undefined]]);
  });

  it('子代理那一層的收尾不算：只有 root 那顆在講「這一輪」', () => {
    const state = reduceAll(emptyConversation(), [
      open('running'),
      frame('lifecycle', ['tools:a'], { event: 'failed', graph_name: 'worker', aborted: true }),
    ]);
    expect(cards(state)).toEqual([['running', 'running', undefined, undefined]]);
  });
});

describe('判別式', () => {
  it('`kind` 缺席時當核准——五個既有測試檔用的 `interruptOn` payload 沒有這個欄位', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [inputRequested(['alpha'])]);
    expect(approvalAt(state, 0).actions.map((action) => action.name)).toEqual(['alpha']);
  });

  it('`kind: "question"` 折成問答，欄位一格不掉', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [questionRequested()]);
    const pending = state.pendings[0];
    expect(pending).toEqual({
      kind: 'question',
      interruptId: 'q-1',
      namespace: ['tools:a'],
      questions: [
        { id: 'name', question: '訪客姓名？', header: '姓名' },
        {
          id: 'day',
          question: '哪一天？',
          options: [{ label: '週一' }, { label: '週二' }],
          multiSelect: true,
        },
      ],
    });
    expect(state.status).toBe('awaiting-input');
  });

  it('計劃審核那一題（#652）：`detail` 與 `intent` 原樣帶到卡上', () => {
    seq = 0;
    const review = {
      id: 'plan-review',
      header: '計劃審核',
      question: '同意這份計劃並離開計劃模式？',
      detail: '# 計劃\n\n先看再改。',
      options: [{ label: '同意' }, { label: '繼續規劃' }],
      intent: { kind: 'plan-review', approve: '同意', callId: 'call-1' },
    } as const;
    const state = reduceAll(emptyConversation(), [
      frame('input.requested', ['tools:call-1'], {
        interrupt_id: 'q-plan',
        payload: { kind: 'question', questions: [review] },
      }),
    ]);
    expect(state.pendings).toEqual([
      { kind: 'question', interruptId: 'q-plan', namespace: ['tools:call-1'], questions: [review] },
    ]);
  });

  it('**認不得的 `kind` 明著壞掉，不會靜靜變成一張核准卡**', () => {
    // 這是這一刀最容易寫錯的地方：寫成 `kind === 'question' ? 問答 : 核准` 的兩支三元式，
    // 第三種中斷會長出 `approve`／`reject` 兩顆按鈕，而對面等的是別的東西。**誤放行不會
    // 有人來報錯**——所以這條測的不是「有沒有擋」，是「壞掉的樣子看得見」。
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      frame('input.requested', ['tools:a'], {
        interrupt_id: 'x-1',
        payload: { kind: 'elicitation', schema: {} },
      }),
    ]);
    expect(state.status).toBe('failed');
    expect(state.error).toContain('"elicitation"');
    // 而且**沒有**掛出一張卡——狀態壞了卻還畫得出按鈕才是最糟的組合。
    expect(state.pendings).toEqual([]);
  });
});

describe('問答的回答', () => {
  it('答完就收掉，那一則是它存在過的唯一紀錄；空的 `selected` 原樣留著（跳過）', () => {
    seq = 0;
    const asked = reduceAll(emptyConversation(), [questionRequested()]);
    const answered = appendAnswers(asked, 'q-1', [
      { id: 'name', selected: [], custom: '阿明' },
      { id: 'day', selected: [] },
    ]);
    expect(answered.pendings).toEqual([]);
    expect(answered.status).toBe('running');
    expect(answered.entries).toEqual([
      {
        kind: 'answer',
        id: 'answer-q-1',
        answers: [
          { id: 'name', selected: [], custom: '阿明' },
          { id: 'day', selected: [] },
        ],
      },
    ]);
    expect(
      answerResponse(answered.entries[0]?.kind === 'answer' ? answered.entries[0].answers : []),
    ).toEqual({
      answers: [
        { id: 'name', selected: [], custom: '阿明' },
        { id: 'day', selected: [] },
      ],
    });
  });

  it('**放棄整組留下的紀錄跟「每題都跳過」不一樣**——模型那頭是錯誤，不是一份答案', () => {
    seq = 0;
    const asked = reduceAll(emptyConversation(), [questionRequested()]);
    const cancelled = appendQuestionCancel(asked, 'q-1');
    expect(cancelled.entries).toEqual([
      { kind: 'answer', id: 'answer-q-1', answers: [], cancelled: true },
    ]);
    expect(cancelResponse()).toEqual({ cancelled: true });
  });

  it('兩條路都認人：核准那顆不收答案，問答那顆不收決定', () => {
    seq = 0;
    const both = reduceAll(emptyConversation(), [
      inputRequested(['alpha'], undefined, 'int-1'),
      questionRequested('q-1'),
    ]);
    // 送錯形狀時**原樣回傳**，不是「就近找一顆來套」——套上去的樣子是人按了核准、
    // 答案卻寫進了問答那一顆。
    expect(appendAnswers(both, 'int-1', [{ id: 'name', selected: ['x'] }])).toEqual(both);
    expect(appendDecision(both, 'q-1', 'approve')).toEqual(both);
    // 而且答對的那一顆只收掉自己，另一顆還掛著。
    const afterAnswer = appendAnswers(both, 'q-1', [{ id: 'name', selected: ['x'] }]);
    expect(afterAnswer.pendings.map((pending) => pending.interruptId)).toEqual(['int-1']);
    expect(afterAnswer.status).toBe('awaiting-input');
  });
});

describe('核准請求', () => {
  it('允許的決定取逐筆交集——不是第一筆，也不是聯集', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      inputRequested(['alpha', 'beta'], [['approve', 'reject'], ['approve']]),
    ]);
    // 讀 `[0]` 會多出一顆「全部拒絕」，而基座對不在那一筆清單裡的決定是當場拋
    // ——按下去是整場 run 死。實測基座真的會讓逐筆詞彙分歧。
    expect(approvalAt(state, 0).allowedDecisions).toEqual(['approve']);
    expect(state.status).toBe('awaiting-input');
  });

  it('namespace 留著——下行只發這一次，丟了就接不回去', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [inputRequested(['alpha'])]);
    expect(state.pendings[0]?.namespace).toEqual(['tools:a']);
    expect(state.pendings[0]?.interruptId).toBe('int-1');
  });

  it('一個決定攤成整批同型，因為長度不符會殺掉整場 run', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [inputRequested(['alpha', 'beta'])]);
    expect(uniformDecisions(approvalAt(state, 0), 'reject')).toEqual({
      decisions: [{ type: 'reject' }, { type: 'reject' }],
    });
  });

  it('按下去之後請求就收掉，而且那一則是它存在過的唯一紀錄', () => {
    seq = 0;
    const asked = reduceAll(emptyConversation(), [inputRequested(['alpha', 'beta'])]);
    const decided = appendDecision(asked, 'int-1', 'reject');

    expect(decided.pendings).toEqual([]);
    expect(decided.status).toBe('running');
    expect(decided.entries).toEqual([
      { kind: 'decision', id: 'decision-int-1', decision: 'reject', actions: ['alpha', 'beta'] },
    ]);
    // 沒有掛著的請求時再按一次不該憑空長出第二則。
    expect(appendDecision(decided, 'int-1', 'reject')).toEqual(decided);
  });

  it('**同一輪兩顆中斷並存**——第二顆不再蓋掉第一顆', () => {
    // 閘門是逐次呼叫各自 `interrupt()` 的，所以同一輪兩個 gated 工具 = 線上兩顆
    // `input.requested`（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
    // 這裡曾經是單一插槽，第二顆進來第一顆就不見了——畫面少一張卡。
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      inputRequested(['alpha'], undefined, 'int-1'),
      inputRequested(['beta'], undefined, 'int-2'),
    ]);
    expect(state.pendings.map((pending) => pending.interruptId)).toEqual(['int-1', 'int-2']);
    expect(
      state.pendings.flatMap((pending) =>
        isApprovalPending(pending) ? pending.actions.map((action) => action.name) : [],
      ),
    ).toEqual(['alpha', 'beta']);
  });

  it('**同一顆 id 再來一次是覆寫不是追加**——沒答到的那顆會帶著原本的 id 再度中斷', () => {
    // 答掉其中一顆之後，剩下的那顆會在新的 run 裡**帶著原本那顆 id** 再度發一次
    // `input.requested`（實測）。追加的話同一顆中斷會長出第二張卡，而其中一張
    // 永遠回答不了。
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      inputRequested(['alpha'], undefined, 'int-1'),
      inputRequested(['alpha'], undefined, 'int-1'),
    ]);
    expect(state.pendings).toHaveLength(1);
  });

  it('**答掉一顆只收掉那一顆**，剩下的還掛著，狀態不回 running', () => {
    seq = 0;
    const asked = reduceAll(emptyConversation(), [
      inputRequested(['alpha'], undefined, 'int-1'),
      inputRequested(['beta'], undefined, 'int-2'),
    ]);
    const decided = appendDecision(asked, 'int-1', 'approve');

    expect(decided.pendings.map((pending) => pending.interruptId)).toEqual(['int-2']);
    // **狀態不能回 running**：回了的話畫面看起來像跑起來了，而第二張卡還在等人。
    expect(decided.status).toBe('awaiting-input');
    expect(decided.entries).toEqual([
      { kind: 'decision', id: 'decision-int-1', decision: 'approve', actions: ['alpha'] },
    ]);

    const both = appendDecision(decided, 'int-2', 'approve');
    expect(both.pendings).toEqual([]);
    expect(both.status).toBe('running');
  });

  it('別人按掉的時候，沒按的那一端靠 lifecycle running 收掉卡片', () => {
    seq = 0;
    const asked = reduceAll(emptyConversation(), [inputRequested(['alpha'])]);
    expect(asked.pendings).toHaveLength(1);

    const resumed = reduceConversation(
      asked,
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    );
    expect(resumed.pendings).toEqual([]);
    expect(resumed.status).toBe('running');
  });

  it('中斷那一輪的 completed 不會把狀態翻回就緒', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      inputRequested(['alpha']),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
    ]);
    expect(state.status).toBe('awaiting-input');
    expect(state.pendings).toHaveLength(1);
  });
});

/**
 * 撞到輸出上限（#433）：pump 在 root 收尾的 `completed` 上補 `maxTokens`，折疊器標在**這一輪最後一則
 * root 回覆**上。子代理的、上一輪的都不標。
 */
describe('撞到輸出上限', () => {
  function twoTurns(closing: Record<string, unknown>) {
    return reduceAll(emptyConversation(), [
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ...text('a', ['model_request:1'], '第一輪'),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      ...text('b', ['model_request:2'], '寫到'),
      ...text('c', ['tools:t', 'model_request:3'], '子代理'),
      frame('lifecycle', [], { event: 'completed', graph_name: 'root', ...closing }),
    ]);
  }

  function marks(state: ConversationState) {
    return state.entries.flatMap((entry) =>
      entry.kind === 'ai' ? [[entry.text, entry.maxTokens ?? false]] : [],
    );
  }

  it('標在這一輪最後一則 root 回覆上；狀態照常回到 idle', () => {
    const state = twoTurns({ maxTokens: true });
    expect(state.status).toBe('idle');
    expect(marks(state)).toEqual([
      ['第一輪', false],
      ['寫到', true],
      ['子代理', false],
    ]);
  });

  it('對照：沒帶 maxTokens 一則都不標', () => {
    expect(marks(twoTurns({}))).toEqual([
      ['第一輪', false],
      ['寫到', false],
      ['子代理', false],
    ]);
  });
});

describe('背景子代理的歸屬（#832）', () => {
  const key = { kind: 'background-subagent', runId: 'bg-abc123def456', subagentType: 'worker' };
  const dispatch = (callId: string) =>
    frame('tools', [], {
      event: 'tool-started',
      tool_call_id: callId,
      tool_name: 'subagent',
      input: JSON.stringify({ description: '幹活', subagent_type: 'worker' }),
    });
  const settle = (callId: string, meta?: unknown) =>
    frame('tools', [], {
      event: 'tool-finished',
      tool_call_id: callId,
      message: '子代理已在背景啟動',
      ...(meta === undefined ? {} : { meta }),
    });
  const innerStarted = (callId: string) =>
    frame('tools', ['bg-abc123def456', 'tools'], {
      event: 'tool-started',
      tool_call_id: callId,
      tool_name: 'look',
      input: '{}',
    });
  const innerFinished = (callId: string) =>
    frame('tools', ['bg-abc123def456', 'tools'], {
      event: 'tool-finished',
      tool_call_id: callId,
      message: '看過了',
    });

  const attributionOf = (state: ConversationState, callId: string) => {
    const entry = state.entries.find((candidate) => candidate.id === `tool-${callId}`);
    if (entry?.kind !== 'tool') throw new Error(`沒有 ${callId} 這顆工具`);
    return entry.attribution;
  };

  it('派出去的呼叫先收尾：背景那一輪之後的卡直接歸給那個子代理', () => {
    const state = reduceAll(emptyConversation(), [
      dispatch('root-1'),
      settle('root-1', key),
      innerStarted('bg-1'),
      innerFinished('bg-1'),
    ]);
    expect(attributionOf(state, 'bg-1')).toEqual({
      kind: 'subagent',
      name: 'worker',
      callId: 'root-1',
    });
    expect(state.subagents['bg-abc123def456']).toEqual({ name: 'worker', callId: 'root-1' });
  });

  it('背景的卡先到：先是未歸屬，鑰匙一到就追溯過去（不取決於誰先到）', () => {
    const early = reduceAll(emptyConversation(), [dispatch('root-1'), innerStarted('bg-1')]);
    expect(attributionOf(early, 'bg-1').kind).toBe('unattributed');
    const settled = reduceAll(early, [innerFinished('bg-1'), settle('root-1', key)]);
    expect(attributionOf(settled, 'bg-1')).toEqual({
      kind: 'subagent',
      name: 'worker',
      callId: 'root-1',
    });
  });

  it('被選的模型與推理等級（#889）是選填的字串：有或沒有都認得，型別不對就整顆不認', () => {
    expect(isBackgroundSubagentMeta(key)).toBe(true);
    expect(isBackgroundSubagentMeta({ ...key, model: 'cheap' })).toBe(true);
    expect(isBackgroundSubagentMeta({ ...key, model: 'cheap', reasoningEffort: 'off' })).toBe(true);
    expect(isBackgroundSubagentMeta({ ...key, model: 1 })).toBe(false);
    expect(isBackgroundSubagentMeta({ ...key, reasoningEffort: null })).toBe(false);
  });

  it('認得不出來的 meta、失敗的呼叫、不是派子代理的工具：不歸屬', () => {
    for (const meta of [
      undefined,
      { kind: 'background-subagent', runId: '', subagentType: 'worker' },
      { kind: 'background-subagent', runId: 'bg-abc123def456' },
      { kind: 'something-else', runId: 'bg-abc123def456', subagentType: 'worker' },
      { ...key, model: 42 },
      { ...key, reasoningEffort: { level: 'off' } },
      'bg-abc123def456',
    ]) {
      const state = reduceAll(emptyConversation(), [
        dispatch('root-1'),
        settle('root-1', meta),
        innerStarted('bg-1'),
      ]);
      expect(attributionOf(state, 'bg-1').kind).toBe('unattributed');
    }
    const failed = reduceAll(emptyConversation(), [
      dispatch('root-1'),
      frame('tools', [], {
        event: 'tool-finished',
        tool_call_id: 'root-1',
        failed: true,
        message: '沒有這個子代理',
        meta: key,
      }),
      innerStarted('bg-1'),
    ]);
    expect(attributionOf(failed, 'bg-1').kind).toBe('unattributed');
    const otherTool = reduceAll(emptyConversation(), [
      frame('tools', [], {
        event: 'tool-started',
        tool_call_id: 'x',
        tool_name: 'look',
        input: '{}',
      }),
      frame('tools', [], { event: 'tool-finished', tool_call_id: 'x', meta: key }),
      innerStarted('bg-1'),
    ]);
    expect(attributionOf(otherTool, 'bg-1').kind).toBe('unattributed');
  });

  it('前景：subagent 內部派給 task（同一個 tool_call_id），靠 task 的 tool-started 歸屬，鑰匙用不到', () => {
    const state = reduceAll(emptyConversation(), [
      dispatch('root-1'),
      frame('tools', ['tools:abc'], {
        event: 'tool-started',
        tool_call_id: 'root-1',
        tool_name: 'task',
        input: JSON.stringify({ description: '幹活', subagent_type: 'worker' }),
      }),
      frame('tools', ['tools:abc', 'tools:def'], {
        event: 'tool-started',
        tool_call_id: 'fg-1',
        tool_name: 'look',
        input: '{}',
      }),
    ]);
    expect(attributionOf(state, 'fg-1')).toEqual({
      kind: 'subagent',
      name: 'worker',
      callId: 'root-1',
    });
    // 同一個 id 來第二次是續行：root 那張卡還是 subagent、歸 root，不被內層的 task 改寫。
    const root = state.entries.find((entry) => entry.id === 'tool-root-1');
    expect(root).toMatchObject({ kind: 'tool', name: 'subagent', attribution: { kind: 'root' } });
  });
});

describe('`custom` frame 的分派（#685）', () => {
  // 分派查的是名字→折疊那張表。**只認表自己的鍵**：`Object.prototype` 上的名字（`toString`、`constructor`
  // ⋯⋯）也是字串，用 `in` 或直接索引查的話會拿到原型上的函式、把它當折疊叫下去，state 被換成別的東西。
  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf'])(
    '原型上的名字 %s 也略過，state 原封不動',
    (name) => {
      const before = emptyConversation();
      const after = reduceConversation(before, frame('custom', [], { name, payload: {} }));
      expect(after.entries).toBe(before.entries);
      expect(after).toEqual({ ...before, lastSeq: after.lastSeq });
    },
  );
});

/**
 * **錯誤碼跨線**（[#667](https://github.com/DemianLi/nexus-agent/issues/667)）：frame 有碼時 `ToolEntry.errorCode`
 * 帶碼，沒碼時是 `undefined`。判斷「這張卡是怎麼失敗的」讀這一格，不讀紅字。
 */
describe('工具卡的錯誤碼（#667）', () => {
  const open = (id: string) =>
    frame('tools', ['tools:a'], {
      event: 'tool-started',
      tool_call_id: id,
      tool_name: id,
      input: '{}',
    });
  const tool = (state: ConversationState) => {
    const entry = state.entries.find((candidate) => candidate.kind === 'tool');
    if (entry?.kind !== 'tool') throw new Error('一張工具卡都沒有');
    return entry;
  };

  it('失敗的 `tool-finished` 帶碼：卡上有碼，紅字照舊是文字', () => {
    const state = reduceAll(emptyConversation(), [
      open('c1'),
      frame('tools', ['tools:a'], {
        event: 'tool-finished',
        tool_call_id: 'c1',
        failed: true,
        message: '這次呼叫在開始之前就被中止了',
        code: 'ABORTED_BEFORE_DISPATCH',
      }),
    ]);
    expect(tool(state)).toMatchObject({
      status: 'failed',
      error: '這次呼叫在開始之前就被中止了',
      errorCode: 'ABORTED_BEFORE_DISPATCH',
    });
  });

  it('沒帶碼就是 `undefined`；成功的就算帶了也不收', () => {
    const failed = reduceAll(emptyConversation(), [
      open('c1'),
      frame('tools', ['tools:a'], {
        event: 'tool-finished',
        tool_call_id: 'c1',
        failed: true,
        message: '壞了',
      }),
    ]);
    expect(tool(failed).errorCode).toBeUndefined();
    const done = reduceAll(emptyConversation(), [
      open('c1'),
      frame('tools', ['tools:a'], {
        event: 'tool-finished',
        tool_call_id: 'c1',
        message: '好了',
        code: 'X',
      }),
    ]);
    expect(tool(done)).toMatchObject({ status: 'done' });
    expect(tool(done).errorCode).toBeUndefined();
  });

  it('更正幀照這一顆換掉：先沒碼、後帶碼，留下後面那個', () => {
    const state = reduceAll(emptyConversation(), [
      open('c1'),
      frame('tools', ['tools:a'], {
        event: 'tool-finished',
        tool_call_id: 'c1',
        failed: true,
        message: '被擋下',
      }),
      frame('tools', ['tools:a'], {
        event: 'tool-finished',
        tool_call_id: 'c1',
        failed: true,
        message: '被擋下',
        code: 'FS_SANDBOX_DENIED',
      }),
    ]);
    expect(tool(state).errorCode).toBe('FS_SANDBOX_DENIED');
  });

  it('`tool-error` 帶了 `code`（協定 `ToolErrorData` 本來就有）也照抄', () => {
    const state = reduceAll(emptyConversation(), [
      open('c1'),
      frame('tools', ['tools:a'], {
        event: 'tool-error',
        tool_call_id: 'c1',
        message: '炸了',
        code: 'TOOL_TIMEOUT',
      }),
    ]);
    expect(tool(state)).toMatchObject({
      status: 'failed',
      error: '炸了',
      errorCode: 'TOOL_TIMEOUT',
    });
  });

  it('同一次呼叫續行（第二顆 `tool-started`）時碼跟紅字一起清掉', () => {
    const state = reduceAll(emptyConversation(), [
      open('c1'),
      frame('tools', ['tools:a'], {
        event: 'tool-error',
        tool_call_id: 'c1',
        message: '炸了',
        code: 'TOOL_TIMEOUT',
      }),
      open('c1'),
    ]);
    expect(tool(state)).toMatchObject({ status: 'running' });
    expect(tool(state).errorCode).toBeUndefined();
  });
});

/**
 * 條目的時刻（[#1030](https://github.com/DemianLi/nexus-agent/issues/1030)）：取自 frame 的 `params.timestamp`。
 *
 * 這裡造的是兩條路各自會送的 frame 形狀；真組裝下兩條路的時刻差多少在 `@nexus/harness` 的
 * `wire-entry-timestamps.test.ts` 量。
 */
describe('時刻（#1030）', () => {
  let at = 0;
  function timed(
    method: string,
    data: unknown,
    timestamp: unknown,
    namespace: readonly string[] = [],
  ): Event {
    const current = at++;
    return {
      type: 'event',
      seq: current,
      event_id: `time:${current}`,
      method,
      params: { namespace, timestamp, data },
    } as Event;
  }
  const custom = (name: string, payload: unknown, timestamp: number) =>
    timed('custom', { name, payload }, timestamp);
  const started = (callId: string, timestamp: number) =>
    timed(
      'tools',
      { event: 'tool-started', tool_call_id: callId, tool_name: 'echo', input: '{}' },
      timestamp,
      ['tools:a'],
    );
  const finished = (callId: string, timestamp: number, extra: object = {}) =>
    timed(
      'tools',
      { event: 'tool-finished', tool_call_id: callId, message: 'ok', ...extra },
      timestamp,
      ['tools:a'],
    );
  const lifecycle = (event: string, timestamp: number, extra: object = {}) =>
    timed('lifecycle', { event, graph_name: 'root', ...extra }, timestamp);
  const only = (state: ConversationState, id: string): ConversationEntry => {
    const found = state.entries.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`沒有 ${id}`);
    return found;
  };
  /** 決定與答案沒有這一格（型別上也沒有），所以用 `in` 取。 */
  const startedAtOf = (entry: ConversationEntry) =>
    'startedAt' in entry ? entry.startedAt : undefined;

  it('模型回覆：`message-start` 是開始、`message-finish` 是講完；還在吐字時沒有 settledAt', () => {
    at = 0;
    const open = reduceAll(emptyConversation(), [
      lifecycle('running', 90),
      timed('messages', { event: 'message-start', id: 'run-m', run_id: 'm' }, 100),
      timed(
        'messages',
        { event: 'content-block-delta', delta: { type: 'text-delta', text: '嗨' }, run_id: 'm' },
        150,
      ),
    ]);
    expect(only(open, 'm')).toMatchObject({ startedAt: 100, streaming: true });
    expect(only(open, 'm')).not.toHaveProperty('settledAt');
    const done = reduceConversation(
      open,
      timed('messages', { event: 'message-finish', run_id: 'm' }, 300),
    );
    expect(only(done, 'm')).toMatchObject({ startedAt: 100, settledAt: 300, streaming: false });
  });

  it('模型回覆出錯：settledAt 是 `error` 那顆的時刻', () => {
    at = 0;
    const state = reduceAll(emptyConversation(), [
      timed('messages', { event: 'message-start', id: 'run-m', run_id: 'm' }, 100),
      timed('messages', { event: 'error', run_id: 'm', message: '斷了' }, 240),
    ]);
    expect(only(state, 'm')).toMatchObject({ startedAt: 100, settledAt: 240, error: '斷了' });
  });

  it('工具卡：同一顆 `tool-started` 到兩次（日誌開卡、基座晚到）取第一顆；收卡取最後一顆 `tool-finished`', () => {
    at = 0;
    const state = reduceAll(emptyConversation(), [
      started('c1', 1000),
      started('c1', 1004),
      finished('c1', 2000),
      // pump 的更正幀（#296）：同一張卡再收一次，照這一顆換掉。
      finished('c1', 2003, { failed: true, message: '其實失敗了' }),
    ]);
    expect(only(state, 'tool-c1')).toMatchObject({
      status: 'failed',
      startedAt: 1000,
      settledAt: 2003,
    });
  });

  it('續接（resume）：答了中斷、同一顆 `tool-started` 再到，startedAt 不換，等人的時間算在裡面', () => {
    at = 0;
    const suspended = reduceAll(emptyConversation(), [
      started('c1', 1000),
      timed('tools', { event: 'tool-suspended', tool_call_id: 'c1' }, 1100, ['tools:a']),
    ]);
    expect(only(suspended, 'tool-c1')).toMatchObject({ status: 'suspended', startedAt: 1000 });
    expect(only(suspended, 'tool-c1')).not.toHaveProperty('settledAt');
    const resumed = reduceAll(suspended, [started('c1', 5000), finished('c1', 6000)]);
    expect(only(resumed, 'tool-c1')).toMatchObject({
      status: 'done',
      startedAt: 1000,
      settledAt: 6000,
    });
  });

  it('收過的卡被翻回執行中（判定先到、基座的 `tool-started` 晚到，#297）：settledAt 拿掉，不是留著舊的', () => {
    at = 0;
    const reopened = reduceAll(emptyConversation(), [
      started('c1', 1000),
      finished('c1', 1010),
      started('c1', 1020),
    ]);
    expect(only(reopened, 'tool-c1')).toMatchObject({ status: 'running', startedAt: 1000 });
    expect(only(reopened, 'tool-c1')).not.toHaveProperty('settledAt');
    const settled = reduceConversation(reopened, finished('c1', 1030));
    expect(only(settled, 'tool-c1')).toMatchObject({ startedAt: 1000, settledAt: 1030 });
  });

  it('`tool-error` 收卡：settledAt 是它的時刻', () => {
    at = 0;
    const state = reduceAll(emptyConversation(), [
      started('c1', 1000),
      timed('tools', { event: 'tool-error', tool_call_id: 'c1', message: '炸了' }, 1500, [
        'tools:a',
      ]),
    ]);
    expect(only(state, 'tool-c1')).toMatchObject({ status: 'failed', settledAt: 1500 });
  });

  it('按了停止：還在吐字的回覆與沒結果的卡，settledAt 都是收尾那顆 `lifecycle` 的時刻', () => {
    at = 0;
    const state = reduceAll(emptyConversation(), [
      lifecycle('running', 90),
      timed('messages', { event: 'message-start', id: 'run-m', run_id: 'm' }, 100),
      started('c1', 200),
      lifecycle('failed', 9000, { aborted: true }),
    ]);
    expect(only(state, 'm')).toMatchObject({ stopped: true, startedAt: 100, settledAt: 9000 });
    expect(only(state, 'tool-c1')).toMatchObject({
      status: 'failed',
      errorCode: UNFINISHED_TOOL_CODE,
      startedAt: 200,
      settledAt: 9000,
    });
  });

  it('一輪正常收掉或失敗時沒結果的卡：settledAt 同樣是收尾那顆的時刻', () => {
    at = 0;
    for (const close of ['completed', 'failed']) {
      const state = reduceAll(emptyConversation(), [
        lifecycle('running', 90),
        started('c1', 200),
        lifecycle(close, 7000),
      ]);
      expect(only(state, 'tool-c1')).toMatchObject({ status: 'failed', settledAt: 7000 });
    }
  });

  it('一個時刻的條目只帶 startedAt：人話、通知、子代理來信、交付、改動紀錄、壓縮', () => {
    at = 0;
    const state = reduceAll(emptyConversation(), [
      // 歷史重播的人話。
      timed('messages', { event: 'message-start', role: 'human', id: 'history-0' }, 10),
      // 即時那條：送出佇列被領走。
      custom(INBOX, { items: [], claimed: { id: 'q1', text: '嗨' } }, 20),
      custom(
        INBOX,
        { items: [], claimed: { id: 'q2', text: 'done', source: { kind: 'subagent-settled' } } },
        30,
      ),
      custom(
        INBOX,
        {
          items: [],
          claimed: {
            id: 'q3',
            text: '話',
            source: { kind: 'agent-message', senderSessionId: 's', runId: 'r' },
          },
        },
        40,
      ),
      // 歷史那條：通知與來信是自己的 frame。
      custom(SETTLE_NOTICE, { id: 'history-5' }, 50),
      custom(AGENT_MESSAGE, { id: 'history-6', senderSessionId: 's', runId: 'r', text: '話' }, 60),
      custom(DELIVERABLES_PRESENTED, { callId: 'c9', seq: 7, files: [{ path: 'a.md' }] }, 70),
      custom(WORKSPACE_CHANGES, { seq: 8 }, 80),
      custom(COMPACTION, { seq: 9, cutoff: 2, saved: true }, 90),
    ]);
    expect(state.entries.map((entry) => [entry.kind, entry.id, startedAtOf(entry)])).toEqual([
      ['human', 'history-0', 10],
      ['human', 'inbox:q1', 20],
      ['notice', 'inbox:q2', 30],
      ['agent-message', 'inbox:q3', 40],
      ['notice', 'history-5', 50],
      ['agent-message', 'history-6', 60],
      ['deliverables', 'deliverables:c9', 70],
      ['workspace-changes', 'workspace-changes:8', 80],
      ['compaction', 'compaction:9', 90],
    ]);
    for (const entry of state.entries) expect(entry).not.toHaveProperty('settledAt');
  });

  it('人按的決定與答案不帶時刻：它們不是從線上來的', () => {
    at = 0;
    const asked = reduceAll(emptyConversation(), [
      timed(
        'input.requested',
        {
          interrupt_id: 'i1',
          payload: {
            actionRequests: [{ name: 'echo', args: {} }],
            reviewConfigs: [{ actionName: 'echo', allowedDecisions: ['approve'] }],
          },
        },
        100,
      ),
      timed(
        'input.requested',
        { interrupt_id: 'q1', payload: { kind: 'question', questions: [] } },
        110,
      ),
    ]);
    const decided = appendAnswers(appendDecision(asked, 'i1', 'approve'), 'q1', []);
    const local = decided.entries.filter(
      (entry) => entry.kind === 'decision' || entry.kind === 'answer',
    );
    expect(local).toHaveLength(2);
    for (const entry of local) expect(entry).not.toHaveProperty('startedAt');
  });

  it('不能用的時刻（0、負數、NaN、不是數字、沒帶）不給那一格，JSON 往返也沒有這個鍵', () => {
    at = 0;
    for (const timestamp of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '100', undefined]) {
      const state = reduceAll(emptyConversation(), [
        timed('messages', { event: 'message-start', id: 'run-m', run_id: 'm' }, timestamp),
        timed('messages', { event: 'message-finish', run_id: 'm' }, timestamp),
        started('c1', 0),
        custom(WORKSPACE_CHANGES, { seq: 1 }, 0),
      ]);
      for (const entry of state.entries) {
        expect(entry).not.toHaveProperty('startedAt');
        expect(entry).not.toHaveProperty('settledAt');
        expect(Object.keys(JSON.parse(JSON.stringify(entry)) as object)).not.toContain('startedAt');
      }
    }
  });

  it('`prependEntries`（往前翻頁）原樣留著較早那一頁的時刻', () => {
    at = 0;
    const earlier = reduceAll(emptyConversation(), [
      timed('messages', { event: 'message-start', role: 'human', id: 'history-0' }, 10),
      started('c0', 20),
      finished('c0', 30),
    ]);
    const now = reduceAll(emptyConversation(), [
      timed('messages', { event: 'message-start', role: 'human', id: 'history-9' }, 900),
    ]);
    const joined = prependEntries(now, earlier);
    expect(joined.entries.map(startedAtOf)).toEqual([10, 20, 900]);
    expect(only(joined, 'tool-c0')).toMatchObject({ startedAt: 20, settledAt: 30 });
  });
});
