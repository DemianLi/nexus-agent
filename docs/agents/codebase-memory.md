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

```
index_repository(repo_path: "<repo>", name: "nexus-agent", mode: "full")
index_repository(repo_path: "<repo>/references/deepseek-harness", name: "deepseek-harness", mode: "full")
```

索引過的專案會在背景自動更新，不需要每次手動重建。

## 分工：正向走圖，否定配 grep

這是這份文件的承重句。

- **找得到的東西走圖。** 「X 定義在哪」「誰呼叫 X」「X 呼叫什麼」用 `search_graph`、`trace_path`、`get_code_snippet`，比 grep 準也比 grep 省。
- **「沒有」「只有 N 個」「全部都是」這類宣稱，出口前一律補兩件事**：`check_index_coverage` 查那個範圍有沒有記錄在案的缺口，再用 grep 掃一次。圖的覆蓋率是 best-effort，查不到不等於不存在，而且完全沒被索引的檔案根本不會出現在查詢結果裡。

子代理分三級，用法跟這條一致：`codebase-memory-scout` 只做正向、暫定的查找，不下否定結論；`codebase-memory` 是預設的驗證級；`codebase-memory-auditor` 做限定範圍的完整稽核。

## 已知的精度邊界

實測過的，查詢時要自己扣掉：

- **呼叫邊的解析信心不一致。** 同一張圖裡有 `lsp 0.95`、`heuristic 0.95`，也有 `heuristic 0.38`（`createNexusAgent → foldRegistry`）。實測時這幾條邊都與 grep 一致，但信心高低跟 package 邊界沒有對應關係（同 package 的 `createCliAgent → createNexusAgent` 也是 heuristic），不要自己推規則。邊要拿來當證據時，加 `include_evidence: true` 逐條看 strategy 與 confidence，低的那條配 grep。
- **全文搜尋會被測試檔淹沒。** `search_graph` 的 `query` 前幾名常是 `*.test.ts` 裡的輔助函式，要限定範圍就加 `file_pattern`（例如 `packages/**/src/**`）。`trace_path` 預設就排除測試，要看測試加 `include_tests: true`。
- **部分解析失敗的檔案**：`nexus-agent` 只有 `apps/web/src/index.css`，無關緊要；`deepseek-harness` 有上百個，查不到東西時先 `check_index_coverage` 看那個檔案有沒有被標記。

## 引用 deepseek-harness 之前

那份 clone 是 `--depth 1`，會停在 clone 當下那個 commit，索引也跟著停在那裡。拿它當標準引用之前：

1. `git -C references/deepseek-harness pull`，對一下 `git rev-parse HEAD` 與 `git ls-remote origin HEAD`
2. 有更新就重跑上面的 `index_repository(... name: "deepseek-harness" ...)`
3. 引用時附上 SHA
