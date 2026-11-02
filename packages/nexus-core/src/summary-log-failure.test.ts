/**
 * **摘要記不進去，這次摘要不生效**——[#1702](https://github.com/DemianLi/nexus-agent/issues/1702)。
 *
 * dsh 的壓縮是一筆事件，寫不進去就等於沒壓縮；自動壓縮失敗在 pressure 路徑記 warn、照原樣繼續
 * （`compaction-basic/src/index.ts:163-173`），在 overflow 路徑記 warn、保留原本的請求錯誤（`:204-227`）。
 * 我們的 `compaction/summary` 記不進去時改拋一顆「生摘要失敗」的錯，走 #1374 既有的兩條路（見 `summary-failure.test.ts`）。
 *
 * 每一格兩邊都斷言：**模型收到的是沒壓縮的請求**，而且**回傳沒有壓縮的痕跡**（沒有 `_summarizationEvent`、歷史檔沒寫、
 * 日誌沒有 `compaction/summary`）。對照組是同一套組裝、日誌寫得進去。
 */

import { ContextOverflowError } from '@langchain/core/errors';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';
import {
  createSummarizer,
  DEFAULT_SUMMARIZATION,
  readSummarizationEvent,
} from './summarization.js';
import type { SummarizationSettings } from './summarization.js';
import { TokenAnchorBook } from './token-estimate.js';
import { TOOL_RESULT_PRUNE_MARKER } from './tool-result-pruner.js';
import type { ToolResultPruneConfig } from './tool-result-pruner.js';

const BIG = '這是一段很長的內容。'.repeat(300);
const conversation = (): BaseMessage[] => [
  new HumanMessage(BIG),
  new AIMessage('一'),
  new HumanMessage('二'),
  new AIMessage('三'),
  new HumanMessage('四'),
  new AIMessage('五'),
  new HumanMessage('短問題'),
];

const TOKEN_TRIGGER: Partial<SummarizationSettings> = {
  trigger: [{ type: 'tokens', value: 2_000 }],
};

/**
 * 同一套組裝跑好幾次呼叫。`fail` 為真時 `failType`（預設 `compaction/summary`）寫不進去，其餘照真的寫；
 * `summaryAppends` 數的是 `compaction/summary` 試記了幾次。
 */
function rig(
  settings: Partial<SummarizationSettings>,
  fail: boolean,
  options: { failType?: string; pruning?: ToolResultPruneConfig } = {},
) {
  const failType = options.failType ?? 'compaction/summary';
  const log = new SessionLog('s');
  const sessions = {
    forCall: (): SessionLookup => ({ kind: 'ok', address: { kind: 'root' }, log }),
  };
  const real = log.append.bind(log);
  let summaryAppends = 0;
  vi.spyOn(log, 'append').mockImplementation(((type: never, data: never, options: never) => {
    if (type === 'compaction/summary') summaryAppends += 1;
    if (fail && type === failType) throw new Error('日誌拒收');
    return real(type, data, options);
  }) as typeof log.append);
  const reports: string[] = [];
  const writes: string[] = [];
  let invokes = 0;
  const model = {
    profile: {},
    invoke: async () => {
      invokes += 1;
      return { text: '這是摘要。' };
    },
  };
  const middleware = createSummarizer(
    {
      write: async (path: string) => {
        writes.push(path);
        return { path };
      },
    } as never,
    { ...DEFAULT_SUMMARIZATION, retainTokens: 1, ...settings },
    new TokenAnchorBook(),
    sessions,
    options.pruning ?? false,
    undefined,
    undefined,
    (message) => reports.push(message),
  );
  const handled: BaseMessage[][] = [];
  const call = async (
    messages: readonly BaseMessage[],
    handlerThrows?: (call: number) => Error | undefined,
  ): Promise<{ result?: unknown; error?: unknown }> => {
    try {
      return {
        result: await middleware.wrapModelCall?.(
          {
            messages,
            state: {},
            model,
            systemMessage: new SystemMessage('系統。'),
            tools: [],
          } as never,
          ((request: { messages: BaseMessage[] }) => {
            handled.push(request.messages);
            const error = handlerThrows?.(handled.length);
            if (error !== undefined) throw error;
            return new AIMessage('好。');
          }) as never,
        ),
      };
    } catch (error) {
      return { error };
    }
  };
  return {
    log,
    reports,
    writes,
    handled,
    call,
    get invokes() {
      return invokes;
    },
    get summaryAppends() {
      return summaryAppends;
    },
  };
}

const summaries = (log: SessionLog) =>
  log.events.filter((event) => event.type === 'compaction/summary');

describe('對照：寫得進去就照常摘要', () => {
  it('門檻觸發：模型收到摘要過的請求、回傳帶 _summarizationEvent、日誌有一筆、歷史檔寫了', async () => {
    const r = rig(TOKEN_TRIGGER, false);
    const out = await r.call(conversation());
    expect(out.error).toBeUndefined();
    expect(readSummarizationEvent(out.result)).toBeDefined();
    expect(r.handled).toHaveLength(1);
    expect(String(r.handled[0]![0]!.content)).not.toBe(BIG);
    expect(summaries(r.log)).toHaveLength(1);
    expect(r.writes).toHaveLength(1);
    expect(r.reports).toEqual([]);
  });
});

describe('摘要記不進去：門檻觸發（dsh 的 pressure 路徑）', () => {
  it('warn 一條、照原請求送出：模型收到沒壓縮的、回傳沒有 _summarizationEvent、歷史檔丟掉', async () => {
    const r = rig(TOKEN_TRIGGER, true);
    const out = await r.call(conversation());
    expect(out.error).toBeUndefined();
    // 回傳：基座的回覆原樣，不是帶事件的 Command。
    expect(out.result).toBeInstanceOf(AIMessage);
    expect(readSummarizationEvent(out.result)).toBeUndefined();
    // 模型收到的：七則一則沒少，第一則是原文。
    expect(r.handled).toHaveLength(1);
    expect(r.handled[0]).toHaveLength(7);
    expect(String(r.handled[0]![0]!.content)).toBe(BIG);
    // 歷史檔：#1389 的暫存層沒看到事件也沒看到 Command，丟掉，後端一次都沒寫。
    expect(r.writes).toEqual([]);
    expect(summaries(r.log)).toEqual([]);
    // 摘要只生一次、只試記一次。
    expect(r.invokes).toBe(1);
    expect(r.summaryAppends).toBe(1);
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]).toContain('compaction/summary 記不進去');
    expect(r.reports[0]).toContain('照原請求送出');
  });

  it('#1390 的補回不會補：下一次沒到門檻的請求照樣原樣交下去，回傳不是 Command', async () => {
    const r = rig(TOKEN_TRIGGER, true);
    await r.call(conversation());
    const short = [new HumanMessage('嗨'), new AIMessage('嗨'), new HumanMessage('再問')];
    const out = await r.call(short);
    expect(out.error).toBeUndefined();
    expect(out.result).toBeInstanceOf(AIMessage);
    expect(readSummarizationEvent(out.result)).toBeUndefined();
    expect(r.handled[1]).toEqual(short);
  });

  it('照原請求送出又碰到端點超窗、緊急摘要又記不進去：保留端點的錯，不再重摘', async () => {
    const r = rig(TOKEN_TRIGGER, true);
    const endpointError = new ContextOverflowError('端點說：超窗了');
    const out = await r.call(conversation(), (call) => (call === 1 ? endpointError : undefined));
    expect(out.error).toBe(endpointError);
    expect(out.result).toBeUndefined();
    // 門檻那一次＋端點超窗那一次的緊急摘要：各一次，沒有第三次。
    expect(r.invokes).toBe(2);
    expect(r.summaryAppends).toBe(2);
    expect(r.handled).toHaveLength(1);
    expect(String(r.handled[0]![0]!.content)).toBe(BIG);
    expect(r.writes).toEqual([]);
    expect(summaries(r.log)).toEqual([]);
    expect(r.reports).toHaveLength(2);
    expect(r.reports[1]).toContain('保留原本的請求錯誤');
  });
});

describe('摘要記不進去：端點真的回超窗（dsh 的 overflow 路徑）', () => {
  it('保留原本的請求錯誤（同一個物件）、warn 一條、不再送、摘要只試一次', async () => {
    // 門檻開很大：我們自己的預算不會合成超窗，是端點回的。
    const r = rig({ trigger: [{ type: 'tokens', value: 900_000 }] }, true);
    const endpointError = new ContextOverflowError('端點說：超窗了');
    const out = await r.call(conversation(), (call) => (call === 1 ? endpointError : undefined));
    expect(out.error).toBe(endpointError);
    expect(r.handled).toHaveLength(1);
    expect(r.invokes).toBe(1);
    expect(r.summaryAppends).toBe(1);
    expect(r.writes).toEqual([]);
    expect(summaries(r.log)).toEqual([]);
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]).toContain('compaction/summary 記不進去');
    expect(r.reports[0]).toContain('保留原本的請求錯誤');
  });
});

describe('context/measure 記不進去（#1702 歸 (C)）', () => {
  it('warn 一條，這次呼叫照常回來；它不改請求、不改 state', async () => {
    const r = rig({ trigger: [{ type: 'tokens', value: 900_000 }] }, true, {
      failType: 'context/measure',
    });
    const messages = conversation();
    const out = await r.call(messages);
    expect(out.error).toBeUndefined();
    expect(out.result).toBeInstanceOf(AIMessage);
    expect(r.handled[0]).toEqual(messages);
    expect(r.log.events.filter((event) => event.type === 'context/measure')).toEqual([]);
    expect(r.reports).toEqual([expect.stringContaining('context/measure 記不進去')]);
  });
});

describe('compaction/prune 記不進去：這次新剪的不生效', () => {
  const PRUNE: ToolResultPruneConfig = { thresholdChars: 100, headChars: 5, tailChars: 5 };
  /** 尾巴保留 1 token：最後那對工具呼叫與結果留在摘要之後，模型看得到結果剪了沒。 */
  const withTool = (): BaseMessage[] => [
    new HumanMessage(BIG),
    new AIMessage('一'),
    new HumanMessage('二'),
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'c1', name: 'read', args: {}, type: 'tool_call' }],
    }),
    new ToolMessage({ content: '結'.repeat(500), tool_call_id: 'c1', name: 'read' }),
  ];
  const resultOf = (messages: readonly BaseMessage[]) =>
    messages.find((message) => ToolMessage.isInstance(message));

  it('對照：寫得進去就剪，模型收到剪過的、日誌一筆', async () => {
    const r = rig(TOKEN_TRIGGER, false, { failType: 'compaction/prune', pruning: PRUNE });
    await r.call(withTool());
    expect(String(resultOf(r.handled[0]!)?.content)).toContain(TOOL_RESULT_PRUNE_MARKER);
    expect(r.log.events.filter((event) => event.type === 'compaction/prune')).toHaveLength(1);
    expect(r.reports).toEqual([]);
  });

  it('寫不進去：模型收到原文、日誌沒有、warn 一條，這一輪照常（摘要照走）', async () => {
    const r = rig(TOKEN_TRIGGER, true, { failType: 'compaction/prune', pruning: PRUNE });
    const out = await r.call(withTool());
    expect(out.error).toBeUndefined();
    expect(resultOf(r.handled[0]!)?.content).toBe('結'.repeat(500));
    expect(r.log.events.filter((event) => event.type === 'compaction/prune')).toEqual([]);
    expect(r.reports).toEqual([expect.stringContaining('compaction/prune 記不進去')]);
  });
});
