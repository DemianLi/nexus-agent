# 程式碼檢索：codebase-memory-mcp

[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) 把 repo 解析成一張本機知識圖（函式、型別、import、呼叫邊），讓 agent 用結構去找程式碼，而不是一路 grep 猜字串。

## 它不在 repo 裡

- MCP server 註冊在**使用者層級**（`~/.claude.json` 的 `mcpServers`），repo 沒有 `.mcp.json`。
- 索引存在本機的 `~/.cache/codebase-memory-mcp/`，不進版控，也不產 `.codebase-memory/graph.db.zst`。
- 所以 clone 完不會有圖。**每個人自己索引一次**，專案名照下表固定，文件與對話裡才對得上：

| 專案名 | 路徑 | 備註 |
| --- | --- | --- |
| `nexus-agent` | repo 根目錄 | 照 `.gitignore` 排除 `references/`、`node_modules/`；`.claude/` 也被排除 |
| `deepseek-harness` | `references/deepseek-harness` | 技術實現標準（見 [AGENTS.md](../../AGENTS.md#技術實現標準)），另外索引 |
| `cordis` | `references/cordis` | 上游 [cordiverse/cordis](https://github.com/cordiverse/cordis)，checkout 在 `v4.0.0-rc.12`（`01b39624`）：Cordis 的比對基準是 rc.12（demian 2026-10-23，[#1937](https://github.com/DemianLi/nexus-agent/issues/1937)），`vendor/` 本身仍停在 rc.11（見 [vendor/README.md](../../vendor/README.md)） |

```
index_repository(repo_path: "<repo>", name: "nexus-agent", mode: "full")
index_repository(repo_path: "<repo>/references/deepseek-harness", name: "deepseek-harness", mode: "full")
index_repository(repo_path: "<repo>/references/cordis", name: "cordis", mode: "full")
```

`references/cordis` 同樣不進版控，要自己拉一份並釘在 tag 上：

```bash
git clone https://github.com/cordiverse/cordis.git references/cordis
git -C references/cordis checkout v4.0.0-rc.12
```

它釘在 tag，不 pull；基準換版時，checkout 新 tag 再重跑上面那行 `index_repository(... name: "cordis" ...)`。

### 圖譜不會自己跟上

背景監看只追「目前 MCP session 開在哪個專案」那一份；從 CLI 或從別的專案的 session 建的索引都不監看（[v0.12.0 release notes](https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.12.0)〈Upgrade notes〉）。上表三份在 worktree 裡開的 session 都不算：session 開在 `.claude/worktrees/<名字>`，`nexus-agent` 指向主 checkout，另外兩份在 `references/` 底下。所以三份都要手動重建，才會跟上原始碼。

要知道某一份有沒有被監看，看 `index_status` 的 `watch`：

```
index_status(project: "nexus-agent")
→ watch: { watched: false, reason: "not_session_project" }
```

圖譜落後時，用同一個專案名重跑上面那行 `index_repository`；名字寫錯會長出一份新的圖譜，而不是更新原本那份。主 checkout 停在舊 commit 時，`nexus-agent` 反映的就是那個 commit，不是你 worktree 裡還沒合的改動，要引用最新內容就讀原始碼或 grep。

## 分工：正向走圖，否定配 grep

這是這份文件的承重句。

- **找得到的東西走圖。** 「X 定義在哪」「誰呼叫 X」「X 呼叫什麼」用 `search_graph`、`trace_path`、`get_code_snippet`，比 grep 準也比 grep 省。
- **「沒有」「只有 N 個」「全部都是」這類宣稱，出口前一律補兩件事**：`check_index_coverage` 查那個範圍有沒有記錄在案的缺口，再用 grep 掃一次。圖的覆蓋率是 best-effort，查不到不等於不存在，而且完全沒被索引的檔案根本不會出現在查詢結果裡。

子代理分三級，用法跟這條一致：`codebase-memory-scout` 只做正向、暫定的查找，不下否定結論；`codebase-memory` 是預設的驗證級；`codebase-memory-auditor` 做限定範圍的完整稽核。

## 已知的精度邊界

實測過的，查詢時要自己扣掉：

- **呼叫邊的解析信心不一致。** 同一張圖裡有 `lsp 0.95`、`heuristic 0.95`，也有 `heuristic 0.38`（`createNexusAgent → foldRegistry`）。實測時這幾條邊都與 grep 一致，但信心高低跟 package 邊界沒有對應關係（同 package 的 `createCliAgent → createNexusAgent` 也是 heuristic），不要自己推規則。邊要拿來當證據時，加 `include_evidence: true` 逐條看 strategy 與 confidence，低的那條配 grep。
- **透過欄位或介面呼叫的方法，呼叫者會漏報。** `trace_path` 查 `JsonlStoredSession.append` 回 0 個呼叫者，但 `thread-pump.ts` 裡有十幾處 `this.#sessions.root.append(...)`：接收者的型別圖解不出來，這條邊就不存在。一般函式不受影響（`runCli`、`acquireHomeLock` 的呼叫者與 grep 完全一致）。查方法的呼叫者時，圖回 0 或回很少，一律再用 grep 掃方法名（0.12.1 實測）。
- **全文搜尋會被測試檔淹沒。** `search_graph` 的 `query` 前幾名常是 `*.test.ts` 裡的輔助函式，要限定範圍就加 `file_pattern`（例如 `packages/**/src/**`）；知道名字時改用 `name_pattern` 精確比對。`trace_path` 預設就排除測試，要看測試加 `include_tests: true`。
- **`semantic_query` 不可靠。** 以「serve 鎖檔，確保一個 home 只跑一個 server」查，回的全是 `.docs/chat-agent-research/verify/*.py` 的研究腳本，`home-lock.ts` 沒出現（0.12.1 實測）。不要用它找程式碼，改用 `name_pattern` 或加 `file_pattern` 的 `query`。
- **部分解析失敗的檔案**：`nexus-agent` 只有 `apps/web/src/index.css`，無關緊要；`deepseek-harness` 有上百個，查不到東西時先 `check_index_coverage` 看那個檔案有沒有被標記。

## 引用 deepseek-harness 之前

那份 clone 是 `--depth 1`，會停在 clone 當下那個 commit，索引也跟著停在那裡。拿它當標準引用之前：

1. `git -C references/deepseek-harness pull`，對一下 `git rev-parse HEAD` 與 `git ls-remote origin HEAD`
2. 有更新就重跑上面的 `index_repository(... name: "deepseek-harness" ...)`
3. 引用時附上 SHA
