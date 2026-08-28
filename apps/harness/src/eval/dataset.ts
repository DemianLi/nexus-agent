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
 * ## 兩批，分界在「難的地方在哪一欄」
 *
 * 前三條（`echo-once` / `echo-then-write` / `write-then-read`）由淺入深：單一工具、
 * 兩個工具且有順序、工具之間有資料相依。**它們已經分不出高下了** —— #84 量到 20B 到
 * 550B 五個橫階在這三條上工具成功率與參數正確性全部是 `1.00`。
 *
 * 後四條是為了讓那兩欄重新有解析度而加的，而且**難的地方刻意放在參數**：同一份 #84
 * 的資料裡，工具名字那一欄五階全平，參數那一欄卻在 11B 掉到 `0.19` —— 有動態範圍的是
 * 參數，不是步數。所以「多加幾步」只佔一條，其餘三條考的是參數要一字不差、要是前一步
 * 輸出的**變換**而不是複製、以及該不該叫工具。
 *
 * ## 加題目的規矩
 *
 * 評分器與 runner 都不必動，但有三件事會咬人：
 *
 * 1. **往後面加，不要插在中間。** `eval.test.ts` 的 saboteur 那條靠 id 找題目就是為了
 *    這個，但別的地方未必。
 * 2. **`args` 只列你真的要判的鍵**（見 {@link ExpectedToolCall.args}）。`content` 這種
 *    容易差一個換行的鍵，只有在題目把字串明著寫死時才列。
 * 3. **一題只該有一條正確路徑。** 模型走了個更聰明的捷徑卻被 `align` 判成沒叫，那是
 *    判準太窄，不是模型錯。做不到就把題目講死（例如明著說「用 grep 找」）。
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
  {
    id: 'edit-after-read',
    // **參數精確度那一條的主力。** `edit_file` 的 `old_string` 要一字不差地重現剛讀到的
    // 內容，中文標點也算 —— 這是 #84 那份資料裡唯一有動態範圍的那一欄，而且它跟「會不會
    // 叫工具」完全分開。
    prompt:
      '把「第一版：接線測試」寫進 /benchmark.md，讀回來確認，' +
      '然後只把「第一版」這三個字改成「第二版」，其餘一個字都別動。' +
      '改完把檔案現在的完整內容念給我聽。',
    expected: {
      toolCalls: [
        { name: 'write_file', args: { file_path: BENCHMARK_FILE, content: '第一版：接線測試' } },
        { name: 'read_file', args: { file_path: BENCHMARK_FILE } },
        {
          name: 'edit_file',
          args: { file_path: BENCHMARK_FILE, old_string: '第一版', new_string: '第二版' },
        },
      ],
      mentions: ['第二版：接線測試'],
    },
  },
  {
    id: 'reverse-round-trip',
    // 正確的參數是前一步輸出的**變換**，不是複製。前三條裡每一個工具參數都能從題目直接
    // 抄過去，所以「照抄」跟「真的做了那件事」在分數上分不開；這一條把它們分開。
    // 目標字串沒有換行也沒有標點，所以逐字比對量的是模型，不是我們對換行的假設。
    prompt:
      '把「nexus-agent」寫進 /word.md，讀回來，' +
      '然後把讀到的那串字元順序整個倒過來，寫進 /reversed.md。' +
      '最後告訴我倒過來之後長什麼樣。',
    expected: {
      toolCalls: [
        { name: 'write_file', args: { file_path: '/word.md', content: 'nexus-agent' } },
        { name: 'read_file', args: { file_path: '/word.md' } },
        { name: 'write_file', args: { file_path: '/reversed.md', content: 'tnega-suxen' } },
      ],
      mentions: ['tnega-suxen'],
    },
  },
  {
    id: 'grep-across-files',
    // 唯一一條「多加幾步」的題（四個工具、跨兩個檔案），順便讓 `grep` 這個從來沒被碰過的
    // 內建工具進場。題目明著說「用 grep 找」是刻意的：不講死的話，直接憑記憶回答
    // 「在 /b.md」是個合理的捷徑，而 `align` 會把它記成沒叫工具 —— 那是判準太窄。
    prompt:
      '建立兩個檔案：/a.md 內容是「甲」，/b.md 內容是「乙」。' +
      '然後用 grep 找出「乙」出現在哪個檔案裡，把檔名告訴我。',
    expected: {
      toolCalls: [
        { name: 'write_file', args: { file_path: '/a.md', content: '甲' } },
        { name: 'write_file', args: { file_path: '/b.md', content: '乙' } },
        { name: 'grep', args: { pattern: '乙' } },
      ],
      mentions: ['/b.md'],
    },
  },
  {
    id: 'no-tool-needed',
    // **克制。** 期望零筆呼叫，所以工具成功率與參數正確性在這一條是 `undefined`
    // ——「沒有可判的」不該被平均（見 `scorers.ts`）。它的訊號整個落在**多叫次數**上。
    //
    // 別把它讀太重：#84 只有 11B 那個對照組會亂叫（平均 7.17 次），20B 以上本來就克制。
    // 而且七題平均之後，這一條叫 0 次或 2 次只動得了總平均 0.3 —— 要看它得看
    // CLI 逐次那一行，不是彙總那一欄。
    prompt: '這題不需要任何工具，也不要建立檔案。直接用一句話回答我：3 加 4 等於多少？',
    expected: {
      toolCalls: [],
      mentions: ['7'],
    },
  },
];

/**
 * 前幾條是「已經分不出高下」的那一批。分界在第三條之後 —— 見檔頭「兩批」那一段。
 *
 * 這個常數存在是因為**易題會稀釋平均**：三條簡單題在每一階上都是 `1.00`，混進七題的
 * 平均之後階間差異被壓縮，看起來像判準又飽和了。報表要能把兩批分開印，那個分界就不能
 * 只活在檔頭的散文裡。
 */
export const EASY_CASE_COUNT = 3;

/** 有解析度的那四條。報表的第二組數字算在這上面。 */
export const HARD_CASES: readonly BenchmarkCase[] = BENCHMARK.slice(EASY_CASE_COUNT);

/** 已經飽和的那三條。留著跑是因為「連這個都做不到」仍然是資訊。 */
export const EASY_CASES: readonly BenchmarkCase[] = BENCHMARK.slice(0, EASY_CASE_COUNT);
