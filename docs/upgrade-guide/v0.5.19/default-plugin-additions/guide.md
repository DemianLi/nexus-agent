---
kind: upgrade-guide
description: 出貨清單多了幾列會改變模型看到的內容或多打模型的外掛：時間讀數、身分與 persona、檔案政策那一句、模型產生標題。
---

# 出貨清單多了會改變模型行為的幾列

## 變更

下面幾列在 v0.5.19 沒有，新版出廠就掛著。升上來之後，同一句話送給模型的內容或模型呼叫次數會不一樣：

| 列 id | 做什麼 | 來源 |
| --- | --- | --- |
| `time-context` | 每次 agent 呼叫開頭追加一則使用者訊息，寫著當下時間、瀏覽器時區、距上一則訊息多久；同一條 thread 10 分鐘內不重複。網頁送來的那一輪用瀏覽器時區；CLI、目標續行這類沒帶時區的，退回這一列的 `timeZone`，沒設就是行程的 `TZ`（容器裡常是 UTC） | PR #1723 |
| `system-prompt` | 系統提示詞從 v0.5.19 寫死的「你是 nexus-agent 的命令列助手。」換成英文的身分句、`personaPrefix`、`personaSuffix`（出貨值見 `apps/harness/cordis.yml` 的那一列）；子代理也帶 | PR #820 |
| `sandbox-policy` | 沒給 `--workspace` 時也講一句不宣稱圍堵的檔案政策；v0.5.19 這種情況什麼都不講 | PR #1172 |
| `thread-title-llm` | 帶 `--live` 時，每條新 thread 的第一則人話開跑後，另外打一次模型產生標題（輸出上限 64 token） | PR #658 |

另外 `skills` 也進了出貨清單，工作區沒有 `skills/` 時一個字都不加；insert 過它的主機見 `skills-now-shipped` 那份指南。

受影響的：所有主機。有自己寫系統提示詞期待、在意模型用量、或主機時區不是使用者時區的部署，要看一下。

## 遷移

每一列都可以調或關，寫在 `--patch` 覆寫檔，或用 `plugin config set <id> --file -`／`plugin disable <id>`：

1. `time-context`：主機時區跟使用者不同，啟動時設 `TZ`，或給這一列 `timeZone: <IANA 名>`；不要這則讀數，`plugin disable time-context`。
2. `system-prompt`：要回到接近 v0.5.19 的提示詞，把三格整份寫出來，例如 `includeHarnessIdentity: false`、`personaPrefix` 寫你要的身分句、
   `personaSuffix` 留空字串。`config` 是整份替換，只寫一格另外兩格會回到空。這一列寫壞 serve 起不來。
3. `sandbox-policy`：沒給 `--workspace` 又不要那一句，`plugin disable sandbox-policy`；有 `--workspace` 時這一列關不掉。
4. `thread-title-llm`：不要多打這一次模型，`plugin disable thread-title-llm`，標題回到截第一句話。
5. 確認：`--dump-config` 裡這幾列是你要的狀態；`plugin` 改動的生效時機照它印的「生效：…」那一行。
