/**
 * **壓縮發生過這件事，在會話日誌裡留得下來**——[#143](https://github.com/DemianLi/nexus-agent/issues/143)
 * 的驗收，量的是真的跑一場會摘要的對話之後日誌裡有什麼。
 *
 * 事件的欄位語義在 `packages/nexus-core/src/session-log.ts`，判別式的邊界在
 * `packages/nexus-core/src/summarization.test.ts`。這裡只問**接起來之後有沒有到**。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，backend 是一個 mkdtemp 出來的目錄。
 *
 * ## 一件會讓人白花半天的事：腳本的輪數會被摘要器吃掉
 *
 * 摘要器自己要叫一次模型去產那份摘要，而那一次也從同一份腳本裡拿。所以腳本要**多備幾輪**，
 * 而且**不能拿模型被叫幾次當判準**——判準一律放在日誌內容上。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { fromLoggedMessage, SessionLog, SessionRegistry } from '@nexus/core';
import type { NexusPlugin, SessionEvent, SessionEventMap } from '@nexus/core';
import { describe, expect, it, vi } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

type CompactionSummary = SessionEventMap['compaction/summary'];

const ROOT_ID = 'compaction-root';

/** 只註冊一個 subagent，其餘什麼都不做。 */
const withWorker: NexusPlugin = {
  name: 'worker-host',
  apply(registry) {
    registry.subagents.register({ name: 'worker', description: '幹活的。' });
  },
};

/** 一份日誌裡的壓縮紀錄，照 `seq` 排。 */
function compactionsOf(events: readonly SessionEvent[]): CompactionSummary[] {
  return events
    .filter((event) => event.type === 'compaction/summary')
    .map((event) => event.data as CompactionSummary);
}

interface RunResult {
  readonly root: CompactionSummary[];
  readonly subagents: CompactionSummary[][];
  /** backend 的根，用來核對 `filePath` 指到的檔真的在。 */
  readonly backendRoot: string;
  /** 模型每一輪讀到的 prompt。摘要訊息寫不寫出歷史路徑，從這裡看。 */
  readonly prompts: readonly (readonly BaseMessage[])[];
  /** 同一個 backend 與 checkpointer：歷史在 graph state 裡（#348），要讀回得接同一個 thread。 */
  readonly backend: ContainedFilesystemBackend;
  readonly saver: MemorySaver;
}

/**
 * 跑一場會摘要的對話，回傳每一份日誌裡的壓縮紀錄。
 *
 * @param turns - 模型的腳本；摘要器也會吃掉其中幾輪，所以要多備。
 * @param options - 門檻、plugin、要跑幾次 `invoke`。
 * @returns root 那份、每一份 subagent 的、以及 backend 的根。
 */
async function run(
  turns: readonly ScriptedTurn[],
  options: {
    summarization?: Parameters<typeof createNexusAgent>[0]['summarization'];
    plugins?: readonly NexusPlugin[];
    invocations?: number;
  } = {},
): Promise<RunResult> {
  const backendRoot = await mkdtemp(join(tmpdir(), 'nexus-compaction-'));
  const model = new ScriptedChatModel({ turns });
  const backend = new ContainedFilesystemBackend({ rootDir: backendRoot });
  const saver = new MemorySaver();
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    backend,
    checkpointer: saver,
    plugins: [...(options.plugins ?? [])],
    ...(options.summarization !== undefined && { summarization: options.summarization }),
  });
  const sessions = new SessionRegistry(ROOT_ID);
  const detach = attachSession(sessions);
  try {
    for (let index = 0; index < (options.invocations ?? 1); index += 1) {
      await agent.invoke(toAgentInvocation(`第 ${index + 1} 句。`), {
        configurable: { thread_id: ROOT_ID },
      });
    }
  } finally {
    detach();
    await dispose();
  }
  const entries = sessions.list();
  return {
    backendRoot,
    prompts: model.prompts,
    backend,
    saver,
    root: compactionsOf(entries.find((entry) => entry.address.kind === 'root')?.log.events ?? []),
    subagents: entries
      .filter((entry) => entry.address.kind === 'subagent')
      .map((entry) => compactionsOf(entry.log.events)),
  };
}

/** 每則約 100 token（`countTokensApproximately` 約當 4 字元 1 token）。 */
const BODY = '這是一段普通長度的回話。'.repeat(32);

/** subagent 那條用的大回話，每則約 600 token——四五圈就把它自己的串頂過門檻。 */
const BIG_BODY = '這是一段普通長度的回話。'.repeat(200);

/** 一份夠長的腳本；摘要器吃掉幾輪都還有剩。 */
function chatter(count = 40): ScriptedTurn[] {
  return Array.from({ length: count }, () => ({ content: BODY }));
}

describe('壓縮發生時，日誌裡留得下來', () => {
  /**
   * **卡上的驗收句。** 設定是等比縮小的：`tokens: 3_000` 配預設的 `keep: 20 則`，結構上
   * 等同預設的 `tokens: 100_000` 配一般大小的訊息（同 `summarization.test.ts` 的鋸齒那條）。
   *
   * 這裡不斷言筆數，因為摘要跑幾次取決於腳本被吃掉幾輪——**「至少一次」才是這條測得準的
   * 東西**。整層漏接的話它是 0，紅得很乾脆。
   */
  it('摘要真的跑過，root 那份就有紀錄', async () => {
    const { root } = await run(chatter(), {
      summarization: { trigger: [{ type: 'tokens', value: 3_000 }] },
      invocations: 12,
    });

    expect(root.length).toBeGreaterThan(0);
  });

  /**
   * **`cutoffIndex` 與 `messagesBefore` 是同一組座標，而那組是原始訊息串。**
   *
   * 拿有效串的長度去配原始座標的切點（一個很容易寫錯的組合）會讓 `cutoffIndex >
   * messagesBefore` 在第二次摘要之後成立——圖的狀態只會長不會縮，有效串卻短得多。
   */
  it('切點落在長度之內，讀得出「換掉了多前面的多少」', async () => {
    // **`keep` 要小**，這一格才分得出來：`keep` 留在預設的 20 則時切點只有 1 或 3，
    // 而切點是 1 的時候有效串跟原始串**一樣長**（`[摘要, ...slice(1)]`），量錯了也看不出來。
    // 實測過：預設 `keep` 下量成有效串的突變是全綠的。
    const { root } = await run(chatter(120), {
      summarization: {
        trigger: [{ type: 'tokens', value: 3_000 }],
        keep: { type: 'messages', value: 2 },
      },
      invocations: 20,
    });

    // 要有兩顆以上，下面那條單調才有東西可比——只有一顆的話它是空談。
    expect(root.length).toBeGreaterThan(1);
    for (const record of root) {
      expect(Number.isInteger(record.cutoffIndex)).toBe(true);
      expect(record.cutoffIndex).toBeGreaterThan(0);
      expect(record.cutoffIndex).toBeLessThanOrEqual(record.messagesBefore);
    }

    // **承重條：`messagesBefore` 只會長不會縮。**
    //
    // 原始訊息串是 append-only（那正是「摘要之後原文還在」的另一面），所以連續兩顆之間
    // 它不可能變小。改量成**有效串**的話這裡當場紅——有效串在每次摘要之後都會縮回去，
    // 而縮回去的那個數字配上原始座標的 `cutoffIndex` 就再也讀不出「換掉了多少」。
    // 上面那條 `cutoffIndex <= messagesBefore` 抓不到這個突變（實測過），這條才抓得到。
    const lengths = root.map((record) => record.messagesBefore);
    expect(lengths).toEqual([...lengths].sort((left, right) => left - right));
  });

  /**
   * `filePath` 要指到 backend 裡真的存在的那個檔，不是一個看起來像路徑的字串。
   *
   * **從模型那一側讀回來**：另一個 agent 接同一個 thread，照日誌記的路徑 `read_file`。#348 之前
   * 這裡直接讀工作區裡的檔；現在那一格在 graph state 裡，而「模型照摘要那句話讀得到」本來就是
   * 這個路徑存在的理由。`summarization: false` 讓這一輪不再壓一次——壓了的話摘要那次呼叫會吃掉
   * 讀檔那一回合。
   */
  it('`filePath` 指到的檔真的寫出來了', async () => {
    const { root, backend, saver } = await run(chatter(), {
      summarization: { trigger: [{ type: 'tokens', value: 3_000 }] },
      invocations: 12,
    });

    const path = root[0]?.filePath;
    expect(path).toMatch(/^\/conversation_history\//);

    const reader = new ScriptedChatModel({
      turns: [
        { content: '', toolCalls: [{ name: 'read_file', args: { file_path: path, limit: 5 } }] },
        { content: '讀完了。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model: reader,
      backend,
      checkpointer: saver,
      plugins: [],
      summarization: false,
    });
    try {
      await agent.invoke(toAgentInvocation('讀一下之前的歷史。'), {
        configurable: { thread_id: ROOT_ID },
      });
    } finally {
      await dispose();
    }
    const read = reader.lastPrompt.filter((message) => message.getType() === 'tool').at(-1);
    expect(read?.text).toContain('Summarized at');
  });

  /**
   * **對照組：沒摘要就一筆都沒有。**
   *
   * 沒有這一條的話，一個「每輪都記一筆」的實作在上面每一條都是綠的。
   */
  it('短對話碰不到門檻，一筆都沒有', async () => {
    const { root } = await run([{ content: '好了。' }]);

    expect(root).toEqual([]);
  });

  /**
   * **摘要本文進日誌**（[#305](https://github.com/DemianLi/nexus-agent/issues/305)）——這一條以前是
   * 反過來的絆索（「摘要本文不准進日誌」），理由是那時日誌不記訊息內容。推模型歷史的一側要拿它換掉
   * 被壓掉的那一段，所以翻面：它要在，而且就是基座換上去的那一則（`lc_source: 'summarization'`
   * 的 HumanMessage，`getEffectiveMessages` 放在最前面的那一則）。
   *
   * 釘的仍然是**欄位集合**：多一格、少一格都紅。
   */
  it('酬載是四個欄位，summary 就是換上去的那則摘要訊息', async () => {
    const { root } = await run(chatter(), {
      summarization: { trigger: [{ type: 'tokens', value: 3_000 }] },
      invocations: 12,
    });

    expect(root.length).toBeGreaterThan(0);
    for (const record of root) {
      expect(Object.keys(record).sort()).toEqual([
        'cutoffIndex',
        'filePath',
        'messagesBefore',
        'summary',
      ]);
      const summary = fromLoggedMessage(record.summary!);
      expect(summary.getType()).toBe('human');
      expect(summary.additional_kwargs.lc_source).toBe('summarization');
      expect(summary.text.length).toBeGreaterThan(0);
    }
  });
});

/**
 * **射程：subagent 那側寫得進去——這是卡上決定 3 的反面。**
 *
 * 卡上原本判斷 subagent 的壓縮紀錄結構上取不到，依據是 `EXCLUDED_STATE_KEYS` 把
 * `_summarizationEvent` 擋在傳進／傳出 subagent 兩個方向之外。**那條擋的是 root 的快照讀
 * 得到什麼**：`foldSummarizer` 逐個 agent 建一份摘要器，subagent 那份就在 subagent 自己的
 * 圖裡跑，回傳值當場拿到，再用 `checkpoint_ns` 問這次屬於哪一份日誌。
 *
 * 兩半各有一條會紅的斷言，理由不同：漏了 `foldSubAgents` 那一注 → subagent 那份是空的；
 * 身分算錯 → subagent 的紀錄跑到 root 那份去。
 */
describe('subagent 那側', () => {
  /**
   * **壓力要長在 subagent 身上，不能長在 root 身上**——這個 fixture 有兩個容易踩壞的地方。
   *
   * 1. 門檻用**訊息數**的話 root 一定先碰到（它的串比較長），摘要器就把第一輪那個 `task`
   *    呼叫吃掉了，subagent 根本沒被生出來。所以用 token，並讓 subagent 那幾輪各自很大：
   *    root 只有「一句話 ＋ 一次委派」，subagent 每一圈都疊一坨大回話。
   * 2. 摘要器自己也吃腳本輪，所以迴圈那幾輪要**多備**，末尾兩輪才是真的收工。備不夠的
   *    症狀是 `腳本只有 N 輪，但 agent 迴圈要求第 N+1 輪`。
   */
  it('subagent 的壓縮記在 subagent 自己那份，不在 root 的', async () => {
    const { root, subagents } = await run(
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        // 每圈約 600 token，四五圈就越得過門檻。
        ...Array.from({ length: 10 }, () => ({
          content: BIG_BODY,
          toolCalls: [{ name: 'ls', args: {} }],
        })),
        // 收工輪多備幾格給摘要器吃——它自己那次呼叫也從這份腳本拿。
        ...Array.from({ length: 8 }, () => ({ content: '收工。' })),
      ],
      {
        summarization: {
          trigger: [{ type: 'tokens', value: 3_000 }],
          // 要小於當時的訊息數，否則 `determineCutoffIndex` 算出 `<= 0`，基座直接放行、
          // 什麼都不會發生——那會讓這條測試永遠綠得沒有意義。
          keep: { type: 'messages', value: 2 },
        },
        plugins: [withWorker],
      },
    );

    // 這一條是承重的：漏了 `foldSubAgents` 那一注 → 空的；身分算錯（一律解成 root）
    //  → 也是空的。兩個突變都實測過，紅的都是這一條。
    expect(subagents.some((records) => records.length > 0)).toBe(true);
    // **這一條不是第二道判準，是在釘 fixture 本身**：root 這一場自己碰不到門檻。
    // 它紅的話代表壓力跑到 root 身上去了，上面那條就算綠也不再證明射程——所以它擋的是
    // 「fixture 悄悄失效」，不是「實作寫錯」。
    expect(root).toEqual([]);
  });
});

/**
 * **記不進去不能反過來把摘要器殺掉。**
 *
 * 這一層比 `model/usage` 那顆更嚴：它是**同名取代**，從這裡漏出去的錯不只是掉一行日誌，
 * 是把摘要器本身連根拔掉——那一輪的訊息串不會被壓，長對話直接撞窗口。
 *
 * 拿掉 `withCompactionLog` 裡那個 try/catch，這條當場紅。
 */
describe('日誌寫不進去的時候', () => {
  it('append 拋了，那一輪照樣跑完、歷史照樣寫出來', async () => {
    // ⚠️ **這個 spy 打在 prototype 上，所以每一個寫日誌的人都在拋**——`model/usage` 那顆
    // 也在裡面，而它同樣吃掉自己的錯。所以這條綠**不足以**單獨證明 `withCompactionLog`
    // 有 try/catch；能證明的是「拿掉它會紅」，那個突變跑過了。
    const append = vi.spyOn(SessionLog.prototype, 'append').mockImplementation(() => {
      throw new Error('日誌壞了');
    });
    try {
      const { root, prompts } = await run(chatter(), {
        summarization: { trigger: [{ type: 'tokens', value: 3_000 }] },
        invocations: 12,
      });

      // 日誌當然是空的——它整個壞了。要看的是**跑完了**，而且摘要真的發生過、歷史真的寫出來：
      // 摘要訊息只有在 offload 寫成功時才寫出路徑（基座 `buildSummaryMessage` 看 `filePath`）。
      // #348 之前這裡讀的是工作區裡的 `conversation_history/`，現在那一格在 graph state 裡。
      expect(root).toEqual([]);
      expect(
        prompts.some((prompt) =>
          prompt.some((message) =>
            message.text.includes('has been saved to /conversation_history/'),
          ),
        ),
      ).toBe(true);
    } finally {
      append.mockRestore();
    }
  });
});
