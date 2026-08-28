# nexus-agent

TypeScript + React (shadcn/ui) 專案，架構分為 harness 與 web UI 兩部分。

## 專案結構

```
packages/nexus-core          NexusPlugin 契約：型別、manifest、PluginRegistry、fold
packages/nexus-plugin-echo   最小 plugin 範例，只相依 @nexus/core
packages/nexus-plugin-mcp    把 MCP server 的工具接進 registry
packages/nexus-plugin-quickjs  QuickJS 沙箱裡跑 JavaScript 的 custom tool
packages/nexus-plugin-memory 把 AGENTS.md 這類長期記憶掛進 agent
packages/nexus-plugin-skills 把 SKILL.md 這類隨選工作流掛進 agent
packages/nexus-plugin-validation  工具失敗回饋與輸出 schema 校驗
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
pnpm --filter @nexus/harness run cli                        # REPL，/exit 或 Ctrl-D 結束
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
**一批要嘛全核准要嘛全拒絕**：基座只要有一筆被拒，被核准的那幾筆也不會執行，
而且線上連一顆事件都不會有，所以介面刻意不提供逐筆按。

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
| 第三輪 | 四條難題 × 6 次 | 18 | 0.95 | **樣本不足** | 0.92 | 0.96 | 0.94 |

**「判分數」不等於執行次數** —— `no-tool-needed` 期望零筆工具呼叫，那兩欄沒有東西可判，
所以四條難題 × 6 次是 24 次執行、18 個判分。`oss-120b` 兩次都不足額（第一輪 `transport`×1、
第三輪 `429`×21），它的 `1.00` 因此一直踩在很少的樣本上。

三輪都落在同一個窄帶裡，方向一輪一個樣。**判準沒有飽和**（全距下探到 `0.33`／`0.50`），
只是尺寸沒有在那個量程上動。

**七題全跑那一輪必須拆開讀，否則會誤判成判準又飽和了。** 三條簡單題（`echo-once` /
`echo-then-write` / `write-then-read`）上五階**全部 `1.00` / `1.00`** —— 完全飽和。
所以七題的平均（`0.96`–`0.98`）是被簡單題稀釋出來的數字，**不是一次新的測量**；
有解析度的只有四條難題那一組，上表第三列取的就是它。同一件事在成本上反過來：
簡單題的 token 佔比壓低了平均，所以要比成本得看同一組題目。

**`gpt-oss-120b` 在這把 key 上跑不完難題 —— 這是七題全跑才暴露出來的。** 它 42 次執行裡
有 21 次被端點回 `429 Too Many Requests`，而且**斷點跟題目綁定**：三條簡單題 18/18 全通過，
`reverse-round-trip` 與 `grep-across-files` **6/6 全滅**。單獨冷開機重跑一次（沒有前面
那 42 次暖身）**逐格重現**：同樣從 `edit-after-read` 第 3 次開始斷、同樣那兩條全滅、
簡單題的 token 平均 5045 對 5049。所以它不是隨機節流，也不是配額被前面的執行打滿的。
它之後跑的 **168 次執行（`nano` / `super` / `ultra` / 判準對照）零 429**，所以不是整把 key
的吞吐上限被打滿；同家族、同命名空間的 `oss-20b` **42 次也零 429**，所以也不是 `openai/*`
這個前綴的事。兩件加起來把範圍收窄到這一個 id。它的參數正確性因此標成「樣本不足」而不是
`1.00` —— 那個 1.00 只由簡單題撐著。

**選型落在 `openai/gpt-oss-120b`（2026-08-28），而上面這件事是它的反面證據。** 選型的
三個軸裡，品質並列第二、token 最省四到五成、多叫次數最低；但**失敗模式那一軸現在指向反面**：
六個受測模型裡只有它跑不完基準任務。要說準的是這件事**只在 eval 的跑法下量到過** ——
連續、快速、同一個模型連發 42 次；CLI 與 `serve` 是人在打字，不是那個形狀。
**跑不完 eval** 與 **不適合當預設**是兩件事，這裡只把證據放好。
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

**但 `rejected` 這一類目前混著兩種東西，讀的時候要自己分。** `400` 是**模型行為**撞上
供應商限制（重跑會一樣），`429` 是**我們被限流**（重跑不一定一樣，而且它跟模型好壞無關）。
兩者現在都記成 `rejected`，報表上分不出來。**而且 429 一次都沒有被重試過** ——
`createLiveModel` 沒有設 `maxRetries`，實測 21 次裡有 16 次是在 **0.1 秒**內就放棄的，
那個時間撐不下任何 backoff。兩件都是已知未修，各自是獨立的一張 PR。

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
