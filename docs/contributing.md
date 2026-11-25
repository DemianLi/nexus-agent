# 提交規則

PR 標題與內文、分支、技術實現標準、ADR 與註解的規則。程式碼怎麼寫見 [standards.md](standards.md)，發版與升級指南見 [release.md](release.md)，專案怎麼跑起來見 [README.md](../README.md)。

## 分支

```
feature/*  --squash-->  develop  --merge commit-->  main  --workflow_dispatch-->  Release
```

兩條分支都只走 PR、`gate` 綠才能合，禁止 force push 與刪除，無人可繞過；`develop` 要求 strict。規則快照見 [`.github/rulesets/README.md`](../.github/rulesets/README.md)。分支命名 `<type>/<kebab-case>`，type 同下面的標題。

## PR 標題

PR 標題原封不動成為 `develop` 與 `main` 上的 commit 標題：

```
<type>: <中文描述>
```

type：`feat` `fix` `refactor` `perf` `test` `docs` `ci` `chore`，`develop → main` 用 `release`。描述是中文祈使句、8 到 50 字、說「做了什麼」而不是改了哪個檔；至少一個中文字，套件名與指令名保留原文；不寫「更新」「調整」這類填充句。gate 檢查 type、字數、中文與填充句（[`.github/scripts/check_pr.py`](../.github/scripts/check_pr.py)），擋下時改標題即可。

## PR 內文

- **feature → develop**：照 [`.github/pull_request_template.md`](../.github/pull_request_template.md)，段落標題與欄位名用英文、內文寫中文，用語照 [`GLOSSARY-MAP.md`](../GLOSSARY-MAP.md)。Summary 的圖優先用文字樹或 diff 草圖。第一行 `Refs #N`，不寫 Closes。`gh pr create --body` 不會套模板，要自己照填。Evidence **寫實際跑過的，沒跑過就寫沒跑過**。一般功能 PR 的內文 gate 不檢查；清掉註解裡 dsh 對照的 PR（階段 1，見下面〈對照 dsh〉）例外，內文要附逐句證據，本機跑 `python3 .github/scripts/check_dsh_cleanup.py` 印出要填的列。
- 開 PR 與每次推更新之前，對 diff 找出變更敘事的註解並刪掉（見〈註解〉），刪掉的列進內文。
- **develop → main**：內文要有 `## 變更內容` 與 `## 驗證方式`（gate 檢查）；驗證方式同樣只寫實際跑過的。

## 技術實現標準

技術實現以 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）為參照：先讀懂它怎麼做、為什麼，再比過至少一種別的做法，選對 nexus 最好的；目標是超越，不是複製。原始碼 clone 在 `references/deepseek-harness`（唯讀，不進版控）。web 的 UI/UX 照 [`web-ui.md`](web-ui.md)，會動到執行語意的介面行為仍照這一節。

### 對照 dsh

**先讀原始碼，不要靠搜尋或記憶回答。**

1. **廣度**：找出 dsh 與 nexus 相關的符號與呼叫路徑。「沒有」「只有 N 個」這類否定宣稱要再用 grep 核對一次。
2. **深度**：對關鍵點讀原始碼，引用寫 `path:line` 並註明 SHA。說出 dsh 在解決什麼問題、付出什麼代價；講不出來，就還不能選。
3. **選**：至少比一種別的做法，用同一組標準比：正確性、失敗與恢復、效能、維護成本、nexus 的產品需求（企業內部聊天機器人、完全內網、多人共用主機、稽核、幾百人並行開發）、現有基座做不做得到。選比較好的那一個；比不出高下就照 dsh，因為它的做法已經在實際使用中驗證過。

比較結果寫在 PR 內文 Summary 的「對照 dsh」；符合下面 ADR 條件的寫成 ADR，「對照 dsh」只放一行連結。不寫進程式碼與註解。

**清掉程式碼註解裡的 dsh 對照的 PR**（階段 1：dsh 計數下降，而且除了註解與字串內容，程式碼沒變）有三條規則，gate 會讀這張 PR 的內文（[`.github/scripts/check_dsh_cleanup.py`](../.github/scripts/check_dsh_cleanup.py)）：

1. 帶 dsh 對照的句子預設整句刪。要留或改寫，內文逐句附 nexus 實作的 `path:line`；改寫與新增的每一句，內文都要有一列四格的表格列：`| 整句 | 位置 | path:lo-hi | 原文片段 |`。第三格要有在 head 上存在的 `path:line` 或 `path:lo-hi`（句子跨到的每一行都不算）；第四格從那幾行抄一段原文（壓掉空白、反引號、`|`、`*` 後比對，所以斷行、縮排不用照抄，也不必抄整行）。引的範圍去掉空白、括號與標點後什麼都不剩（空行、只有 `}` 之類），或抄的片段在那幾行裡找不到，gate 就紅，錯誤訊息會寫出那幾行實際的內容。script 只證明「引的行在 head 上，而且內容是你抄的那一段」；那幾行撐不撐得起那一句，由 verifier 判。
2. 階段 1 不改段名（註解裡的 `##` 標題與表格的名稱格；含 dsh 的段名不在此限，括號裡的說明不算）。改名留給階段 2，跟所有指向它的地方同一張 PR 改。
3. 刪掉一段或段名之前，找全 repo 指向它的地方；script 列出候選，每一個要在這張 PR 改掉，或在內文有一列（`| path:line | 詞 | 為什麼仍成立 |`，理由放最後一格，命中的詞不算理由）。

本機跑 `python3 .github/scripts/check_dsh_cleanup.py` 印出第 1、3 條要填的列，貼進內文再補。補完內文不用推 commit，gate 會用新內文重判。

程式碼裡的 dsh 引用數與註解裡的變更敘事用語只降不升，由 [`.github/scripts/check_ratchets.py`](../.github/scripts/check_ratchets.py) 擋，基準在 [`.github/ratchets/`](../.github/ratchets/)；清掉引用的 PR 要在同一張把基準調低（`python3 .github/scripts/check_ratchets.py --write`），基準不能調高。

## ADR

三個條件都成立才寫：**難以撤回、少了背景會讓人意外、是真的取捨過的結果**。少一個就不寫，比較留在 PR 內文。

- 全系統的決策放 [`adr/`](adr/)，單一 app 的放 `<app>/docs/adr/`（harness 是 `harness/apps/harness/docs/adr/`）；`harness/packages/*` 的歸到根目錄。
- 檔名 `NNNN-<kebab-slug>.md`，四位數編號從 `0001` 起依序遞增、不跳號。第一行 `# <標題>`，正文一段話說清楚情境、決定與理由就夠；有價值時才加「Considered Options」與「Consequences」。位置、檔名、編號與標題行由 gate 檢查（[`.github/scripts/check_adrs.py`](../.github/scripts/check_adrs.py)）。
- `docs/` 只寫現況；決策與取捨寫 ADR。

## 註解

註解寫 HEAD 的現況，變更的來龍去脈寫在 PR 內文，細則見 [standards.md](standards.md) 的〈註解〉。合併後 PR 內文會成為 `develop` 上的 commit 訊息。

## 外部看得到的不相容變更

在引入它的那張 PR 寫升級指南，格式與版號規則見 [release.md](release.md)。PR 內文的 Merge Danger 附上升級指南的路徑。
