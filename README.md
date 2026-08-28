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

**不要在 CI 設 `LANGSMITH_TRACING`。** eval 跑的是真的 agent，tracing 開著時基準任務的
題目與工具參數會跟著 trace 送出去 —— 那條路徑跟 `langsmith/vitest` 自己的上傳是**兩個
獨立的開關**，關掉一個不影響另一個（`src/eval/eval.test.ts` 的檔頭記著實測）。

尺寸比較（**要 key、會花錢、不進 CI**）：

```bash
pnpm --filter @nexus/harness run eval:compare --samples 3
```

同一份基準任務跑 Nemotron-3 家族的三個橫階（`nano-30b-a3b` / `super-120b-a12b` /
`ultra-550b-a55b`），只有 model 這一個參數不同。橫階怎麼挑出來的、以及**那份清單為什麼
是綁在帳號上的**（`GET /models` 列 84 個，一把 key 通常只叫得動其中 29 個），寫在
`src/eval/tiers.ts` 的檔頭；換一把 key 要重新盤點。

**跑出來的結果是「這三階分不出高下」**：工具呼叫成功率與參數正確性都是 1.00，
總 token 差 5% 而總參數量差 18 倍。那不是三個模型一樣好，也不是題目太淺 —— 盤點時
`meta/llama-3.2-11b-vision-instruct` 在**同一句** `echo-once` 上把參數寫成亂碼，判準在
11B 上分得出來。分不出來的原因是**這道階梯的底板是 30B，而崩塌點在它底下**；11B 與 30B
之間沒有量過。

驅動器把**失敗與零分分開**：模型叫不出工具是 0 分（有資料），端點回 4xx 或掛住是
「沒有資料」，後者不會被平均進通過率。

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
