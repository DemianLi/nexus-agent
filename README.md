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

pnpm workspace，Node 要 22.19 以上的 22.x，或 24 以上（23 已 EOL，不支援），以 `package.json` 的 `engines` 為準。

## 能力

**開箱就有**，patch 也關不掉（CLI 與 serve 共用同一個組裝函式）：給了 `--workspace` 才掛的檔案圍堵與
`/permission`（權限組合）、工作區改動紀錄。`ask_user_question` 與 `submit_record` 現在在下面那份清單裡，跟其他列一樣看得見、關得掉。

**在出貨的清單裡**（[`apps/harness/cordis.yml`](apps/harness/cordis.yml)，用 patch 檔改，見 [`docs/operations.md`](docs/operations.md#plugin-清單)）：

| 能力 | 一句話 | 細節在 `packages/` |
| --- | --- | --- |
| 計劃模式 | 先探索再動手，計劃交出去等人批准；開關是 `/plan` | `nexus-plugin-plan-mode` |
| 長期目標 | 一個會話記得住跨多輪的目標；開關是 `/goal` | `nexus-plugin-goal` |
| Todo | 模型自己維護的工作清單 | `nexus-plugin-todo` |
| 工作區指令 | 工作區的 `AGENTS.md` 當一則訊息送進每個 agent | `nexus-plugin-agent-instructions` |
| 時間讀數 | 每次呼叫開頭追加現在時間與距上一則訊息的時長，同一條會話 10 分鐘內不重複 | `nexus-plugin-time-context` |
| 技能 | 工作區（`--workspace`）的 `skills/<name>/SKILL.md` 列進提示詞，模型需要時自己去讀；serve 的新對話從唯讀的 `/shared/skills/` 讀同一個目錄。沒有技能就不加任何字 | `nexus-plugin-skills` |
| 交付宣告 | 模型指名這一輪交付了哪些檔 | `nexus-plugin-present` |
| 評分與回饋 | `/feedback` | `nexus-plugin-feedback` |

**要自己疊一層 patch 才掛**：MCP、QuickJS 沙箱、記憶、OpenTelemetry 遙測。每個套件的
`src/index.ts` 檔頭寫著它自己的完整規格與偏離標註。人打的斜線命令不經過模型，由進入點解析發派。

## 跑起來

```bash
pnpm install
pnpm --filter @nexus/harness run cli "把這句話回聲一次。"   # 一次性，跑完就退出
pnpm --filter @nexus/harness run cli                        # REPL，/help 看命令，/exit 結束
pnpm --filter @nexus/harness run cli:live "..."             # 換成真實供應商，需要 API key
```

**預設走寫死腳本的假模型，不需要任何 key**——那條路徑驗的是接線，不是模型。

開發時不必先建置：`tsx` 與 `vitest` 照 `tsconfig.base.json`／`tsconfig.runtime.json` 的 `paths` 把 `@nexus/*` 解到 `src/`。
每個套件的 `package.json` 指的是 `lib/`（出貨的是編好的 ESM），要產出它：`pnpm run build:lib`；`pnpm lint` 會先做這一步，
因為各插件的 `eslint.config.js` 載入的是 `@nexus/sdk/lint` 編好的 `lib/lint.js`。新增套件或 subpath 後跑
`pnpm run gen-tsconfig-paths` 更新別名（`pnpm run verify-tsconfig-paths` 查有沒有漂移，CI 會跑）。

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
（含怎麼參照 DeepSeek Harness 選做法）見 [AGENTS.md](AGENTS.md)。

CI 只有 `gate` 一個 required status check，無條件觸發，`gate` 只是把其他 job 的結果收斂成單一燈號。
功能分支 → `develop` 的 PR 走輕的模式：`plan` job 只做擋樹的檢查（PR 標題與格式、受影響套件的型別檢查、異動檔的
format 與 lint、改到的測試檔加上同名測試檔），沒東西可查時不安裝相依——純文件的 PR 不會卡住。全套測試與 web build
在合併進 `develop` 之後的那一輪跑。動到 `.github/workflows|scripts|actions` 的功能 PR、`develop → main` 的 PR 與
`main` 的 push 一律全跑（判斷邏輯見 [`.github/scripts/plan_ci.py`](.github/scripts/plan_ci.py)）。
全跑時以 `git diff` 決定要不要掃 TypeScript；有幾個非 TypeScript 的檔會觸發掃描，共通點是「測試會讀這個檔」：
`docs/operations.md`（測試從它讀核准 fixture 的參數，[#490](https://github.com/DemianLi/nexus-agent/issues/490)）、
`apps/harness/cordis.yml`（出貨的 plugin 清單，十七個測試檔真的拿它組 agent，
[#454](https://github.com/DemianLi/nexus-agent/issues/454)）
與 `apps/harness/src/*.patch.yml`（patch 檔案，測試疊在出貨清單上組 agent，[#455](https://github.com/DemianLi/nexus-agent/issues/455)）。
細節見 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。
