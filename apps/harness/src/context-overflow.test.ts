/**
 * **供應商回上下文溢出時，基座那條緊急摘要的恢復路徑到底跑不跑得起來**——#150 的 go／no-go。
 *
 * 基座認的是型別化的 `ContextOverflowError`（`@langchain/core/errors`），`isContextOverflow`
 * 沿 `cause` 鏈走（`dist/langsmith-zm0ILQsV.js:3126`）。**問題在於錯誤到得了那裡嗎**：
 * 模型拋出來的東西會先經過 `MiddlewareError.wrap`，包完之後我們那顆還在不在鏈上，沒有人量過。
 * 這一格是紅的話，#150 就不是「補一個 matcher」而是另一個形狀的問題。
 *
 * **不打真端點**：這裡要驗的是**我們這棵樹**認不認得那個型別，不是供應商回什麼字——後者由
 * `live-model.test.ts` 那側負責。而且今天的 `DEFAULT_LIVE_MODEL_ID` **根本逼不出上下文溢出**
 * （2026-09-04 量到 700,045 token 仍然 `200`，見 `live-model.ts` 的檔頭），所以就算想打
 * 真端點也驗不到這一條。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextOverflowError } from '@langchain/core/errors';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { MemorySaver } from '@langchain/langgraph';
import { deriveSessionStats, SessionRegistry } from '@nexus/core';
import type { SessionEvent, SummarizationSettings } from '@nexus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';

/**
 * 對話內容的墊料：框好的摘要要比被取代那段小才會提交（#1396），一句「第 1 句。」連框架文字都比不過。
 * 墊到比摘要框架大，這一檔才走得到「摘要真的提交」那條路。
 */
const PAD = '內容'.repeat(60);

interface ThrowingState {
  calls: number;
}

/**
 * 第 `throwOnCall` 次呼叫時拋 `error`，其餘照常回話。
 *
 * 自己寫一顆而不是擴充 `ScriptedChatModel`，是因為那顆的腳本語義是「回什麼」，
 * 而這裡要的是「拋什麼」——混進去會讓那份腳本多一個只有這個檔在用的概念。
 */
class ThrowingChatModel extends BaseChatModel {
  private readonly error: unknown;
  private readonly throwOnCall: number;
  private readonly also: { call: number; error: unknown } | undefined;
  private readonly state: ThrowingState;

  constructor(
    options: BaseChatModelParams & {
      error: unknown;
      throwOnCall: number;
      /** 另一次要拋的呼叫與它的錯誤（摘要那次呼叫壞掉用）。 */
      also?: { call: number; error: unknown };
      state?: ThrowingState;
    },
  ) {
    const { error, throwOnCall, also, state, ...rest } = options;
    super(rest);
    this.error = error;
    this.throwOnCall = throwOnCall;
    this.also = also;
    this.state = state ?? { calls: 0 };
  }

  get calls(): number {
    return this.state.calls;
  }

  _llmType(): string {
    return 'throwing';
  }

  override bindTools(): ThrowingChatModel {
    return new ThrowingChatModel({
      error: this.error,
      throwOnCall: this.throwOnCall,
      ...(this.also === undefined ? {} : { also: this.also }),
      state: this.state,
    });
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.state.calls += 1;
    if (this.state.calls === this.throwOnCall) throw this.error;
    if (this.also !== undefined && this.state.calls === this.also.call) throw this.also.error;
    const message = new AIMessage(`第 ${this.state.calls} 次回話。${PAD}`);
    return { generations: [{ text: message.text, message }], llmOutput: {} };
  }
}

/**
 * 跑到第 `throwOnCall` 次呼叫，看那次拋出去之後整場活不活得下來。
 *
 * `trigger` 刻意設到高不可攀：這一格要走的是**壓力沒到、直接撞窗口**那條分支
 * （`:3220-3231`），不是正常的壓力壓縮。`retainTokens` 要小，否則 `performSummarization` 算出
 * `cutoffIndex <= 0`，基座直接把同一個請求再送一次、當場再拋一次——那會讓恢復看起來
 * 失敗，而原因其實是設定。
 */
async function runUntilThrow(
  error: unknown,
  throwOnCall: number,
  invocations: number,
  trigger: { type: 'tokens' | 'messages'; value: number }[] = [
    { type: 'tokens', value: 1_000_000 },
  ],
  also?: { call: number; error: unknown },
  /** 保留量設定；預設一個很小的 `retainTokens`，讓切點算得出正的。 */
  retain: Pick<SummarizationSettings, 'retainRatio' | 'retainTokens'> | Record<string, never> = {
    retainTokens: 12,
  },
): Promise<{
  rejected: unknown;
  calls: number;
  historyFiles: string[];
  events: readonly SessionEvent[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-overflow-'));
  const model = new ThrowingChatModel({
    error,
    throwOnCall,
    ...(also === undefined ? {} : { also }),
  });
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    checkpointer: new MemorySaver(),
    plugins: [],
    summarization: { trigger, ...retain },
  });
  const sessions = new SessionRegistry('overflow');
  const detach = attachSession(sessions);
  let rejected: unknown = null;
  try {
    for (let index = 0; index < invocations; index += 1) {
      await agent.invoke(toAgentInvocation(`第 ${index + 1} 句。${PAD}`), {
        configurable: { thread_id: 'overflow' },
      });
    }
  } catch (caught) {
    rejected = caught;
  } finally {
    detach();
    await dispose();
  }
  // 摘要真的寫出了歷史：看日誌上那顆 `compaction/summary` 的 `filePath`（`null` ＝ 沒寫成功）。
  // 以前讀的是工作區裡的 `conversation_history/`，#348 之後歷史不落在那裡了。
  const events = sessions.root.events;
  const historyFiles = events
    .filter((event) => event.type === 'compaction/summary')
    .map((event) => (event.data as { filePath: string | null }).filePath)
    .filter((path): path is string => path !== null);
  return { rejected, calls: model.calls, historyFiles, events };
}

describe('供應商回上下文溢出', () => {
  /**
   * **go／no-go。** 第 4 次呼叫拋 `ContextOverflowError`：前三次各自留下一問一答，
   * 所以第 4 次進來時訊息串夠長，`retainTokens: 12`（尾巴只留一兩則）算得出正的切點。
   *
   * 這條綠 ＝ 錯誤真的沿著 `cause` 鏈到得了 `isContextOverflow`，基座的緊急摘要接住了它。
   */
  it('拋 ContextOverflowError → 整場活下來，而且真的摘要了一次', async () => {
    const { rejected, calls, historyFiles } = await runUntilThrow(
      new ContextOverflowError('Input exceeded the model context window.'),
      4,
      4,
    );

    expect(rejected).toBeNull();
    // 第 4 次拋掉，恢復又叫了至少一次（產摘要）＋ 重試那一次。
    expect(calls).toBeGreaterThan(4);
    // 摘要真的落了地——「活下來」若是靠別的路徑，這裡會是空的。
    expect(historyFiles.length).toBeGreaterThan(0);
  });

  /**
   * **會話統計的偏離，釘成一個決定**（[#266](https://github.com/DemianLi/nexus-agent/issues/266)，
   * 見 `packages/nexus-core/src/model-calls.ts` 的「偏離」一節）：起訖紀錄器在摘要器裡面，
   * 所以溢出的那一次與重試的那一次各落一對起訖——四次模型節點，**五步**。摘要那次呼叫不經過
   * 內層，不算。哪天有人把它「修」成四步或六步，這一條會紅，逼他回去改那一節。
   */
  it('溢出那一次算兩步，產摘要的那次呼叫不算', async () => {
    const { rejected, calls, events } = await runUntilThrow(
      new ContextOverflowError('Input exceeded the model context window.'),
      4,
      4,
    );

    expect(rejected).toBeNull();
    const { steps } = deriveSessionStats(events);
    expect(steps).toBe(5);
    // 模型本身被叫了六次：三次正常、溢出一次、摘要一次、重試一次。差的那一次就是摘要。
    expect(calls - steps).toBe(1);
  });

  /**
   * **預算觸發的摘要只算一步**（[#588](https://github.com/DemianLi/nexus-agent/issues/588)）：`tokens` 門檻超過時，
   * 摘要器那一層拋一顆合成的 `ContextOverflowError` 讓基座走同一條緊急摘要——但拋在內層 `handler` 之前，起訖
   * 紀錄器根本沒被叫到。跟上一條相反：那條的溢出是真的送出去、失敗了的請求。
   *
   * 門檻壓到 1，第 2 次起每一次都超過（第 1 次只有一則，切不出東西）。模型不拋。
   */
  it('預算觸發的摘要不多算一步：步數等於呼叫次數，多出來的都是產摘要的那幾次', async () => {
    const { rejected, calls, events } = await runUntilThrow(null, 0, 4, [
      { type: 'tokens', value: 1 },
    ]);

    expect(rejected).toBeNull();
    const summaries = events.filter((event) => event.type === 'compaction/summary').length;
    // 前提：第 2、3、4 次都真的摘要了。
    expect(summaries).toBe(3);
    const { steps } = deriveSessionStats(events);
    expect(steps).toBe(4);
    expect(calls - steps).toBe(summaries);
  });

  /**
   * **對照組：認錯型別就不該接。** 普通的 `Error` 一路往外拋，整場倒。
   *
   * 沒有這一條的話，一個「什麼錯都吞掉」的實作在上面那條是綠的——而那種實作會把
   * 真正的 bug 變成一次無聲的重試。
   */
  it('拋普通 Error → 照樣殺掉整場', async () => {
    const { rejected } = await runUntilThrow(new Error('別的毛病'), 4, 4);

    expect(rejected).not.toBeNull();
    expect(String(rejected)).toContain('別的毛病');
  });

  /**
   * **`cause` 鏈是真的在走，不是只認最外層那顆。**
   *
   * 這一條釘住 `isContextOverflow` 的 `for(;;)` 迴圈：把 `ContextOverflowError` 埋在
   * 一個普通 `Error` 的 `cause` 底下，基座照樣要認得。它同時是我們之後要做的
   * brand-and-rethrow 的前提——那一層包出來的東西正是這個形狀。
   */
  it('埋在 cause 底下的 ContextOverflowError 照樣認得', async () => {
    const buried = new Error('400 Bad Request', {
      cause: new ContextOverflowError('Input exceeded the model context window.'),
    });
    const { rejected, historyFiles } = await runUntilThrow(buried, 4, 4);

    expect(rejected).toBeNull();
    expect(historyFiles.length).toBeGreaterThan(0);
  });
});

/**
 * **端點真的回超窗：緊急摘要不保留尾巴**（[#1381](https://github.com/DemianLi/nexus-agent/issues/1381)，dsh
 * `compaction-basic/src/index.ts:262`、`:294`：overflow 繞過保留政策、`selectCompactableRange(..., 0)`）。
 *
 * 沒有型錄時保留量退到 20 則，4 句話才 8 則，**尾巴原本蓋住全部**：照保留量算沒有東西可摘，基座只能把同一個請求
 * 再送一次（端點已經說裝不下了）。retain 0 之後，端點超窗那一次照樣摘要、只留最新一則。
 * 對照是預算層合成的超窗（上面「尾巴蓋住全部」那條）：我們自己的門檻到了不繞過保留量。
 */
describe('端點超窗：retain 0', () => {
  it('尾巴蓋住全部時端點回超窗：仍然摘要一次，歷史檔落了地，整場活下來', async () => {
    const { rejected, calls, historyFiles, events } = await runUntilThrow(
      new ContextOverflowError('Input exceeded the model context window.'),
      4,
      4,
      undefined,
      undefined,
      {},
    );

    expect(rejected).toBeNull();
    // 三次正常、溢出一次、摘要一次、摘要之後重送一次。
    expect(calls).toBe(6);
    expect(historyFiles.length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'compaction/summary')).toHaveLength(1);
  });
});

/**
 * **門檻到了但尾巴蓋住全部：整棵樹什麼都不多做**（#1374；單元級的在 `summary-failure.test.ts`）。
 * 沒有型錄時保留量退到 20 則，4 句話才 8 則——訊息數門檻 3 到了，沒有東西可摘。
 * 每一步都會遇到這種情況，所以不多叫一次摘要模型、不記 `compaction/summary`。
 */
describe('尾巴蓋住全部', () => {
  it('訊息數門檻到了、沒有可摘的東西：模型只被叫 4 次，日誌上沒有壓縮事件', async () => {
    const { rejected, calls, events, historyFiles } = await runUntilThrow(
      null,
      0,
      4,
      [{ type: 'messages', value: 3 }],
      undefined,
      {},
    );
    expect(rejected).toBeNull();
    expect(calls).toBe(4);
    expect(historyFiles).toEqual([]);
    expect(events.filter((event) => event.type === 'compaction/summary')).toEqual([]);
  });
});

/**
 * **生摘要那次呼叫壞掉時，整場怎麼走**（[#1374](https://github.com/DemianLi/nexus-agent/issues/1374)，單元級的釘在
 * `packages/nexus-core/src/summary-failure.test.ts`；這裡走整棵樹，確認走到的是同一個處理）。
 *
 * 照 dsh `compaction-basic`：我們自己的門檻觸發 ＝ pressure（warn、照原請求送出）；端點真的回超窗 ＝ overflow
 * （warn、保留原本的請求錯誤）。
 */
describe('摘要那次呼叫失敗', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 沿 `cause` 鏈找：每顆 middleware 包一層 `MiddlewareError`，原錯誤埋得很深，不設深度上限。 */
  const chainHas = (error: unknown, predicate: (candidate: unknown) => boolean): boolean => {
    const seen = new Set<unknown>();
    for (let current: unknown = error; typeof current === 'object' && current !== null;) {
      if (seen.has(current)) return false;
      if (predicate(current)) return true;
      seen.add(current);
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  };

  it('端點真的回超窗、摘要又壞了：整場拋的是原本那個超窗，不是摘要的錯；warn 一條，不再重送', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rejected, calls } = await runUntilThrow(
      new ContextOverflowError('Input exceeded the model context window.'),
      4,
      4,
      undefined,
      { call: 5, error: new Error('摘要模型當場炸了') },
    );

    expect(rejected).not.toBeNull();
    expect(chainHas(rejected, (candidate) => candidate instanceof ContextOverflowError)).toBe(true);
    // 摘要的錯被記在 warn 上，沒有換掉要還給使用者的那個錯。
    expect(String(rejected)).not.toContain('摘要模型當場炸了');
    // 三次正常、溢出一次、摘要一次——恢復不再重送原請求，因為端點已經說裝不下了。
    expect(calls).toBe(5);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes('保留原本的請求錯誤'))).toHaveLength(1);
    expect(lines.join('\n')).toContain('摘要模型當場炸了');
  });

  it('我們自己的預算門檻觸發、摘要壞了：warn 一條，照原請求往下走，整場不倒', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 門檻壓到 1：第 2 次起每次都要摘要。第 2 次的摘要（整體第 2 次呼叫）壞掉，第 3、4 次的摘要正常。
    const { rejected, calls, events } = await runUntilThrow(
      null,
      0,
      4,
      [{ type: 'tokens', value: 1 }],
      { call: 2, error: new Error('摘要模型當場炸了') },
    );

    expect(rejected).toBeNull();
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes('照原請求送出'))).toHaveLength(1);
    expect(lines.join('\n')).toContain('摘要模型當場炸了');
    // 第 2 次摘要壞了沒有留下 compaction/summary；第 3、4 次各一筆。
    expect(events.filter((event) => event.type === 'compaction/summary')).toHaveLength(2);
    // 4 次模型節點 ＋ 3 次摘要呼叫（含壞掉的那次）。
    expect(calls).toBe(7);
  });
});
