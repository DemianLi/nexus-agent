/**
 * 基準任務資料集 —— 開發計劃第 5 節 Phase 5 `feat/eval-suite`，補強項 3。
 *
 * **這份資料是供應商中立的**：只有「說什麼」與「該做到什麼」，沒有任何一個字綁到
 * 模型、腳本或假模型。CI 那半用 `ScriptedChatModel` 跑它，供應商比較那半換一個
 * model 進 {@link runBenchmarkCase} 就是同一份資料 —— 兩邊比的東西才是同一個。
 *
 * 形狀刻意**不是** LangSmith 的 `Example`。`evaluate()` 一定連外（見開發計劃 Phase 5），
 * 這張 PR 因此沒有 `evaluate()` 的編排；把資料集長成它的形狀只會多出一層沒人執行的
 * 轉換。要接上去時 `Example` 的 `inputs` / `outputs` 兩個鍵一對一蓋得回來。
 */

/** 期望的一次工具呼叫。 */
export interface ExpectedToolCall {
  readonly name: string;
  /**
   * 期望的參數，**逐鍵比對，只比列出來的鍵**。
   *
   * 列全部的話，模型多帶一個無害的可選參數就會被判成錯 —— 那不是參數錯誤，是我們的
   * 判準太窄。少列的鍵一律不看。
   */
  readonly args: Readonly<Record<string, unknown>>;
}

/** 一條基準任務。 */
export interface BenchmarkCase {
  /** 穩定的識別字，`ls.test` 的名字與回饋都掛在它上面。 */
  readonly id: string;
  /** 對 agent 說的那句話。 */
  readonly prompt: string;
  /** 這句話該換來的行為。 */
  readonly expected: {
    /** 該發生的工具呼叫，**順序有意義**：先回聲再寫檔與反過來不是同一件事。 */
    readonly toolCalls: readonly ExpectedToolCall[];
    /** 最終那段回覆裡必須出現的字串。省略即不看回覆內容。 */
    readonly mentions?: readonly string[];
  };
}

/** 這次寫進虛擬 FS 的檔名。絕對路徑 —— 基座的檔案工具只收絕對路徑。 */
export const BENCHMARK_FILE = '/benchmark.md';

/**
 * 基準任務。
 *
 * 三條刻意由淺入深：單一工具、兩個工具且有順序、工具之間有資料相依（寫進去的內容
 * 要再讀回來）。要加題目就往這裡加 —— 評分器與 runner 都不必動。
 */
export const BENCHMARK: readonly BenchmarkCase[] = [
  {
    id: 'echo-once',
    prompt: '把「接線測試」這句話回聲一次。',
    expected: {
      toolCalls: [{ name: 'echo', args: { message: '接線測試' } }],
      mentions: ['接線測試'],
    },
  },
  {
    id: 'echo-then-write',
    prompt: '把「接線測試」回聲一次，然後把回聲的結果寫進 /benchmark.md。',
    expected: {
      toolCalls: [
        { name: 'echo', args: { message: '接線測試' } },
        { name: 'write_file', args: { file_path: BENCHMARK_FILE } },
      ],
    },
  },
  {
    id: 'write-then-read',
    prompt: '把「第二次」寫進 /benchmark.md，然後讀回來告訴我裡面是什麼。',
    expected: {
      toolCalls: [
        { name: 'write_file', args: { file_path: BENCHMARK_FILE, content: '第二次' } },
        { name: 'read_file', args: { file_path: BENCHMARK_FILE } },
      ],
      mentions: ['第二次'],
    },
  },
];
