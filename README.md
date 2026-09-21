# nexus-agent

**萬物皆可插件的 Deep Agents Harness**，全 TypeScript——LangChain JS ＋ LangGraph JS ＋
deepagents，零 Python 基座。

要解決的問題：deepagents 的擴充入口原本分散在 `tools`、`middleware`、`backend`、`subagents`、
`permissions`、`interruptOn` 各自的參數裡，各傳各的。nexus 把它們**收斂成單一的 `NexusPlugin`
契約**——一份清單，一個註冊表，所有能力用同一種方式掛上去。路線是**不從零重造**：約七成需求由
deepagents 覆蓋，自建的是 plugin 統一註冊、結果校驗、可觀測性接線與 web UI。

## 架構

**`apps/harness` 是組裝點**——它把一份 plugin 清單摺進 deepagents 的 agent，再接上三個入口。

```
plugin 清單 ──fold──▶ agent ──┬──▶ CLI（一次性／REPL）
  (NexusPlugin)               ├──▶ serve（HTTP ＋ 靜態網頁）
                              └──▶ eval（基準任務）
```

| 位置 | 職責 |
| --- | --- |
| `packages/nexus-core` | `NexusPlugin` 契約：型別、manifest、`PluginRegistry`、fold、輸出校驗與圍堵 |
| `packages/nexus-plugin-*` | 各項能力，一個能力一個套件 |
| `packages/nexus-wire` | harness 與 web 之間的傳輸型別 |
| `apps/harness` | 組裝點：agent 工廠、訊息標準化、CLI 與 serve |
| `apps/web` | Vite ＋ React 19 ＋ Tailwind v4 ＋ shadcn/ui |

pnpm workspace，Node >= 22。

## 能力

**開箱就有**，`--plugins` 換不掉（CLI 與 serve 共用同一個組裝函式）：`ask_user_question`、
`submit_record`，以及給了 `--workspace` 才掛的檔案圍堵與 `/sandbox`、工作區改動紀錄。

**在出貨的清單裡**（[`apps/harness/cordis.yml`](apps/harness/cordis.yml)，用 patch 檔改，見 [`docs/operations.md`](docs/operations.md#plugin-清單)）：

| 能力 | 一句話 | 細節在 `packages/` |
| --- | --- | --- |
| 計劃模式 | 先探索再動手，計劃交出去等人批准；開關是 `/plan` | `nexus-plugin-plan-mode` |
| 長期目標 | 一個會話記得住跨多輪的目標；開關是 `/goal` | `nexus-plugin-goal` |
| Todo | 模型自己維護的工作清單 | `nexus-plugin-todo` |
| 工作區指令 | 工作區的 `AGENTS.md` 當一則訊息送進每個 agent | `nexus-plugin-agent-instructions` |
| 交付宣告 | 模型指名這一輪交付了哪些檔 | `nexus-plugin-present` |
| 評分與回饋 | `/feedback` | `nexus-plugin-feedback` |

**要自己疊一層 patch 才掛**：MCP、QuickJS 沙箱、skills、記憶、OpenTelemetry 遙測。每個套件的
`src/index.ts` 檔頭寫著它自己的完整規格與偏離標註。人打的斜線命令不經過模型，由進入點解析發派。

## 跑起來

```bash
pnpm install
pnpm --filter @nexus/harness run cli "把這句話回聲一次。"   # 一次性，跑完就退出
pnpm --filter @nexus/harness run cli                        # REPL，/help 看命令，/exit 結束
pnpm --filter @nexus/harness run cli:live "..."             # 換成真實供應商，需要 API key
```

**預設走寫死腳本的假模型，不需要任何 key**——那條路徑驗的是接線，不是模型。

在瀏覽器裡跟 agent 說話——**先 build 網頁再起 `serve`**，網頁是 `apps/web/dist` 的靜態產物，
順序反了什麼都沒有：

```bash
pnpm dev                                    # 建進 apps/web/dist，改了原始碼自動重建
pnpm --filter @nexus/harness run serve      # 印出「nexus-agent 在 http://127.0.0.1:8787/?token=…」
```

開它**印出來的那個網址**——那串 token 是登入用的，是敏感輸出，別貼給別人。
**不要用 `vite` 或 `vite preview`**，它們被刻意做成拒絕啟動；網頁一律由 `serve` 服務。
**要檔案圍堵就得給 `--workspace`**：沒給的話那道 fence 根本不在路徑上，而畫面看起來一模一樣。

跑起來之後的事——圍堵怎麼切、會話日誌寫到哪、多人共用主機怎麼連、執行上限、核准、評測——見
[`docs/operations.md`](docs/operations.md)。

## 開發

```bash
pnpm lint         # eslint（遞迴全部套件）
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm build        # vite build
pnpm --filter @nexus/web dlx shadcn@latest add <component>   # 新增 shadcn/ui 元件
```

程式碼規範見 [`docs/standards.md`](docs/standards.md)。分支策略、PR 標題格式、發版流程與設計方法論
（含對 DeepSeek Harness 的偏離規則）見 [AGENTS.md](AGENTS.md)。

CI 只有 `gate` 一個 required status check，無條件觸發、在 job 內以 `git diff` 決定要掃什麼，
沒有可掃的檔案時直接綠燈——純文件的 PR 不會卡住。**三個例外**，共通點是「測試會讀這個檔」：
`docs/operations.md`（測試從它讀核准 fixture 的參數，[#490](https://github.com/DemianLi/nexus-agent/issues/490)）、
`apps/harness/cordis.yml`（出貨的 plugin 清單，十七個測試檔真的拿它組 agent，
[#454](https://github.com/DemianLi/nexus-agent/issues/454)）
與 `apps/harness/src/*.patch.yml`（patch 檔案，測試疊在出貨清單上組 agent，[#455](https://github.com/DemianLi/nexus-agent/issues/455)）。
只改這些檔案也可能弄紅測試，所以它們會觸發完整掃描。細節見 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。
