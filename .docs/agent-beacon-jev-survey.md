# agent-beacon 把 Jev 用在哪裡

[Asymptote Labs / agent-beacon](https://github.com/Asymptote-Labs/agent-beacon)（Go、MIT、跨 harness
擷取 agent session）是目前找得到的**第二個**把 TypeSafe Jev 接上產品路徑的專案。這份筆記只回答一個
問題：**它把 Jev 用在哪一個位置、驅動什麼**。

**調研日期**：2026-09-23。**對照版本**：agent-beacon `2f1f016`（2026-09-22，預設分支 `main`）。

clone 在 `references/agent-beacon`，不進版控（`.gitignore` 擋 `references/`）。要重現的話：

```bash
git clone --depth 1 https://github.com/Asymptote-Labs/agent-beacon.git references/agent-beacon
```

## 這份筆記的來源與可信度

**全部是讀原始碼得到的，沒有跑過 beacon。** 這台機器上沒有 `beacon`、沒有 Go 工具鏈、沒有
`~/.beacon/`，也沒有任何被擷取的 trace，所以連 `--dry-run` 都選不到東西（實際會印
`Selected 0 trace(s)`——見 §七）。下面每一條宣稱都配得上一個 `檔案:行號`，**沒有一條來自實跑**。

**「只有一個呼叫點」這條用兩種方式數過**，因為單靠字樣掃描會漏：一個 `learning.Evaluate(...)`
的呼叫點不需要在檔案裡提到 `jev`。

- 全樹 `grep -rniIl "jev"`：命中 `cmd/memory.go`、`internal/learning/evaluator.go`、docs、
  以及三個測試檔。
- 不依賴字樣的 `grep -rn "learning.Evaluate\|CandidateFromEvaluation"`：只有
  `cmd/memory.go:236` 與 `:244`。

兩個誤中要排掉：`browser-extension/package-lock.json` 是 integrity 雜湊裡的 base64 巧合；
`internal/endpoint/dashboard/server_test.go:182` 是測試寫死的 `Evaluator: "jev"` 字串。

---

## 一、唯一的呼叫點

```
cli/beacon/cmd/memory.go:236    learning.Evaluate(ctx, evaluatorOpts, input)
```

Beacon 的主線——跨 harness 抓 session、寫 runtime JSONL、建 trace 索引——**完全不碰 Jev**。
Jev 只出現在事後的一步：`beacon memory evaluations run`，把已經抓到的 trace 送去判。

端點與預設值在 `internal/learning/evaluator.go:19-24`：

| 常數 | 值 |
| --- | --- |
| `DefaultJevEndpoint` | `https://api.typesafe.ai/v1/systemone` |
| `DefaultJevModel` | `jev-latest` |
| `DefaultCostPerTrace` | `0.00035`（只用於 dry-run 估價） |
| `RubricVersion` | `beacon.learning.rubric.v1` |

## 二、送什麼、問什麼

一份 `state` 送一次、所有題平行判。`state` 裝三個鍵：投影過的 trace、`rubric_version`、
`rubric_hash`（`evaluator.go:275`）。

題組寫死在 `evaluator.go:27`，三題，**全部是 `noul`**（是非題），每題附一組 `criteria` 的
true/false 說明句（`evaluator.go:336`）：

| id | 問題 |
| --- | --- |
| `task_success` | 這條 trace 有沒有真的把使用者的工程任務做完 |
| `reusable_correction` | 裡面有沒有未來 agent 該重用的修正／除錯模式 |
| `evidence_supported` | 那個可重用的教訓有沒有具體事件撐著 |

回應端 `questionsFromJevAnswers`（`evaluator.go:351`）依序試 `noul` → `probability` → `score`
取出純量當機率。`jevAnswer` 那個 struct 同時吃三種題型所以欄位寬鬆，**不能拿它反推 API 行為**。

## 三、機率流到三個地方

**一、當閘門。** `candidate.go:16`：`eval.Score < CandidateScoreThreshold`（0.60，`candidate.go:10`）
就不生候選。**這是 Jev 在整個產品裡唯一會改變行為的一刀。**

**二、印進候選內文。** `candidateBody`（`candidate.go:172`）把三個數字逐行寫進 body。

**三、連同 trace 出處、evaluator 型號、usage 一起存進 `memory.db`**，供列表排序與人工 review。

### 3.1 那道門檻有個值得看的性質

`Score` 是三題機率的**算術平均**（`evaluator.go:389` 的 `sum / float64(len(results))`），門檻壓在
平均上。三題平均 0.60 等於總和 1.80——所以：

```
{task_success: 1.0, reusable_correction: 0.8, evidence_supported: 0.0}  → 平均 0.60，過關
```

「教訓完全沒有事件撐著」這一題拿 0 分照樣進候選。**沒有任何一題有自己的下限**，平均把
「是哪一題不合格」這個資訊丟掉了。

附帶一條：`evaluator.go:144` 的 `if resp.Score != nil` 會讓**伺服器回傳的 score 蓋掉本地算的
平均**，所以這一刀也可能是對方那側在決定。

### 3.2 分類那一格不是 Jev 判的

記憶的 `kind`（`convention` / `gotcha` / `workflow` / `debugging_pattern` / `correction`）由
`candidate.go:148` 的 `candidateKind` 決定，做法是對 **trace 標題**做 `strings.Contains`
關鍵字比對。Jev 的機率只管「進不進候選」那一層，分到哪一類跟它無關。

（文件寫「Jev probabilities help rank and classify traces」不算說錯——0.60 那一刀本身就是一次
分類。但**記憶種類的分類法**確實不是模型判的，讀的時候要分開這兩層。）

## 四、篩子有了，筆沒有

這是追到底之後最清楚的一件事。`candidateBody` 產出的是一份模板：

```
Reusable lesson extracted from a reviewed Beacon trace.

Trace: session:claude:xxxx
Harness: claude
Observed workflow: <trace 標題>

Evaluation signals:
- task_success: 0.94
- reusable_correction: 0.81
- evidence_supported: 0.77
```

這份 body **原封不動**流到 memory（`candidate.go:61` 的 `Body: candidate.Body`），再原封不動被
`RenderSkill` 塞進 `SKILL.md` 的 `## Guidance` 底下（`skills.go:60-61`）。

**從 approve 到 install 之間沒有任何編輯路徑**：`ApproveCandidate`（`candidate.go:44`）只多收一個
`reason`，CLI 也沒有改 body 的指令（`cmd/memory.go` 裡 `Body` 只出現在一個 `Fprintln`）。

所以裝出來的那份 skill，「指引」的位置放的是**一個 trace 指標加三個數字**，不是一句教訓。
這正是 Jev 不生成自由文字的直接後果：它判斷得出哪條 trace 值得留，但整條管線裡**沒有任何東西
負責把教訓寫出來**。

## 五、有界投影怎麼做

`BuildProjection`（`evaluator.go:178`）的兩個上限在 `evaluator.go:23-24`：
`maxProjectionEvents = 80`、`maxProjectionText = 1200`（每個欄位）。

超長 trace 不是砍前 80 筆，而是**取頭 40 ＋ 尾 40，中間塞一筆 `type: "omitted"` 的合成事件**
（`evaluator.go:191-204`）。原始碼註解寫明理由：長會話在結尾才收斂，只取前 N 筆的話評估者
永遠看不到修好的那一刀。

## 六、題組釘成雜湊

`RubricHash()`（`evaluator.go:225`）是題組的 sha256，**跟著每一筆 evaluation 一起存**，也一起
送進 `state`。這樣事後分得出哪些評測出自哪一版題目。

注意射程：**它釘的是題組，不是投影函式**。投影改了同樣會讓舊評測失去可比性，而那一半
agent-beacon 也沒有防線。

## 七、明確不碰 Jev 的路徑

| 路徑 | 依據 |
| --- | --- |
| hook 擷取 | 完全本地；`docs/concepts/cross-harness-memory.mdx:81` |
| `--dry-run` | 走 `learning.Preview`，零網路請求（`cmd/memory.go:229`） |
| MCP server | import `learning` 但只呼叫 `learning.Open` 讀 store，無 `Evaluate` 呼叫點 |
| dashboard | 同上（`internal/endpoint/dashboard/memory.go:11`） |
| candidate 核准、skill 安裝 | 純本地 CLI 動作 |

缺 runtime log 時不會報錯：`dashboard/events.go:169` 的 `streamSource` 對 `os.IsNotExist` 回 `nil`，
`learning.Open` 也只存路徑不碰磁碟。所以在一台沒擷取過任何東西的機器上，`--dry-run` 會乾淨地
印出一行 `Selected 0 trace(s); estimated Jev calls: 0; estimated cost: $0.00000`
（格式見 `cmd/memory.go:255`），後面一筆 preview 都沒有。

## 八、對我們的拍板：不改任何一條

[`decisions-2026-09-22.md`](decisions-2026-09-22.md) 的射程（`looping`、純觀測、窄投影）**原樣有效**。
這份筆記不提議重開任何一題。兩點說明：

- **技術實現標準是 dsh，agent-beacon 不是。** 這裡記的是一個資料點，不是新的依據。
- 有一個**獨立收斂**值得記一筆：另一個把 Jev 接上產品路徑的團隊，落在跟我們 §四 D 偏離二相同的
  姿態——機率只排序與篩選，不自動改指令、不自動裝 skill、不執行動作。但這**不滿足** §四 C 的
  重開條件（那條要求「正例來自沒被設計過的情境、且跨得過一顆以上的模型」，agent-beacon 一條
  都沒碰到）。

## 九、一件順手發現的事

`cli/beacon/beacon.zip`（15.5M，內含 35MB 的 macOS 執行檔）**確實在版控裡**，但 repo 內沒有任何
東西引用它，檔案日期 06-18 而 HEAD 是 09-22，且 `.gitignore` 擋了 `cli/beacon/beacon` 與
`cli/beacon/beacon-*` 卻沒擋 `.zip`。看起來是漏進版控的，不是刻意提供的發佈物。**不要解開執行。**
