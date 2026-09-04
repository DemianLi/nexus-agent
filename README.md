# nexus-agent

TypeScript + React (shadcn/ui) 專案，架構分為 harness 與 web UI 兩部分。

## 專案結構

```
packages/nexus-core          NexusPlugin 契約：型別、manifest、PluginRegistry、fold
packages/nexus-plugin-commands  人打的斜線命令：解析、執行、生命週期記日誌
packages/nexus-plugin-echo   最小 plugin 範例，只相依 @nexus/core
packages/nexus-plugin-goal   一個會話的長期目標：狀態、CAS 變更、續行授權，加上 /goal
packages/nexus-plugin-mcp    把 MCP server 的工具接進 registry
packages/nexus-plugin-quickjs  QuickJS 沙箱裡跑 JavaScript 的 custom tool
packages/nexus-plugin-memory 把 AGENTS.md 這類長期記憶掛進 agent
packages/nexus-plugin-plan-mode  計劃模式：先探索再執行，計劃交出去等人批准
packages/nexus-plugin-skills 把 SKILL.md 這類隨選工作流掛進 agent
packages/nexus-plugin-validation  工具輸出 schema 校驗
apps/harness                 組裝點：agent 工廠、訊息標準化、CLI（Node / TypeScript）
apps/web                     Vite + React 19 + Tailwind v4 + shadcn/ui
```

pnpm workspace，Node >= 22。

## 開發

```bash
pnpm install
pnpm dev          # 啟動 web（http://localhost:5173）
pnpm lint         # eslint（遞迴全部套件）
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm build        # vite build
```

跟 agent 說話（`apps/harness` 的 CLI）：

```bash
pnpm --filter @nexus/harness run cli "把這句話回聲一次。"   # 一次性，跑完就退出
pnpm --filter @nexus/harness run cli                        # REPL，/help 看命令，/exit 結束
pnpm --filter @nexus/harness run cli:live "..."             # 換成真實供應商，需要 API key
```

預設走寫死腳本的假模型，不需要任何 key —— 那條路徑驗的是接線，不是模型。
真正要試 agent 行為時用 `cli:live`。`--plugins <module>` 可以換掉預設的 plugin 清單
（模組 `export default` 一個陣列）。

**agent 迴圈有上限，而那個上限是組裝點設的不是基座設的。** `createDeepAgent` 自己把
`recursionLimit` 設成 `1e4`（約 5,000 輪模型呼叫，等於沒有上限），所以
`createNexusAgent` 蓋成 100（約 49 輪）。CLI、`serve`、eval 都吃這個值；真的需要更長的
呼叫端自己傳 `recursionLimit`。這條擋的是「跑掉了」，不是「複雜任務」。

在瀏覽器裡跟 agent 說話，要開兩個 terminal：

```bash
pnpm --filter @nexus/harness run serve      # agent 掛上 HTTP（http://127.0.0.1:8787）
pnpm dev                                    # web（http://localhost:5173）
```

`serve` 的組裝與 CLI 完全一樣（同一份預設 plugin 清單、同一個 `--live`、同一個
`--workspace`），只是把 agent 掛上 HTTP。dev server 會把 `/threads` 轉給它，所以
瀏覽器那端是同源的、不需要 CORS；harness 換了 port 就設 `NEXUS_AGENT_URL`。
`serve` 也吃 `--live`（或直接 `run serve:live`）—— 假模型的腳本只有四輪，問到第三句
就會用完，畫面上會紅字說是為什麼。

要在瀏覽器裡跑到核准那一段，換一份把工具標成要核准的清單：

```bash
pnpm --filter @nexus/harness run serve --plugins src/approval.fixture.ts
```

預設清單不觸發任何中斷，所以核准的按鈕沒有東西可按。這一份把 `echo` 與 `write_file`
標起來，假模型的腳本正好兩個都會呼叫 —— 一條對話會停兩次，核准或拒絕都繼續得下去。
**介面一批只送一個決定**（`uniformDecisions`）：逐筆按是介面還沒做，不是底下擋著。

**而 `serve` 是三個入口裡唯一會停下來的那個。** CLI 與 eval 收不了核准決定，所以它們
把核准關掉（`HEADLESS_APPROVALS`）—— 需要核准的工具拿到一則說明是「沒有人被問到」的
拒絕，其餘照跑完，而不是整輪停在那裡等一個不會來的答案。CLI 每次啟動都會把這件事印在
banner 上。web 這端真的按得下去，所以它維持開著。

### 計劃模式

`@nexus/plugin-plan-mode` 讓 agent 先探索與設計、把完整的計劃交出去等人批准，再開始動手。
形狀照 dsh 的 `plan-mode`：一段模式生效時才夾進 system prompt 的**部署持有的指引**、
一個 `exit_plan_mode` 工具，加上一份**跟著 checkpointer 走的模式狀態**。

**它預設是關的，開關是 `/plan`。** 這個 plugin 在 CLI 的預設清單裡，所以 REPL 裡直接打：

| 這一行 | 做什麼 |
| --- | --- |
| `/plan` | 進計劃模式。**從下一輪起**指引才夾進 system prompt |
| `/plan off` | 離開 |
| 其餘參數 | 回一則錯誤。**不會被當成「進入」** —— `/plan of` 安靜地做相反的事是最貴的那種缺陷 |

dsh 的 `/plan` 還收一段自由訊息（`[off|message]`），用 `agent.steer()` 插進對話；
我們沒有那條路，所以提示是 `[off]`，收不下的東西不寫進提示。命令改的是 graph state，
而 state 只有 invoke 期間寫得動 —— 選擇先存在 plugin 裡，由 middleware 的 `beforeAgent`
在下一輪開頭交出去。細節與這兩條偏離的代價寫在 `packages/nexus-plugin-plan-mode/src/index.ts`
的檔頭。

要讓一份組裝一開始就在計劃模式裡，用工廠的 `startActive`：

```ts
createPlanModePlugin({ startActive: true, guidance: '（部署自己寫的那一段）' })
```

**但預設清單不必換。** `serve` 那條線上有命令介面了（[#123](https://github.com/DemianLi/nexus-agent/issues/123)），
web 那端自己打 `/plan` 就進得去：

```bash
pnpm --filter @nexus/harness run serve:live
```

**`serve` 才是走得完整條路的地方，而且要 `--live`。** `exit_plan_mode` 是需要核准的工具，
CLI 與 eval 走 `HEADLESS_APPROVALS`：在那裡提出的計劃會被確定性拒絕 —— CLI 上還打得出
`/plan off` 自己爬出來，web 上按得下批准。假模型的腳本另外寫死在 `cli.ts`，它不會呼叫
`exit_plan_mode` —— 換清單改不了模型的腳本，所以「規劃 → 交計劃 → 有人按批准 → 開始動手」
要真模型。

模式沒啟用時，`exit_plan_mode` 仍留在工具目錄裡（照 dsh：狀態轉換不該順帶改變工具目錄），
但它的執行路徑會拒絕 —— 回的是「不在計劃模式」，不是核准的措辭。

### 長期目標

`@nexus/plugin-goal` 讓一個會話記得住一個跨很多輪的目標：**事件溯源的耐久狀態**
（`goal/change` 帶著整份快照）、**CAS 變更**（改之前要拿對修訂號），與 process 內
的續行授權。形狀照 dsh 的 `packages/goal/`。

**它在 CLI 的預設清單裡，開關是 `/goal`。** 六種輸入：

| 這一行 | 做什麼 |
| --- | --- |
| `/goal` | 印出目前的目標、相位、輪次與上限、續行授權，與**現在打得動的命令** |
| `/goal <目標>` | 建一個目標並授權續行；完成掉的目標可以直接被換掉 |
| `/goal edit <目標>` | 改敘述，**不動相位也不動授權** |
| `/goal pause` | 暫停進行中的目標並收回授權 |
| `/goal resume` | 把停住的接回來，或替續上的 session 重新授權 |
| `/goal clear` | 清掉目前的目標，**歷史留著** |

**控制詞只有填滿整串輸入時才算控制詞**：`/goal pause after verification` 建的是
「pause after verification」這個字面目標。照抄 dsh 的文法，理由是這個命令主要用來打
一句話，而一句話很可能以控制詞開頭。

dsh 那邊 `/goal` 還收圖片附件，我們沒有——`CommandInvocation` 沒有 `attachments`，
整條水管不存在，所以提示字串裡也不寫圖片。dsh 另外有面向模型的 `tool-goal` 與自動
續行的 `goal-round-driver`，兩個都不在這一版：前者被工具執行期讀不到呼叫者血緣擋住，
後者是 dsh 自己標成可選的消費方。細節與每一條偏離的代價寫在
`packages/nexus-plugin-goal/src/index.ts` 的檔頭。

web 那條也打得到，而且**每條 thread 各有各的目標**——`serve.ts` 一個 thread 一個
agent，所以一份 registry 一份會話日誌。

### 人的命令

`@nexus/plugin-commands` 是**人打的斜線命令**那條路：`registry.commands.register()` 註冊，
進入點解析並發派，**不經過模型**。形狀照 dsh 的 `dsh-commands`。

```ts
registry.commands.register({
  name: 'ping',
  description: '回一句話，不驚動模型',
  input: { hint: '[任何字]' },
  handler: ({ rawInput }) => ({ kind: 'success', text: `pong${rawInput}` }),
});
```

一行 `/name` 有四條路，**最後一條跟接上命令之前一模一樣**：

| 這一行 | 去哪裡 |
| --- | --- |
| 註冊過的命令 | 跑 handler，結果印給人看（`error` 進 stderr） |
| `/help`（後面的字忽略） | 印出命令清單。**不留日誌，也不驚動模型** |
| `/exit` | 收工 |
| 其餘（語法不符、名字不認得） | 照原樣送給模型 |

**`/exit` 與 `/help` 刻意不是命令**：它們控制／描述的是這條 REPL，不是 agent，所以
`commands.list()` 裡沒有它們，`/help` 自己把這兩行補進清單。dsh 也是這樣切的——它
**根本沒有 `/help`**，探索面是 web composer 打 `/` 跳出來的候選選單，資料來源同樣是
`commands.list()`；dsh 自己的 CLI 則一個命令發派面都沒有。我們照抄的是真相來源，換掉
的是呈現形式（一行一行的 `readline`，不是 composer）。

因為 REPL 在執行器之前攔這兩個名字，**plugin 註冊了 `help` 或 `exit` 會在 REPL 開起來
時當場拋**——那份註冊本來永遠不會被叫到，而且沒有徵兆。

認得的命令會在會話日誌留下一對 `command/run` / `command/done`；**收不下的行不留痕跡**。
`@nexus/plugin-commands` 的不變量配套入口檢查這一對的三條關係（id 不重複、一次一個、
done 配得到 run）——**這是全樹第一個非空的 package 配套入口**。

命令的**文法**則歸擁有它的 package：`@nexus/plugin-plan-mode` 的配套入口檢的是
「`/plan` 的參數收不下時，配對的 `command/done` 必須是 `error`」。生命週期那份不知道
`plan` 的文法長什麼樣，所以那一條只有這裡檢得到。

`command/run` 的 `args` 是使用者原話，而會話事件會**原樣鏡像進遙測**。要把使用者輸入
擋在遙測外，得補 dsh 那個 `recordInput` 開關；這一版沒有它。

跑基準任務（eval）：

```bash
pnpm --filter @nexus/harness exec vitest run src/eval
```

資料集在 `apps/harness/src/eval/dataset.ts`，評分器在 `scorers.ts`，跑一條任務的
runner 在 `runner.ts`。**model 是 runner 的參數**，所以 CI 這條（假模型、零憑證、
不需要任何 key）與換上真實供應商的那條跑的是同一份資料、同一組評分器。

**七條題目分兩批。** 前三條由淺入深（單一工具 → 兩個工具且有順序 → 工具之間有資料相依），
後四條是為了讓分數重新有解析度而加的，**難處刻意放在參數**：`edit_file` 的 `old_string`
要一字不差重現剛讀到的內容、正確的參數是前一步輸出的**變換**而不是複製、以及一條
「該克制就別叫工具」的題。挑這個方向是因為量到的資料就長這樣 —— 工具名字那一欄大家都對，
參數那一欄才分得出高下。

**「沒有可判的」一律是 `undefined`，不是 1 也不是 0。** 期望零筆工具呼叫的題目在工具與
參數兩欄沒有東西可判，填成 1 的話等於替每個模型的平均無條件送一分滿分進去 —— 加了那條
題目之後這兩欄的鑑別力反而下降，而它下降的方式看起來完全像是模型變好了。這與「模型沒回報
usage 就是 `undefined` 不是零」、「端點失敗是沒有資料不是零分」是同一條規矩。

**不要在 CI 設 `LANGSMITH_TRACING`。** eval 跑的是真的 agent，tracing 開著時基準任務的
題目與工具參數會跟著 trace 送出去 —— 那條路徑跟 `langsmith/vitest` 自己的上傳是**兩個
獨立的開關**，關掉一個不影響另一個（`src/eval/eval.test.ts` 的檔頭記著實測）。

尺寸比較（**要 key、會花錢、不進 CI**）：

```bash
pnpm --filter @nexus/harness run eval:compare --samples 2
pnpm --filter @nexus/harness run eval:compare --cases edit-after-read --samples 3
```

同一份基準任務跑**兩道階梯**，只有 model 這一個參數不同：`openai/gpt-oss-20b` → `-120b`，
以及 Nemotron-3 的 `nano-30b-a3b` / `super-120b-a12b` / `ultra-550b-a55b`。
**一道階梯 = 一個家族**，所以「只有尺寸在變」只在階梯**內部**成立；報表因此按階梯分段印，
跨階梯那條線混著訓練配方。階梯怎麼挑出來的、以及**那份清單為什麼是綁在帳號上的**
（`GET /models` 列 84 個，一把 key 通常只叫得動其中 29 個），寫在 `src/eval/tiers.ts`
的檔頭；換一把 key 要重新盤點。

`--cases` 只跑指定的題目。**成本是題數 × 階數 × 取樣數的乘積** —— 跑滿（七題 ×
六個模型 × 6 次取樣 = 252 次執行）實測是**三小時級**，不是半小時，
所以只想看某幾題時不必把整份重跑一遍。認不得的 id 一律當場拋，不默默略過。

最後還跑一個**判準對照**（`meta/llama-3.2-11b-vision-instruct`）。它**不是階梯上的一階** ——
它的同家族對照 `-90b` 三次探測全部逾時，沒有對照就沒有東西能把它的分數歸因到尺寸。
它只回答一個問題：**這組評分器量不量得出 1.00 以下的數字。**

**結論是「沒有尺寸效應」，而且它已經被三輪獨立測量確認過。** 舊的三條題目上五個橫階
全部 `1.00`，分不出高下；換成加難過的題目之後判準才有量程。三輪的參數正確性：

| 輪次 | 跑了什麼 | 每階判分數 | `oss-20b` | `oss-120b` | `nano` | `super` | `ultra` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 第一輪 | 四條難題 × 2 次 | 6 | 0.94 | 1.00 | 0.92 | 0.97 | 0.89 |
| 第二輪 | 兩條難題 × 6 次 | 12 | 0.91 | 0.92 | 0.92 | 0.98 | 0.88 |
| 第三輪 | 四條難題 × 6 次 | 18 | 0.95 | 1.00※ | 0.92 | 0.96 | 0.94 |

※ **`oss-120b` 那一格是補測的，跟同列其他四格不是同一輪。** 第三輪它 42 次執行有 21 次
被限流掉（見下），樣本不足以讀；把限流接住之後單獨重跑一次 42 次、**零失敗**，四條難題
18 個判分**全部滿分**。所以它是這五階裡唯一在難題上不掉分的 —— 但這一格與其他四格之間
多了一個變數（限流重試），並排讀要記得這件事。

**「判分數」不等於執行次數** —— `no-tool-needed` 期望零筆工具呼叫，那兩欄沒有東西可判，
所以四條難題 × 6 次是 24 次執行、18 個判分。

三輪都落在同一個窄帶裡，方向一輪一個樣。**判準沒有飽和**（全距下探到 `0.33`／`0.50`），
只是尺寸沒有在那個量程上動。

**七題全跑那一輪必須拆開讀，否則會誤判成判準又飽和了。** 三條簡單題（`echo-once` /
`echo-then-write` / `write-then-read`）上五階**全部 `1.00` / `1.00`** —— 完全飽和。
所以七題的平均（`0.96`–`0.98`）是被簡單題稀釋出來的數字，**不是一次新的測量**；
有解析度的只有四條難題那一組，上表第三列取的就是它。同一件事在成本上反過來：
簡單題的 token 佔比壓低了平均，所以要比成本得看同一組題目。

**那一輪 `gpt-oss-120b` 有 21 次被端點回 `429`，而那不是模型的問題 —— 是我們打太快。**
（**這段更正了本節先前的說法**，原本寫的是「它跑不完難題」「斷點跟題目綁定」。）
量下去之後兩句都不成立：**只跑那條「6/6 全滅」的題、前面什麼都不跑，是 6/6 全過、
全部滿分**，每次 5–7 秒。斷點跟題目無關，跟**累計用量**有關 —— 實測 49.5 秒內燒掉
**119,363 token** 觸發 429（約 120k 的每分鐘 token 配額），而 **16 秒後就完全恢復**，
輕請求與一次真的 eval 執行都立刻通過。

先前那句「冷開機重跑逐格重現，所以不是配額被前面的執行打滿」**推論反了**：那次重跑走的是
同一串七題序列，累計到同一個點才斷 —— **逐格重現正是累計效應的證據，不是它的反證**。
真正的對照是換掉一個變數（只跑那條題），不是把同一串重放一次。

**最反直覺的一點：撞上限流的是六個模型裡最快的那個。** `nano` / `super` / `ultra` 每次
token 更多（11k–17k），但每次要 14–60 秒；`oss-120b` 每次只要 2–7 秒 —— 單位時間的
token 率最高，所以只有它超速。**「跑得快」本身是撞限流的風險因子，而它長得跟「這個模型
不行」一模一樣。** **把限流接住之後重跑同一階，42 次零失敗**，七題與四條難題
都是 `1.00` / `1.00`（各 36、18 個判分）—— 它不但跑得完，還是五階裡唯一在難題上不掉分的。

**上面整段是 2026-08-28 的結論，原文照留 —— 但那個選擇已經被端點取消了。**
`openai/gpt-oss-120b` 於 **2026-09-03 下架**（410，EOL 帶日期），型錄上也沒有它了。
2026-09-04 重盤重選，答案是 **`nvidia/nemotron-3-super-120b-a12b`**，而這次的形狀不一樣：
**品質沒有打平**（難題 0.98 對其他三個候選的 0.92–0.93），它同時拿下延遲與多叫次數，
只輸 token。見 [#165](https://github.com/DemianLi/nexus-agent/issues/165) 與
[`.docs/model-inventory.md`](.docs/model-inventory.md)。順帶量到兩件以前拿不到的事：
**上下文窗口是逐顆的**（同端點兩顆差五倍以上），以及**可用的候選只剩 9 個**，
沒過 [#85](https://github.com/DemianLi/nexus-agent/issues/85) 的十個門檻。

**選型維持 `openai/gpt-oss-120b`（2026-08-28）。** 那 21 次 429 一度被讀成失敗模式那一軸的
反面證據，更正之後**它不是** —— 限流是我們的跑法，不是模型的性質。品質並列第二、
token 最省四到五成、多叫次數最低，三個軸都沒有變。
跨階梯讀這條線對**選型**合法，對**尺寸效應**不合法。順帶：**成本跟尺寸無關，跟配方有關**
—— 最便宜的一階是 120B 的 `oss-120b`，而最小的 `nano` 比最大的 `ultra` 還貴。

**一次執行有兩道上限，超過就記成 `budget`。** 迴圈 40 個 super-step（約 19 輪模型呼叫）、
時鐘 300 秒。兩道各管一半：一次跑掉可以是「叫太多次」，也可以是「叫沒幾次但每次都久」。
而 `LIVE_TIMEOUT_MS`（90 秒）那道**一次都沒觸發過**，因為它管的是單一請求。

實測攔到過一次：`llama-3.2-11b` 在同一題上，**沒有上限時跑了兩個小時**（單一次執行，
零輸出，最後是人工殺掉的），**有上限時在第 101.8 秒被迴圈那道切掉**。同一輪裡最慢的
正常執行是 93.8 秒，所以 300 秒那道沒有誤傷任何東西。

**`budget` 是資料損失，不是低分。** 模型有沒有做完那題我們不知道，所以它跟端點的 4xx
一樣不進平均，但要做的事不同：那是「調高上限重跑」或「這個模型在這題上跑不完」，
不是換 id 也不是查網路。

驅動器把**失敗與零分分開**：模型叫不出工具是 0 分（有資料），端點回 4xx 或掛住是
「沒有資料」，後者不會被平均進通過率。判準對照曾經出現的 `400 "This model only supports
single tool-calls at once!"` 就是這樣 —— 拒的是平行工具呼叫，那不是分數。

**限流另外記一類 `throttled`，不跟 `400` 混在 `rejected` 裡。** `400` 是**模型行為**撞上
供應商限制（重跑一模一樣，要換 id 或改題目），`429` 是**我們打太快**（重跑不一定一樣，
跟模型好壞無關）。混在一起讀會出事 —— 2026-08-28 就出過一次。配額耗盡的 429 **不算**
這一類，它留在 `rejected`：dsh 把 `RATE_LIMIT` 與 `QUOTA` 分成兩個碼，理由一樣是
「前者等一下就過，後者重試無效」。

**限流會先被重試接住，接不住才記成 `throttled`。** 這道要自己接，是因為基座那道的作用面
比看起來窄：`AsyncCaller` 的 `maxRetries` 預設是 6，但 `@langchain/core` 把**沒有
`retry-after` header 的 429** 分類成 `headerless_429` 然後**直接放棄**，而 NVIDIA 回的
正是那個形狀；底層那道也關著（`@langchain/openai` 建 client 時寫死 `maxRetries: 0`）。
所以 `createLiveModel` 傳自訂的 `onFailedAttempt`，**只改限流那一支** —— 它會整個取代掉
基座的預設，順手把 `500` 與連線問題的重試一起關掉是很容易犯的退化，測試有一條專門擋它。

clone 之後各自設定一次，讓 `git fetch` / `git pull` 自動清掉遠端已刪除的分支：

```bash
git config fetch.prune true
```

PR 合併後 GitHub 會自動刪掉 head branch（repo 開了 `delete_branch_on_merge`），
沒設 prune 的話本地會累積一堆早已不存在的 `origin/*`。這條寫在 `.git/config`，不進版控。

新增 shadcn/ui 元件：

```bash
pnpm --filter @nexus/web dlx shadcn@latest add <component>
```

## 分支策略

```
feature/*  --squash-->  develop  --merge commit-->  main  --workflow_dispatch-->  Release
```

| 分支 | 角色 |
|---|---|
| `develop` | 預設分支。所有日常開發的整合目標。 |
| `main` | 發佈分支。唯一能產出 GitHub Release 的分支。 |

### 規則

- **兩條分支都禁止直接 push**，一律走 Pull Request。
- **`gate` CI 必須綠燈**才能合併，且分支必須與 base 同步（strict）。
- **PR 標題必須符合 `<type>: <描述>` 格式**，由 `gate` 強制；格式見 [AGENTS.md](AGENTS.md)。
- **`main` 只接受來自 `develop` 的 PR**，由 `gate` 檢查 head branch 強制執行。緊急修補同樣先進 `develop`。
- **禁止 force push 與刪除分支**，無人可繞過規則（含 repo owner）。
- **`develop` 要求分支與 base 同步（strict）**；`main` 刻意不開 strict — 因為 `develop → main` 的 merge commit 只存在於 `main`，開了 strict 會讓第二次發版的 PR 永遠處於 out-of-date 而無法合併。
- 合併方式：`feature → develop` 只能 squash；`develop → main` 只能 merge commit（保留可追溯性，因此 `main` 不啟用 linear history）。

### 發佈

到 Actions 頁面執行 **Release** workflow，branch 選 `main` 並輸入版號（`vX.Y.Z`）。
workflow 會自行打 tag 並建立 GitHub Release。因為 `workflow_dispatch` 限定在 `main` 執行，
「從 develop 發版」在機制上不可能發生。

版號規則在 1.0 之前從簡：**完成一個 Phase 跳 minor，其餘一律 patch**。
1.0 之前 semver 本來就不承諾相容性，此刻套用完整規則只是徒增判斷成本。

不維護手寫的 CHANGELOG。release notes 由 `--generate-notes` 依 PR 標題自動生成，
而 PR 標題規範已經強制每個變更都有一句可讀的中文描述 — 那就是 changelog 的原料。

## CI

`gate` 是唯一的 required status check，名稱永久固定。
它無條件觸發，在 job 內以 `git diff` 計算異動檔案再決定要掃什麼；
沒有可掃的檔案時直接綠燈通過，因此純文件的 PR 不會卡住。
