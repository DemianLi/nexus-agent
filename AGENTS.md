# AGENTS.md

nexus-agent 的 agent 工作規範：PR 標題、分支策略、檔案歸屬、發版流程、技術實現標準。
專案目標、架構與怎麼跑起來見 [README.md](README.md)；跑起來之後的操作見 [`docs/operations.md`](docs/operations.md)。

## 標題格式

PR 標題就是 history。repo 設定為 `squash_merge_commit_title: PR_TITLE` 與 `merge_commit_title: PR_TITLE`，所以 **PR 標題會原封不動成為 develop 與 main 上的 commit 標題**，feature 分支上的 commit message 則會被 squash 掉。標題寫壞了，history 就壞了。

```
<type>: <中文描述>
```

type 只有這幾個：

| type | 用於 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 修 bug |
| `refactor` | 不改行為的重構 |
| `perf` | 效能 |
| `test` | 只動測試 |
| `docs` | 只動文件 |
| `ci` | 動 CI 或 workflow |
| `chore` | 相依套件、設定、雜項 |
| `release` | `develop → main` 的同步 PR |

描述的規則，gate 會逐條檢查：

- 中文祈使句，說「做了什麼」而不是「改了哪個檔」
- 8 到 50 字
- 至少含一個中文字（套件名、指令名保留原文，整句英文不行）
- 不能是「更新」「調整」「修正一些問題」這種沒有資訊量的填充句

分支命名用 `<type>/<kebab-case>`，type 同上表，例如 `fix/ci-duplicate-runs`。

gate 會擋下不符格式的 PR 標題。改標題即可，不需要重開 PR。

## PR 內文

兩種 PR，兩種格式。

**feature → develop**：標準格式是 `mattpocock-skills:pr`，照 [`.github/pull_request_template.md`](.github/pull_request_template.md)。段落標題與欄位名照 `/pr` 原文用英文，內文寫中文，用語照 [`GLOSSARY-MAP.md`](GLOSSARY-MAP.md) 指到的領域詞彙。`/pr` 之外只加兩處：第一行的 `Refs #N`，與 Summary 裡的「對照 dsh」。骨架：

- 第一行 `Refs #N`（不寫 Closes）；
- `## Summary`：挑最小的一張圖（虛擬碼、呼叫樹、元件樹、檔案樹或 diff 草圖），配一兩句話；GitHub 上 Mermaid 只露出一小塊，優先用文字樹或 diff 草圖。涉及技術實現的 PR，圖之後接 `**對照 dsh：**`，照「技術實現標準」的三步寫：dsh 怎麼做與為什麼、比較了哪些做法、選了哪個與好在哪；做法跟 dsh 一樣的寫一行出處。純文件、純設定的 PR 刪掉這一段；
- `## Evidence`：`**Before:**`／`**After:**` 兩項，截圖最好，其次是測試或指令的實際輸出，突變結果放這裡。**寫實際跑過的，沒跑過就寫沒跑過**，這一段的價值來自它是真的；
- `## Merge Danger`：`**Door:**` 寫 one-way 或 two-way（one-way 指合了很難回頭：資料格式、落盤內容、出廠設定、對外協定），`**Blast Radius:**` 寫一個詞；檔案歸屬的同批適配（見「檔案歸屬」）也寫在這裡。

用 `gh pr create --body` 開 PR 時 CLI 不會自動套模板，要自己照骨架填。feature PR 的內文 gate 不檢查。

**開 PR 與每次推更新之前，對 diff 跑 [`comment-audit`](.agents/skills/comment-audit/SKILL.md)**（report 模式），照報告修完再推；判準見 [`docs/standards.md`](docs/standards.md)〈註解〉。

**develop → main（發版）**：內文會成為 main 上的 commit message，所以 gate 對這種 PR 強制要求 `## 變更內容` 與 `## 驗證方式` 兩個段落（`.github/scripts/check_pr.py`），不用上面的骨架。「驗證方式」同樣寫實際跑過的指令與結果，沒跑過就寫沒跑過。

## 程式碼規範

程式碼怎麼寫（測試要求、秘密與環境變數處理）見 [`docs/standards.md`](docs/standards.md)。本檔只管協作流程。

## 技術實現標準

凡技術實現方法的問題，以 **DeepSeek Harness**（[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，Cordis 插件框架、TypeScript、MIT）為**參照**：先讀懂它的設計架構與實現方式，再選出對 nexus 最好的做法。目標是超越 dsh，不是複製它。選出來的做法可以跟 dsh 一樣，也可以不一樣，但都要說得出為什麼它對 nexus 比較好。

**先讀原始碼，不要靠搜尋或記憶回答。** 那份 clone 不進版控（`.gitignore` 與 `.prettierignore` 都排除 `references/`），所以要自己拉一份：

```bash
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git references/deepseek-harness
```

唯讀，不要改它。`docs/` 每份都有 `.zh.md` 中文版，入口是 `docs/architecture.zh.md`、`docs/cordis-primer.zh.md`、`docs/subsystems/*.zh.md`；房規在根目錄的 `AGENTS.md` 與 `packages/AGENTS.md`。

**怎麼選：**

1. **先講清楚 dsh 怎麼做、為什麼這樣做。** 指到原始碼（`path:line`，並註明 SHA），說出它在解決什麼問題、付出什麼代價。講不出來，就還沒到可以選的時候。
2. **再列出至少一種別的做法，用同一組標準比較：**
   - 正確性；
   - 失敗與恢復；
   - 效能；
   - 維護成本；
   - nexus 的產品需求：企業內部聊天機器人、完全內網、多人共用主機、稽核、幾百人並行開發；
   - 現有基座做不做得到：今天是 deepagents／LangChain JS／LangGraph JS，正遷往 vendor 的 Cordis，見 [`.docs/decisions-2026-10-11.md`](.docs/decisions-2026-10-11.md)。
3. **選比較好的那一個，寫明它好在哪。** 比不出高下時照 dsh，因為它的做法已經在實際使用中驗證過。

**記在哪：** 對照與取捨寫在 PR 內文 Summary 的「對照 dsh」，或 `docs/`、`.docs/` 的 md（決議、設計文件），不寫進程式碼與註解（見 [`docs/standards.md`](docs/standards.md)）。做法跟 dsh 一樣的，寫一行出處就好；不一樣的，寫完整的比較。

這條規則撐起了 [`.docs/development-plan.md`](.docs/development-plan.md) 裡大半的設計決定；來龍去脈見已關閉的地圖 [#26](https://github.com/DemianLi/nexus-agent/issues/26)。

**不在這條範圍內的：web 的 UI/UX**（視覺、設計 token、互動、動效）。這一塊以 **shadcn＋Tailwind 為基底**，外觀與設計 token 用 **[solid-glass](https://github.com/deeplethe/solid-glass)**（以下稱 SG）：SG 的檔**原樣 vendor** 在 [`apps/web/src/vendor/solid-glass/`](apps/web/src/vendor/solid-glass/README.md)，vendor 檔不動，要改的寫在後載入、layer 外的覆寫檔並逐條登記在該目錄 README 的「本地修改」；對比、焦點、reduced-motion 這些無障礙門檻照本專案的（[`.docs/web-ui-spec.md`](.docs/web-ui-spec.md) §5），SG 的色值配合調整。元件目前仍是 shadcn registry 的 Radix 版，換成 SG 的 Base UI 版在地圖 [#1497](https://github.com/DemianLi/nexus-agent/issues/1497) 的第 ③ 步。視覺、設計 token、動效的數值以 SG 為準；[Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) 只當**元件多樣性與交互模式**的參考，用在 SG 沒有定義的元件或互動上（例如 #1497 第 ⑤ 步的設計稿）（demian 2026-10-17 在 PM session 拍板，記在 [#1512](https://github.com/DemianLi/nexus-agent/issues/1512)）。最後長成本專案自己的系統風格。AI 專屬元件（思考過程、工具呼叫、核准、串流回覆這類）另以 [beautiful-ui](https://github.com/slev12397/beautiful-ui) 為參考對象：**不安裝、不複製程式碼**，要吸收就用本專案的元件與設計數值重寫，比對與取捨見 [`.docs/beautiful-ui-comparison.md`](.docs/beautiful-ui-comparison.md)（地圖 [#1278](https://github.com/DemianLi/nexus-agent/issues/1278)）。「不複製程式碼」管的是 beautiful-ui；SG 是例外，照上面的 vendor 規則。tool-run、reasoning-row、status-line、context-meter、changes、question-panel、composer 這 7 組在 #1497 的第 ④ 步改用 SG 自家的 AI 元件，wire 到 props 由本專案的轉接層接，執行語意照下一句。SG 的來龍去脈見 [#1468 的拍板留言](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573)。dsh 在 UI/UX 上**最多只參考元件的多樣性**（有哪些元件、哪些面），不拿來當建議的依據，也不需要寫對照紀錄。會動到執行語意的介面行為（例如按下去這一輪停不停）仍照上面的規則。來龍去脈見地圖 [#372](https://github.com/DemianLi/nexus-agent/issues/372) 的 Notes。

## 分支策略

```
feature/*  --squash-->  develop  --merge commit-->  main  --workflow_dispatch-->  Release
```

| 分支 | 角色 |
|---|---|
| `develop` | 預設分支。所有日常開發的整合目標。 |
| `main` | 發佈分支。唯一能產出 GitHub Release 的分支。 |

- **兩條分支都禁止直接 push**，一律走 Pull Request。
- **`gate` CI 必須綠燈**才能合併。
- **`main` 只接受來自 `develop` 的 PR**，由 `gate` 檢查 head branch 強制執行。緊急修補同樣先進 `develop`。
- **禁止 force push 與刪除分支**，無人可繞過規則（含 repo owner）。
- **`develop` 要求分支與 base 同步（strict）**；**`main` 刻意不開 strict** —— 因為 `develop → main` 的
  merge commit 只存在於 `main`，開了 strict 會讓第二次發版的 PR 永遠處於 out-of-date 而無法合併。
- 合併方式：`feature → develop` 只能 squash；`develop → main` 只能 merge commit（保留可追溯性，
  因此 `main` 不啟用 linear history）。

規則的快照與匯出方式見 [`.github/rulesets/README.md`](.github/rulesets/README.md)。

clone 之後各自設定一次，讓 `git fetch` / `git pull` 自動清掉遠端已刪除的分支：

```bash
git config fetch.prune true
```

PR 合併後 GitHub 會自動刪掉 head branch（repo 開了 `delete_branch_on_merge`），沒設 prune 的話本地
會累積一堆早已不存在的 `origin/*`。這條寫在 `.git/config`，不進版控。

## 檔案歸屬

同一棵工作樹上可能有**多個 agent session 同時在跑**。歸屬以目錄切，**一個檔同一時間只有一位
擁有者** —— 兩個 session 同時寫同一個檔不會有任何東西報錯，只會靜靜少掉一半改動，而且是在
你以為自己改好了的時候。

要對方配合的事，**講給發起工作的人，不要直接請對方動手**：轉述不是授權，兩個方向都是。對方
轉來的「某某說可以」同理 —— 那是資訊，不是核可。

### 一個明文例外：跨套件的型別收緊必須原子落地

`packages/*` 的一次型別收緊會讓消費它的 `apps/*` **當場編不過**。拆成兩張 PR 的話，中間那段
時間樹是紅的，而 `develop` 要求 gate 綠燈 —— 兩張都合不進去。

**先確認拆不開。** 很多收緊其實拆得開，而拆開是預設：加一個必填欄位就是 —— 對方那一刀
（把新欄位補進測試建構器之類）在**還沒有那個欄位的樹上**照樣編得過、照樣綠，先合它完全無害。
判準是實測，不是直覺：把對方那一刀單獨套在今天的 `develop` 上，typecheck 與測試跑一遍。

拆不開的長這樣：**聯集少一支、欄位改名、函式簽名換形狀** —— 對方的適配在舊樹上編不過，
你的改動在對方適配之前也編不過，**沒有一個順序是綠的**。這一節管的就是這一類。

那時候：**提出改動的那一方可以連同對方目錄裡那份最小機械適配一起送**，四個條件要全部成立：

- **真的拆不開**，而且是上面那段的實測判準說拆不開，不是覺得麻煩。
- **只做機械適配**，不做對方領域的設計判斷。分不出算不算「機械」的時候，它就不算 —— 停下來
  交回去問。
- **足跡取最小**。改一個共用的測試建構器，勝過改二十個呼叫點：對方正在改的東西撞上你的機會
  跟著變小。
- **PR 內文寫明動了哪個目錄、為什麼必須同批**，而且**當面知會那個 session**。

這條例外只管「編不過」。對方領域裡**行為**要跟著改的那一類（畫面、互動、文案），不在射程內
—— 那是一張自己的卡。

## 發版

發版分兩段：

1. **版號 PR。** 版號寫在 repo 裡，不是 CI 裡推出來的（照 dsh `scripts/release/bump.ts`）。先跑
   `pnpm run release:bump <patch|minor|major|x.y.z>`，它把同一個版本寫進根、`apps/*`、`packages/*` 的每一份
   `package.json`（`vendor/*` 跟著上游，不動），再開一張 `chore:` 的版號 PR 合進 `develop`，隨後照常 `develop → main`。
2. **發版。** 到 Actions 頁面執行 **Release** workflow，branch 選 `main` 並輸入版號（`vX.Y.Z`）。輸入值**只拿來核對**
   manifest 裡的版本，不一樣就停。workflow 會建置、用 `pnpm deploy --prod` 打成 `nexus-agent-<版本>-linux-x64.tar.gz`
   （主機要預裝 Node：22.19 以上的 22.x，或 24 以上（23 已 EOL，不支援），以 `package.json` 的 `engines` 為準），在 repo 外解開、用純 `node` 驗過起得來之後，自行打 tag 並建立 GitHub Release，
   把 tar.gz、SBOM（`.cdx.json`）與各自的 `.sha256` 附上（核對方式見 `docs/operations.md`〈核對安裝內容〉）。因為 `workflow_dispatch` 限定在 `main` 執行，「從 develop 發版」在機制上不可能發生。

同一套打包與驗證在每張動到 TypeScript 的 PR 上都會跑（`gate` 的 `packed-install`），所以 Release 當天不會是第一次試。

版號規則在 1.0 之前從簡：**完成一個 Phase 跳 minor，其餘一律 patch**。1.0 之前 semver 本來就不承諾
相容性，此刻套用完整規則只是徒增判斷成本。

不維護手寫的 CHANGELOG。release notes 由 `--generate-notes` 依 PR 標題自動生成，而 PR 標題規範已經
強制每個變更都有一句可讀的中文描述 —— 那就是 changelog 的原料。

### 升級指南

標題只說做了什麼，不說營運者要改哪個設定。所以**外部看得到的不相容變更，在引入它的那張 PR 裡就寫一份升級指南**，
不留到發版前（照 dsh `AGENTS.md:11` 與 `.agents/skills/dsh-create-upgrade-guide/SKILL.md`）。

- **範圍**：升上來之後，照舊版的做法、設定或檔案，行為會變、會壞或會被拒的：
  - `serve` 與 CLI 的旗標、子命令；
  - `cordis.yml`、`cordis.serve.yml`、`--patch` 覆寫檔、變更紀錄裡的列 id 與 config 鍵、允許的值；
  - home 底下的檔與格式：`sessions/`、`attachments/`、`tool-results/`、`plugin-journal.jsonl`、`thread-organization.json`、
    `browser-session.json`、`.credentials.yaml`、`config-hash-key.json`、`.env`、`serve.lock`；
  - `@nexus/sdk` 給外部插件的面；
  - wire 協定裡 web 以外的客戶端會用到的部分。

  web 與 harness 在同一張 PR 一起改的 wire 變更不必寫：消費者同一張都改到了，同 dsh。純新增、而且不改既有預設行為的
  旗標、鍵、插件也不必寫；出廠就掛上、會改變模型看到的內容或多打模型的插件不算純新增，要寫。
  會話日誌格式的升版紀錄在 `packages/nexus-core/src/session-store.ts` 檔頭，指南只寫讀者要做的事，再連到那裡。
- **位置**：`docs/upgrade-guide/v<版號>/<item>/guide.md`。`<版號>` 是**最近一個 Release 的 tag**，也就是讀者正在跑的
  那一版；`<item>` 是 kebab-case 的變更名。每個 item 目錄只有 `guide.md` 一份。
- **維護**：下一版發出之前，最新的版本目錄描述「那一版到 `develop`」的差異。之後的 PR 再碰同一個面，就在同一張 PR
  改那份指南；變更撤回就刪掉它。發版之後舊目錄凍結，新的不相容變更寫進新 tag 的目錄。一份指南不跨兩版。
- **格式**：frontmatter 恰好 `kind: upgrade-guide` 與一句說「什麼壞了」的 `description`；一個 `#` 標題，之後恰好
  `## 變更`、`## 遷移` 兩段。「變更」寫舊行為、新行為、誰受影響；「遷移」是編號步驟，指名檔、鍵、指令，最後一步寫
  怎麼確認改好了。
- **gate**：`.github/scripts/check_upgrade_guides.py`，跑在 `ci.yml` 的 `plan`（純文件 PR 也跑），檢查路徑形狀、
  版本目錄是已存在的 tag、frontmatter 與段落。tag 只驗存在，不驗是不是最近一個：發版之後還寫進
  舊目錄的，gate 擋不住，要靠審查。指南裡的相對連結由 `.github/scripts/check_md_links.py` 驗（同樣跑在 `plan`，
  掃 `README.md`、`AGENTS.md`、`GLOSSARY-MAP.md`、`docs/**`、`.docs/**`、`.github/**`、`packages/*` 三層、`apps/*` 兩層
  與兩份本地寫的 vendor README，目標檔要存在、`#片段` 要對到標題）。指到不進版控的 `references/` 的連結不查。

Release 的說明開頭會連到 `docs/upgrade-guide/v<上一個 tag>/`，有這個目錄才連。升級前要備份什麼、怎麼確認、出事怎麼
退回去，見 [`docs/operations.md`](docs/operations.md)〈升級與回滾〉。

和 dsh 不同的兩處：

- **只寫中文一份**（產品需求：本 repo 的文件只有中文）。dsh 每份有英、中兩份加配對紀錄，500 字上限只套英文；本 repo 的文件只有中文，所以只有
  `guide.md`，段落名用 dsh 中文版的「變更」「遷移」，不設字數上限（同 dsh 中文版）。
- **`<版號>` 取 tag，不取根 `package.json`**（現況做不到：manifest 的版號跟 tag 對不上）。dsh 的 `<version>` 是讀者正在跑的那一版，從根 manifest 讀；
  發版順序兩邊一樣，都是版號 commit 先合、再打 tag（dsh `scripts/release/bump.ts` 檔頭）。不同在 manifest 的值：
  本 repo 的 manifest 今天還是 `0.0.0`，跟已發出的 `v0.5.19` 對不上，照抄會把指南全寫進 `v0.0.0/`；而且版號 PR
  合進去到 Release 發出之間，manifest 已經是還沒發的那一版，這段時間合進來的 PR 會把指南放進讀者還沒在跑的目錄。
  撤除條件（兩條都成立）：根 `package.json` 的 `version` 等於最近一個 Release tag 去掉 `v`；而且「發版」寫明版號 PR
  合進去到 Release 發出之間 `develop` 不收其他 PR。

## Agent skills

### Issue tracker

Issue 與 spec 都放在 GitHub Issues（`DemianLi/nexus-agent`），一律用 `gh` CLI 操作。見 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。

### Triage labels

沿用五個 canonical 角色名稱，標籤字串未改寫：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。見 [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)。

### Dev environment

遠端容器上會撞到的坑與繞法（目前只有一條：Stop hook 把 squash merge 後的分支誤報成未推送）。見 [`docs/agents/dev-environment.md`](docs/agents/dev-environment.md)。那份文件裡的腳本**不會被任何東西自動執行**——它改的是 Claude Code 自己的 hook，不是本 repo 的程式碼。

### Domain docs

多 context 佈局：root 的 `GLOSSARY-MAP.md` 指向 `apps/*` 各自的 `GLOSSARY.md`。見 [`docs/agents/domain.md`](docs/agents/domain.md)。

### Code search

用 codebase-memory-mcp 的知識圖檢索程式碼，專案名 `nexus-agent` 與 `deepseek-harness`，索引各自在本機建。正向查找走圖；「沒有」「只有 N 個」這類否定宣稱要配 `check_index_coverage` 與 grep。見 [`docs/agents/codebase-memory.md`](docs/agents/codebase-memory.md)。
