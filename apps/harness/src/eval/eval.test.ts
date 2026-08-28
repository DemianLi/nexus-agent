/**
 * 基準任務的 CI 那半 —— 零憑證、不連外。
 *
 * **這裡唯一是假的東西是模型。** 資料集、runner、評分器、plugin 清單、agent 組裝全部
 * 是真的跑，`ScriptedChatModel` 只負責「模型決定要呼叫哪個工具」那一步。供應商比較那半
 * 換掉的也只有這一個參數 —— 見 [`runner.ts`](./runner.ts) 與開發計劃 Phase 5。
 *
 * ## 這個檔案為什麼要自己把環境弄壞
 *
 * 計劃原本記著「`LANGSMITH_TEST_TRACKING=false` 讓它不連外」。實測是**反過來的**：
 * 不設 `LANGSMITH_TRACING` 時本來就零連外（帶不帶那支旗標、帶不帶 reporter 都一樣）；
 * 那支旗標是 `LANGSMITH_TRACING` 打開之後才開始承重的護欄。而 [#72](https://github.com/DemianLi/nexus-agent/pull/72)
 * 的 tracing 披露正是在教開發者把 tracing 打開 —— 也就是說，這個檔案的最壞情況是
 * 「開發機開著 tracing 跑 `pnpm test`」，那不是假想，是被文件鼓勵的用法。
 *
 * 所以這裡**主動 arm 那個最壞情況**（loopback 端點 ＋ `LANGSMITH_TRACING=true`），
 * 讓護欄在每次 CI 都真的承一次重。護欄沒設時實測的症狀是：發出 `POST /sessions` 與
 * `GET /datasets?...`，整個檔案失敗，而且**測試被 skip**。
 *
 * ## 判準因此是「跑了幾條」，不是「沒連外」
 *
 * 被 skip 的測試同樣不會發請求 —— 一條只看 loopback 請求數的斷言，在它要防的那個情境
 * 下照樣全綠。這與 [#79](https://github.com/DemianLi/nexus-agent/pull/79) 那個
 * `status === 'idle'` 停止條件是同一型的假綠。所以承重的是 `executed` 這個計數器。
 *
 * ## 而且「零連外」根本不成立——有兩個寄件人
 *
 * 寫這個檔案時量到的：arm 起來之後 loopback 照樣收到 `GET /info` 與 `POST /runs/multipart`。
 * 那不是 `ls.test`，是**真的 agent run** 自己的 LangChainTracer（[#72](https://github.com/DemianLi/nexus-agent/pull/72)
 * 記的「tracing 被動生效」）。兩個寄件人各有各的開關，`LANGSMITH_TEST_TRACKING` 只管得住
 * 前一個。所以 `afterAll` 分開斷言：`ls.test` 那邊零請求，agent 那邊**確實有**請求。
 */

// **在 `ls.describe` 被呼叫之前先把護欄設上。** 旗標是延遲讀取的（實測放在 import 之後
// 也生效），但順序寫成「先護欄、後危險」才看得出這裡在防什麼。
process.env.LANGSMITH_TEST_TRACKING = 'false';

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import * as ls from 'langsmith/vitest';
import { afterAll, beforeAll, expect } from 'vitest';
import { ScriptedChatModel, type ScriptedTurn } from '../scripted-model.js';
import { BENCHMARK_SYSTEM_PROMPT, benchmarkPlugins } from './assembly.js';
import { BENCHMARK, BENCHMARK_FILE, type BenchmarkCase } from './dataset.js';
import { runBenchmarkCase } from './runner.js';
import { scoreCase } from './scorers.js';

/**
 * 每條任務的假模型腳本。
 *
 * **這是這個檔案裡唯一「假」的東西**，所以刻意跟資料集分開放：資料集是供應商中立的，
 * 這裡是 CI 專用的替身。`usage` 明著給，成本那個指標才有對照組可判
 * （假模型不給時回報的是 `undefined`，不是零 —— 見 `runner.ts`）。
 */
const SCRIPTS: Readonly<Record<string, readonly ScriptedTurn[]>> = {
  'echo-once': [
    {
      content: '我來回聲。',
      toolCalls: [{ name: 'echo', args: { message: '接線測試' } }],
      usage: { inputTokens: 120, outputTokens: 18 },
    },
    { content: '回聲：接線測試', usage: { inputTokens: 150, outputTokens: 9 } },
  ],
  'echo-then-write': [
    {
      content: '先回聲。',
      toolCalls: [{ name: 'echo', args: { message: '接線測試' } }],
      usage: { inputTokens: 130, outputTokens: 20 },
    },
    {
      content: '再寫進檔案。',
      toolCalls: [
        { name: 'write_file', args: { file_path: BENCHMARK_FILE, content: '回聲：接線測試' } },
      ],
      usage: { inputTokens: 180, outputTokens: 26 },
    },
    { content: '寫好了。', usage: { inputTokens: 210, outputTokens: 7 } },
  ],
  'write-then-read': [
    {
      content: '先寫。',
      toolCalls: [{ name: 'write_file', args: { file_path: BENCHMARK_FILE, content: '第二次' } }],
      usage: { inputTokens: 140, outputTokens: 22 },
    },
    {
      content: '再讀回來。',
      toolCalls: [{ name: 'read_file', args: { file_path: BENCHMARK_FILE } }],
      usage: { inputTokens: 190, outputTokens: 16 },
    },
    { content: '裡面是「第二次」。', usage: { inputTokens: 230, outputTokens: 12 } },
  ],
  // 底下四條是後加的難題。腳本裡的 `old_string` 與寫進去的內容**真的對得上**，
  // 所以 `edit_file` 這一步是真的改成功，不是靠腳本硬撐過去 —— 這條路上工具是真的跑的。
  'edit-after-read': [
    {
      content: '先寫第一版。',
      toolCalls: [
        { name: 'write_file', args: { file_path: BENCHMARK_FILE, content: '第一版：接線測試' } },
      ],
      usage: { inputTokens: 150, outputTokens: 24 },
    },
    {
      content: '讀回來確認。',
      toolCalls: [{ name: 'read_file', args: { file_path: BENCHMARK_FILE } }],
      usage: { inputTokens: 200, outputTokens: 15 },
    },
    {
      content: '只換那三個字。',
      toolCalls: [
        {
          name: 'edit_file',
          args: { file_path: BENCHMARK_FILE, old_string: '第一版', new_string: '第二版' },
        },
      ],
      usage: { inputTokens: 260, outputTokens: 30 },
    },
    { content: '現在是「第二版：接線測試」。', usage: { inputTokens: 300, outputTokens: 14 } },
  ],
  'reverse-round-trip': [
    {
      content: '先寫原字串。',
      toolCalls: [{ name: 'write_file', args: { file_path: '/word.md', content: 'nexus-agent' } }],
      usage: { inputTokens: 150, outputTokens: 23 },
    },
    {
      content: '讀回來。',
      toolCalls: [{ name: 'read_file', args: { file_path: '/word.md' } }],
      usage: { inputTokens: 195, outputTokens: 14 },
    },
    {
      content: '倒過來再寫一份。',
      toolCalls: [
        { name: 'write_file', args: { file_path: '/reversed.md', content: 'tnega-suxen' } },
      ],
      usage: { inputTokens: 250, outputTokens: 26 },
    },
    { content: '倒過來是 tnega-suxen。', usage: { inputTokens: 290, outputTokens: 13 } },
  ],
  'grep-across-files': [
    {
      content: '先建 a。',
      toolCalls: [{ name: 'write_file', args: { file_path: '/a.md', content: '甲' } }],
      usage: { inputTokens: 150, outputTokens: 20 },
    },
    {
      content: '再建 b。',
      toolCalls: [{ name: 'write_file', args: { file_path: '/b.md', content: '乙' } }],
      usage: { inputTokens: 190, outputTokens: 20 },
    },
    {
      content: '用 grep 找。',
      toolCalls: [{ name: 'grep', args: { pattern: '乙' } }],
      usage: { inputTokens: 240, outputTokens: 18 },
    },
    { content: '在 /b.md 裡面。', usage: { inputTokens: 280, outputTokens: 11 } },
  ],
  // **一輪就結束，而且沒有工具呼叫。** 這是整份腳本裡唯一一條不碰工具的，
  // 它驗的是「該克制的時候評分器怎麼記分」——見下面那條專門的斷言。
  'no-tool-needed': [{ content: '3 加 4 等於 7。', usage: { inputTokens: 120, outputTokens: 9 } }],
};

/**
 * 壞掉的那一份：工具少叫一個、參數也寫錯。
 *
 * 它讓「評分器真的會扣分」在**端到端**這條路上也有對照組 —— `scorers.test.ts` 驗的是
 * 純函式，這條驗的是「真的跑一遍 agent、真的收集觀測值、真的算出低分」。
 */
const SABOTEUR: readonly ScriptedTurn[] = [
  {
    content: '我隨便回聲一下就好。',
    toolCalls: [{ name: 'echo', args: { message: '完全不是那句話' } }],
    usage: { inputTokens: 130, outputTokens: 20 },
  },
  { content: '做完了。', usage: { inputTokens: 160, outputTokens: 5 } },
];

/** saboteur 那條要跑的題目。兩個工具、參數明確，所以「少叫一個又寫錯」扣得乾淨。 */
const SABOTAGED_CASE = BENCHMARK.find((entry) => entry.id === 'echo-then-write');

/** 真的跑完的 `ls.test` 條數。**這是本檔的主判準**，理由見檔頭。 */
let executed = 0;

/** loopback 假端點收到的請求。附帶斷言。 */
const hits: string[] = [];
let server: Server;

beforeAll(async () => {
  server = createServer((request, response) => {
    hits.push(`${request.method} ${(request.url ?? '').split('?')[0]}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  // **順序照 `tracing.test.ts` 的規矩**：端點先釘死在 loopback 並當場驗過，
  // `LANGSMITH_TRACING` 最後才設。反過來的話，中間任何一次提早 return 都會讓
  // 一個已經開著的 tracer 指向真正的 LangSmith。
  process.env.LANGSMITH_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.LANGSMITH_API_KEY = 'ls-fake-for-test';
  // 同步送，`afterAll` 才不必跟背景 flush 賽跑（`dist/singletons/tracer.js` 把它翻成
  // `blockOnRootRunFinalization: true`）。理由與 `tracing.test.ts` 的 `armTracing` 同一條。
  process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';
  expect(process.env.LANGSMITH_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(process.env.LANGSMITH_TEST_TRACKING).toBe('false');
  process.env.LANGSMITH_TRACING = 'true';
});

/** 等到 loopback 收到第一顆 trace 為止。**斷言請求內容之前一定要先過這一關。** */
async function waitForTrace(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!hits.some((hit) => hit.endsWith('/runs/multipart')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterAll(async () => {
  delete process.env.LANGSMITH_TRACING;
  delete process.env.LANGSMITH_ENDPOINT;
  delete process.env.LANGSMITH_API_KEY;
  // 這支也要清：它在 `tracing.test.ts` 的 `TRACING_ENV` 裡，漏掉會跨檔留下。
  delete process.env.LANGCHAIN_CALLBACKS_BACKGROUND;

  try {
    await assertTripwires();
  } finally {
    // **server 最後才關。** 關掉之後才到的請求進不了 `hits`，那會讓下面兩條斷言
    // 一條假綠、一條假紅。
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function assertTripwires(): Promise<void> {
  // 主判準：每一條都真的跑過。少一條就代表它被 skip 了，而 skip 是靜默的。
  // **這條不必等 flush**，所以先斷言它——它紅的時候，下面兩條說什麼都不重要。
  expect(executed).toBe(BENCHMARK.length + 1);

  // 請求內容的斷言要等東西真的到齊，否則「零請求」在什麼都還沒送出去時同樣成立。
  await waitForTrace();

  // **`ls.test` 那個寄件人閉著嘴**——護欄沒設時它會發這兩個。
  expect(hits.filter((hit) => hit.includes('/sessions') || hit.includes('/datasets'))).toEqual([]);

  // **但底下那個 agent run 有自己的寄件人，而且是另一個開關。** `LANGSMITH_TRACING=true`
  // 時 `CallbackManager.configure` 會替真的 agent run 掛上 LangChainTracer（[#72](https://github.com/DemianLi/nexus-agent/pull/72)
  // 記的那條「tracing 是被動生效的」），它跟 `LANGSMITH_TEST_TRACKING` 一點關係都沒有。
  // 實測：四條任務跑完，loopback 收到 `GET /info` 與（批次過的）`POST /runs/multipart`。
  // → 這條斷言把「兩個寄件人、兩個開關」釘住。它紅了代表兩者被合併了，那時上面那條
  //   零連外的期待要重新想過。**也是 CI 不得設 `LANGSMITH_TRACING` 的理由**：這個套件
  //   跑的是真的 agent，基準任務的題目與工具參數會跟著 trace 一起出境。
  expect(hits.some((hit) => hit.endsWith('/runs/multipart'))).toBe(true);
}

/** 跑一條，記分，順手把三個指標當回饋掛上去。 */
async function evaluateCase(
  testCase: BenchmarkCase,
  turns: readonly ScriptedTurn[],
): Promise<ReturnType<typeof scoreCase>> {
  const run = await runBenchmarkCase(testCase, {
    model: new ScriptedChatModel({ turns }),
    plugins: benchmarkPlugins(),
    systemPrompt: BENCHMARK_SYSTEM_PROMPT,
  });
  const score = scoreCase(testCase, run);

  // `undefined` 的那幾格**不記**：記成 0 會在 LangSmith 那邊被讀成「這題全錯」。
  if (score.toolCallSuccess !== undefined) {
    ls.logFeedback({ key: 'tool_call_success', score: score.toolCallSuccess });
  }
  if (score.argumentCorrectness !== undefined) {
    ls.logFeedback({ key: 'argument_correctness', score: score.argumentCorrectness });
  }
  ls.logFeedback({ key: 'extra_tool_calls', score: score.extraToolCalls });
  if (score.mentions !== undefined) ls.logFeedback({ key: 'mentions', score: score.mentions });
  // 成本不是分數（見 `scorers.ts`），但它是供應商比較要的那一欄，所以照樣記下來。
  if (score.cost !== undefined) {
    ls.logFeedback({ key: 'total_tokens', score: score.cost.totalTokens });
  }

  executed += 1;
  return score;
}

ls.describe('基準任務（假模型）', () => {
  for (const testCase of BENCHMARK) {
    ls.test(
      testCase.id,
      {
        inputs: { prompt: testCase.prompt },
        referenceOutputs: { toolCalls: testCase.expected.toolCalls.map((call) => call.name) },
      },
      async () => {
        const turns = SCRIPTS[testCase.id];
        expect(turns, `${testCase.id} 沒有腳本`).toBeDefined();
        const score = await evaluateCase(testCase, turns ?? []);

        // **兩支要分開斷言，不能只寫 `toBe(1)`。** 期望零筆呼叫的題目在這兩欄是
        // 「沒有可判的」而不是滿分（見 `scorers.ts`）；把它們寫成 1 的話，
        // 那個把空格填成滿分的舊行為會靜靜地全綠回來。
        if (testCase.expected.toolCalls.length === 0) {
          expect(score.toolCallSuccess).toBeUndefined();
          expect(score.argumentCorrectness).toBeUndefined();
        } else {
          expect(score.toolCallSuccess).toBe(1);
          expect(score.argumentCorrectness).toBe(1);
        }
        expect(score.extraToolCalls).toBe(0);
        if (testCase.expected.mentions !== undefined) expect(score.mentions).toBe(1);
        // 成本一定量得到——假模型每一輪都給了 `usage`，基座把它原封帶到最終狀態。
        expect(score.cost?.totalTokens).toBeGreaterThan(0);
      },
    );
  }

  ls.test(
    'saboteur：真的跑一遍也扣得到分',
    {
      inputs: { prompt: SABOTAGED_CASE?.prompt ?? '' },
      referenceOutputs: { note: '這一條期望低分' },
    },
    async () => {
      // **用 id 查，不用位置。** 這條寫死 `BENCHMARK[1]` 的話，往資料集中間插一條題目
      // 就會讓底下三個數字換一個意思繼續全綠 —— 那比紅掉難查得多。
      expect(SABOTAGED_CASE, 'saboteur 的題目不見了').toBeDefined();
      const score = await evaluateCase(SABOTAGED_CASE as BenchmarkCase, SABOTEUR);

      // 兩個工具只叫了一個，而且那一個的參數還是錯的。
      expect(score.toolCallSuccess).toBe(0.5);
      expect(score.argumentCorrectness).toBe(0);
      expect(score.extraToolCalls).toBe(0);
    },
  );
});
