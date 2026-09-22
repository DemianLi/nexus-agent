# 操作指南

跑起來之後會撞到的事：圍堵、會話日誌、瀏覽器會話的安全約束、執行上限、評測。
怎麼安裝與怎麼起一條 agent 見 [README.md](../README.md)；協作流程見 [AGENTS.md](../AGENTS.md)。

## 檔案圍堵

**要 `--workspace` 才存在。** 沒給的話檔案跑在虛擬檔案系統裡，那道 fence 根本不在路徑上。

給了之後 `--sandbox <mode>` 決定**起始**強度——`read-only`、`workspace-write`（預設）、
`danger-full-access`——而跑起來之後 `/sandbox` 切得動它：不帶引數報告現在是哪一格，帶一個模式名
就切過去。切換同時作用在兩個地方：檔案工具擋不擋得住，以及模型自己知不知道現在在哪一格
（那句話每次模型呼叫重算）。每一次真的變了都會在會話日誌裡留一顆 `sandbox/mode`，接線當下也會
釘一顆起始值——所以一份日誌答得出「這一輪跑的時候政策是哪一格」。

**被擋下來時，模型可以請一次升級。** 拒絕後面會接一行指引，模型照著呼叫
`request_sandbox_escalation`，指名那個檔、要升到哪一格、一句給人看的理由；核准卡上看得到這三樣。
核准之後**只有那一個檔的下一次變更**在升上去的那一格跑，用完就沒了，session 的模式不動。
不比現在寬的請求不會去問人。

**沒有 `--workspace` 的組裝不會有 `/sandbox`、那句話，也不會有升級工具**：一格圍堵都沒有的時候
講「目前是 workspace-write」是說謊。

## 會話日誌

**預設不落盤。** `--session-log <dir>` 給了才寫，缺席就是只在記憶體裡活著（banner 第六行會說現在是
哪一種）。沒有預設路徑是刻意的：日誌裡有你打的每一句話、模型的每一則回覆，以及工具讀到的檔案內容
與指令輸出——連同裡面可能有的秘密，預設往家目錄寫是一個該由人做的決定。

> **這條政策已經被拍板要改，但還沒落地。** 2026-09-19 拍板改成照 dsh 預設落盤到
> `~/.nexus-agent/sessions`（[#444](https://github.com/DemianLi/nexus-agent/issues/444)）。
> 上面寫的是**程式碼現在的實際行為**。

三條約束：

- **不能指到 `--workspace` 底下。** 寫在可寫根裡，模型自己 `read_file` 就讀得到、也改得動整份對話史。
- **要指到一個留得住的目錄。** 指進 `/tmp` 或某個會被清掉的暫存目錄，那一跑跑完就什麼都沒剩。
  留得住**不等於**往家目錄丟——上面那條理由沒有變。
- **遙測開著的話這些內容也原樣送出去**；部署方的脫敏規則只作用在送出去的那一份，本機的 jsonl 照舊是原文。

CLI 每一次啟動各自一個 run 目錄，一份會話一個 `.jsonl` 加一個 `.header.json`。`serve` 吃同一個旗標，
會話根按目錄分，底下一條 thread 一個檔。eval 那條路沒有會話日誌，而那是一個登記過的決定
（理由與絆索見 `apps/harness/src/eval/runner.ts` 的檔頭）。

日誌記哪幾種事件見 `session-log.ts` 的聯集。格式 9 起它記的是整段對話：人打的字、模型的回覆、
工具呼叫與它的結果、外掛塞進對話的話、壓縮的摘要。要留 live 跑的證據，留 JSONL 就夠了。

## 接著上一次跑下去

CLI 用 `--resume <run 目錄>` 讀回那個目錄裡 root 的那一份日誌、往同一個檔續寫；serve 不用旗標——
碰到一條以前在同一個會話根寫過的 thread 就接回來。

**回來的是日誌上推得出來的**：沙箱模式、目標（授權打回 disarmed，要 `/goal resume` 才會再往下走）、
計劃模式，以及對話——模型歷史從日誌推出來、在第一輪之前灌回模型。**推不出完整歷史的就不灌半截**，
模型從空的開始，入口會講原因。

**回不來的**：虛擬檔案系統、工具結果暫存，以及停在核准點還沒答的那張卡——它們只在 graph state 裡。

**接得回來要站在同一個地方**，兩道守衛，兩個入口都擋：

- **同一個目錄。** 一份會話記著它建立當下的工作目錄，接不回別的目錄；**沒記的也拒**，不猜。
- **同一個工作區。** 格式 13 起還記著 `--workspace` 解析出來的根。同一個目錄底下換一個
  `--workspace` 接回來，上一段日誌裡那些檔案路徑就指到另一個工作區裡的同名檔了，而畫面上
  跟讀對了一模一樣——所以擋下，訊息會講出該用哪一個根。**13 以前寫的日誌沒有那一格**，
  那些照常接得回來（也不會被補上：錨是整份日誌一個值，補進去等於替更早的事件宣稱一個沒人
  驗證過的根）。

`--resume` 不能配 `--sandbox`（模式從日誌來，要換就接起來之後 `/sandbox`）或 `--session-log`
（就寫回那個目錄）。**同一份會話同一時間只有一個行程寫得進去**：另一個行程還開著它時當場擋下。
只有 macOS 與 Linux 鎖得到；其他平台照常寫，第一次要鎖的時候講一聲。

web 那端把 thread id 記在瀏覽器裡，重新整理之後接的是同一條。切回以前的 thread 時，之前說過的話
照日誌重播在畫面上，一次最後 50 則，更早的按「載入更早的對話」往前翻。

## 瀏覽器會話的安全約束

**網頁與 API 都要瀏覽器會話。** `serve` 印出來的網址帶著這個行程的 token，開一次就換到一顆 cookie
（`HttpOnly`、`SameSite=Strict`、30 天，serve 重啟之後照樣有效），沒有 cookie 的請求一律 401。
綁 `127.0.0.1` 擋不住同一台機器上的其他使用者，這顆 cookie 才擋得住。

- **那一行是敏感輸出。** token 在 serve 活著的期間都換得到 cookie。別貼給別人，也別把 serve 的輸出
  轉存到別人讀得到的檔——`serve > serve.log` 在預設 umask 下是 `0644`。
- **簽章密鑰住在 harness home**：`~/.nexus-agent/browser-session.json`（目錄 `0700`、檔案 `0600`；
  `NEXUS_AGENT_HOME` 可以換位置）。刪掉它再重啟 serve，所有瀏覽器會話一起失效；這個檔別人讀得到
  的話，serve 會拒絕啟動並告訴你要跑的 `chmod`。
- **serve 沒在跑的時候別開那個網址。** cookie 是持有即用的憑證：別人趁 serve 沒跑先佔住同一個 port，
  你的瀏覽器（經 SSH 轉 port 也一樣）就會把 cookie 送給他，等你在同一個 port 重開 serve，那顆 cookie
  仍然有效。懷疑外洩時刪掉 `~/.nexus-agent/browser-session.json` 再重啟 serve，所有既有會話一起作廢。
- **在多人共用的主機上**，只支援從自己的電腦用 SSH 轉 port 連進去：

  ```bash
  ssh -L 8787:127.0.0.1:8787 <主機>
  ```

  然後在自己電腦的瀏覽器開 serve 印出的網址。

**網頁從來不由 Vite 服務**（[#426](https://github.com/DemianLi/nexus-agent/issues/426)）：`vite` 與
`vite preview` 會拒絕啟動。Vite 的開發伺服器會把整個 repo 的檔案交給連得到那個 port 的任何人，
而部署主機是多人共用的。網頁由 `serve` 自己服務 `apps/web/dist`，所以改了網頁要等重建完再**手動重新整理**，沒有 HMR。

## 執行上限

**agent 迴圈的上限是組裝點設的不是基座設的。** `createDeepAgent` 自己把 `recursionLimit` 設成 `1e4`
（等於沒有上限），所以 `createNexusAgent` 蓋成 100。預設組裝每一輪模型呼叫佔三格，所以那是約 33 輪；
每多一個 `beforeModel` 的 middleware 每輪就多一格。CLI、`serve`、eval 都吃這個值；這條擋的是
「跑掉了」，不是「複雜任務」。

**要改它有三條路，由贏的順序排**：程式裡直接傳 `recursionLimit`；CLI 打 `--recursion-limit <n>`
（`serve` 沒有這個旗標）；或在 plugin 清單裡改 `recursion-limit` 那一列的 `config.limit`——**那條
兩邊都吃，是 `serve` 唯一調得動它的辦法**（[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
上面兩條任一個在場都贏過清單，清單再贏過內建的 100。那一列見〈plugin 清單〉。

**一次性模式撞到這條上限時退出碼是 `2`**，其他失敗是 `1`，所以包它的腳本分得出「護欄切掉了」與
「壞掉了」；REPL 裡撞到只印一行，不退出。

**目標不會自己往下走，除非你說可以。** `--goal-driver`（CLI 與 `serve` 共用）打開之後，一個 active
的目標在每一輪落定時會自己再開一輪，直到它被完成、被擋住，或用完自己的 `max_goal_rounds`（預設 256）。
預設關。模型從第 `blockedAfterConsecutiveRounds` 輪（預設 3）起可以把自己標成 blocked 而退出迴圈，
但那是准許不是保證。額外那條「連續 N 輪沒進展就停」刻意沒做，理由在
`apps/harness/src/goal-driver.ts` 的檔頭。

## plugin 清單

零設定的 CLI 與 serve 掛哪些 plugin，由**出貨的 `apps/harness/cordis.yml`** 決定
（[#454](https://github.com/DemianLi/nexus-agent/issues/454)）。那份檔案進版控，是「這個
agent 由什麼組成」的唯一來源。

要改它不是去編輯那份檔案，而是疊一層自己的 patch。**三層，後面的蓋前面的**：

1. 出貨的 `apps/harness/cordis.yml`
2. `$NEXUS_AGENT_HOME/cordis.patch.yml`（預設 `~/.nexus-agent/cordis.patch.yml`）
3. 任意個 `--patch <檔>`，照命令列順序

patch 檔是一個頂層 YAML 陣列，每一列按 `id` 指到一個條目：

```yaml
# 把 todo 關掉
- id: todo
  disabled: true

# 換掉 feedback 的設定。**整份替換，不是深層合併**——想保留的欄位要一起重述
- id: feedback
  config:
    maxNoteBytes: 4096

# 插一個原本不在清單裡的 plugin
- insert:
    - id: mcp
      name: '@nexus/plugin-mcp'
      config:
        servers: []

# 插一顆自己寫的：路徑錨在這個 patch 檔旁邊（`./` 與 `../` 都可以，絕對路徑也可以），
# 模組要 `export default` 那顆 plugin
- insert:
    - id: my-probe
      name: './my-probe.ts'
```

幾條會讓人踩到的規則：

- **`config` 是整份替換。** 這一條照 dsh，理由是 patch 疊 patch 的深層合併沒有人推得出最後
  的值。
- **指到不存在的 `id` 只會警告，不會失敗。** 一份 patch 給多台機器共用時不必每一棵樹都命中。
- **寫了 `name` 就變成斷言**：對不上那一列就整條跳過，原列一個字都不動。它是防手滑的，不是
  選擇器。
- **空檔與只有註解的檔會讓啟動失敗。** 要停用某一層請寫 `[]`——「我把它清空了」與「我把它
  寫壞了」在磁碟上長得一樣，所以不猜。
- **patch 檔只有你自己動得了才會被接受。** 檔案本身與它每一層上層目錄都不能讓群組或其他人
  可寫（sticky 的目錄除外），否則拒絕啟動。這台機器是多人共用的，而一份 patch 檔決定這個
  行程**載入哪些模組**——`insert` 進來的列會被直接 import，相對路徑錨在 patch 檔旁邊。
- **核准閘門關不掉。** `- id: approval-gate` ＋ `disabled: true` 不是一行被忽略的字，是
  **啟動失敗**，`--dump-config` 也一樣擋。詳見下一節最後一列。

### core 自己那幾顆 middleware

有幾顆 middleware 住在 `@nexus/core` 裡、由組裝時的折疊決定位置，但**設定從這份清單來**
（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。它們在清單上長得跟別的條目
一樣，只是 `name` 指到 core 的一個子路徑：

```yaml
- id: repeat-reminder
  name: '@nexus/core/repeat-reminder'
  config:
    thresholds: [3, 5, 8]
    include: []
    exclude: []
    argumentsPreviewChars: 500
```

- **關掉就是 `disabled: true`**，語意跟別的條目一樣：那一顆 middleware 真的不在 stack 裡，
  root 與每一個 subagent 都沒有。
- **改設定就在 patch 檔裡重寫這一列的 `config`**。整份替換的規則照舊——但**沒重述的欄位會回到
  預設值，不是回到出貨檔寫的值**。出貨檔那幾行寫的就是預設值本身，所以這兩件事今天結果相同；
  真正的差別要在你先用一層 patch 改過、第二層 patch 又只寫一格的時候才看得到。
- **這幾列不是功能開關。** 它們不多一顆工具、不多一個命令、不改 prompt；middleware 本身一直
  都在，這一列的作用是讓 `disabled: true` 與 `config` 指得著它。**有一列是例外**：
  `approval-gate` 關不掉，理由在本節最後。
- **程式路徑上直接傳的參數贏過這份清單。** 嵌入方自己叫 `createNexusAgent` 並明著傳
  `repeatReminder` 時，以那句話為準；而手搭 plugin 清單（沒有這幾列）的組裝拿到的是內建
  預設，不是「什麼都沒掛」。

今天有十一列：

| id | 管什麼 | 有 `config` 嗎 | 關得掉嗎 |
| --- | --- | --- | --- |
| `repeat-reminder` | 連續重複同參數呼叫同一個工具時提醒模型 | 有（四格） | 關得掉 |
| `tool-result-pruner` | 摘要之前先剪掉過長工具結果的中段 | 有（三格） | 關得掉 |
| `summarization` | 壓力達標時把舊訊息摘要成一則，歷史 offload 到 backend | 有（四格） | 關得掉 |
| `observation-policy` | 先讀後改：沒讀過的檔不准改 | **沒有** | 關得掉 |
| `model-usage` | 每一次模型呼叫的 token 帳目記進會話日誌 | **沒有** | 關得掉 |
| `approval-gate` | 核准閘門 | **沒有** | **關不掉** |
| `session-persistence` | 會話日誌落盤的批次窗口（毫秒） | 有（一格） | **關不掉** |
| `thread-title` | 執行緒列表上標題的兩個上限 | 有（兩格） | **關不掉** |
| `browser-session` | 瀏覽器 cookie 的絕對有效期 | 有（一格） | **關不掉** |
| `deliverable-files` | 交付檔的三個上限（一頁位元組／整檔位元組／一頁行數） | 有（三格） | **關不掉** |
| `recursion-limit` | agent 迴圈的 super-step 上限 | 有（一格） | **關不掉** |

**最後五列都是「不裝功能、只講設定」的那一型，但擁有者分兩邊**：`session-persistence` 住在
`@nexus/core`（值的家在那個套件裡），其餘四列住在 `apps/harness`
（[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
**更要緊的分界是消費點跑的時刻**：

- **`session-persistence`、`thread-title`、`browser-session`、`deliverable-files` 跑在註冊表存在
  之前**，所以 `apply` 是空的、值在起動期解一次往下傳。前三者的消費點分別是 serve 的冷讀清單、
  瀏覽器會話的建構子、兩條交付路由所在的 `createWireHandler` 閉包，**只在 `serve` 上有作用**；
  **`session-persistence` 是這一層裡唯一兩條路都讀的**——`cli.ts` 與 `serve.ts` 各自在接落盤時
  讀它。
- **`recursion-limit` 相反，它的消費點在組裝期**（`agent-factory`），跟前六列同一個位置，所以它
  跟前六列完全同形（`apply` 提供一顆服務、組裝點去讀）。**CLI 的 `--recursion-limit` 仍然贏過
  這一列**——程式路徑上直接傳的參數贏過這份清單，那條規則對它照樣適用。

**這五列都關不掉**，但理由分兩種。起動期那四列是「關掉沒有意義」：它們**不裝任何東西**，關掉
不會讓標題不再被裁切、cookie 不再過期、交付檔不再有上限、落盤不再批次——那一列被當成沒有那一列，
值回到 schema 的預設，行為一個位元組都不變。`recursion-limit` 硬一級
——關掉它確實會讓那顆服務消失，但組裝點接著落回內建的 100，**護欄還在**，讀起來卻像把迴圈上限
解除了（基座自己那層是一萬）。兩種都只會讓你以為關掉了什麼。寫 `disabled: true` 是啟動失敗，
**訊息會指名你那一列自己的理由**，不是一段通用的話。

**`session-persistence` 的 `windowMs` 有兩個方向的邊界**：`0` 合法，意思是不批次、每一顆事件各
寫一次；上限是 `setTimeout` 收得住的 2 147 483 647，**超過它的值會讓計時器立刻觸發**（等於窗口
消失，也就是最勤的那一種，不是最懶的），所以那種值在載入期就失敗，不會靜靜跑起來。

`observation-policy`、`model-usage`、`approval-gate` 那三列**不可以加 `config:`**——它們沒有
設定，載入器對「這顆 plugin 沒有 Config schema 卻給了 config」是當場拋。前兩列列在這裡的唯一
意義就是讓 `disabled: true` 指得著；最後那一列相反，見本節最後。

**關掉 `observation-policy` 等於這個組裝接受盲改**，不是省一點開銷：模型可以對一個沒讀過的
檔直接 `edit_file`。只有「只寫新檔、從不編輯」那種批次流程才該關它。

**`tool-result-pruner` 只在摘要開著時有作用**（摘要不掛就沒人叫剪刀），但它的設定照樣在載入
期驗——寫錯不會因為今天剛好沒用到就放過。

**關掉 `model-usage` 之後，落盤日誌裡就沒有逐次呼叫的 token 帳了。** 而且**不會有任何東西
當場變少**：今天樹上沒有一處在加總 `model/usage`——基準測試那條路的用量數字是它自己從模型
回報的 `usage_metadata` 加的，跟這一列無關。所以這個代價只有從這裡讀得到，沒有人會替你紅。

**`approval-gate` 關不掉，寫了 `disabled: true` 是啟動失敗。** 這一列跟上面五列不同型：上面
五列的 `disabled` 真的會讓那一顆 middleware 不在 stack 裡，這一列的 `disabled` 是一個錯誤，
`--dump-config` 也一樣擋（檢查住在條目驗證那一步，兩條路共用）。

理由是它不存在的時候那條 patch 的下場：`- id: approval-gate` ＋ `disabled: true` 只會在 stderr
印一行「找不到 id」然後跳過，`exit 0`，而 `--dump-config` 的輸出跟沒帶那份 patch **逐字相同**
——核准其實照樣在問，但讀起來像關掉了。這台機器是多人共用的，那個誤會的代價由別人付。
今天也沒有任何設定關得掉閘門：它由組裝時無條件建起來，把核准政策設成停用也只是讓需要核准的
工具確定性地回一則錯誤，不是拿掉它。

這一列的第二個作用跟擋人無關：**它讓核准在 `--dump-config` 裡看得見**。沒有它的時候那份 dump
從頭到尾沒有任何一列跟核准有關，想確認「這台機器上核准是開的嗎」的人分不出來。

**關掉 `summarization` 連帶關掉的比你想的多**：沒有摘要、沒有歷史 offload、也沒有上面那把
剪刀，而且上下文溢出時基座那條緊急摘要也一起沒有。它的 `config` 那四格是**整顆換**的
（給了 `truncateArgs` 就要把它底下兩格都寫出來），而 `trigger` 那兩個數字的來歷寫在
`DEFAULT_SUMMARIZATION` 的檔頭上——**換模型要重量一次**。

**最後五列的 `config` 同樣是整份替換。** 沒重述的欄位回到 schema 的預設值，不是保留原本那一列
寫的值——例如 `thread-title` 只寫 `maxBytes` 的話，`maxWords` 拿到的是預設的 5。`thread-title`、
`browser-session` 與 `deliverable-files` 的預設（`5`／`40`、`30` 天、2 MiB／32 MiB／5000 行）都照
dsh 的產品組裝；**`session-persistence` 的 `10` 毫秒沒有 dsh 的對應物**——dsh 的落盤後端只收根目錄
與壓縮兩格，它的批次是呼叫端傳一整批而不是計時器攢批，所以這個旋鈕是我們自己的，形狀抄的是
同一份清單上 core 那幾列；**`deliverable-files` 的 `maxLines` 是雙用的**——它同時是「不給 `limit` 查詢參數時
每頁幾行」與「給了就不准超過幾行」，所以改那一格會同時動到兩個行為（dsh 同形）。
`recursion-limit` 的 `100`
**沒有 dsh 的對應物**（dsh 不跑 LangGraph），它是對著一次實測跑掉的執行校準出來的，換算成幾輪
模型呼叫取決於這一次掛了哪些 middleware——預設組裝是 33 輪，再給 `--workspace` 是 32 輪。逐段
實測見 `apps/harness/src/settings/recursion-limit.ts` 的檔頭。

### 看這台機器上疊出來的是什麼

```bash
pnpm --filter @nexus/harness run cli -- --dump-config
```

`serve` 也收同一個旗標。它印出**啟動真的會掛的那一份**，而且一個 plugin 都不載、不開
server、不綁 port：

```yaml
# == /path/to/apps/harness/cordis.yml
- id: echo
  name: "@nexus/plugin-echo"
# == /path/to/apps/harness/cordis.yml, patched by /home/you/.nexus-agent/cordis.patch.yml
- id: todo
  name: "@nexus/plugin-todo"
  disabled: true
```

每一段前面的 `# ==` 註解標明那幾列來自哪個檔、被哪幾層改過，而整份輸出仍然是合法的 YAML
（讀得回來）。指到不存在 `id` 的 patch 會連同它那一層的標籤報到 stderr——**那是「我的 patch
為什麼沒生效」最快的答案**。

輸出的位元組不是約定，不要拿它去做程式化的比對：dsh 對自己那份 dump 也明講了同一件事。

## 核准

**`serve` 是三個入口裡唯一會停下來的那個。** CLI 與 eval 收不了核准決定，所以它們把核准關掉
（`HEADLESS_APPROVALS`）——需要核准的工具拿到一則說明是「沒有人被問到」的拒絕，其餘照跑完，
而不是整輪停在那裡等一個不會來的答案。CLI 每次啟動都會把這件事印在 banner 上。

預設清單不觸發任何中斷，所以核准的按鈕沒有東西可按。要在瀏覽器裡跑到核准那一段，換一份把工具
標成要核准的清單：

```bash
pnpm --filter @nexus/harness run serve --patch src/approval.patch.yml
```

> **這道指令的 `--patch` 值被測試讀走。** `apps/harness/src/documented-fixture.ts` 會從這一段解析
> 出來餵進 `serve.test.ts` 與 `cli.test.ts`，所以這份文件是那個值的唯一來源——改了它，測試會紅，
> 那是設計不是故障。也因為這樣，只改這份文件的 PR 會觸發 CI 的完整掃描（`ci.yml` 的窄例外）。
> 整段指令改寫法、或這份文件多出第二道 `run serve --patch`，解析會當場拋並指名該修哪裡。

這一份把 `echo` 與 `write_file` 標起來，假模型的腳本正好兩個都會呼叫——一條對話會停兩次，核准或
拒絕都繼續得下去。**介面一批只送一個決定**（`uniformDecisions`）：逐筆按是介面還沒做，不是底下擋著。

`exit_plan_mode` 也是需要核准的工具，所以「規劃 → 交計劃 → 有人按批准 → 開始動手」整條路只有
`serve` 加 `--live` 走得完——假模型的腳本寫死在 `cli.ts`，它不會呼叫 `exit_plan_mode`。

## 評測

```bash
pnpm --filter @nexus/harness exec vitest run src/eval
```

資料集在 `apps/harness/src/eval/dataset.ts`，評分器在 `scorers.ts`，跑一條任務的 runner 在
`runner.ts`。**model 是 runner 的參數**，所以 CI 這條（假模型、零憑證、不需要任何 key）與換上真實
供應商的那條跑的是同一份資料、同一組評分器。

**不要在 CI 設 `LANGSMITH_TRACING`。** eval 跑的是真的 agent，tracing 開著時基準任務的題目與工具
參數會跟著 trace 送出去——那條路徑跟 `langsmith/vitest` 自己的上傳是**兩個獨立的開關**
（`src/eval/eval.test.ts` 的檔頭記著實測）。

跨模型比較（**要 key、會花錢、不進 CI**）：

```bash
pnpm --filter @nexus/harness run eval:compare --samples 2
```

它跑 `MEASURED_MODELS`，`--models` 可以挑子集，`--cases` 只跑指定的題目。**成本是題數 × 模型數 ×
取樣數的乘積**，跑滿是小時級。量過的結論與模型盤點在
[`.docs/model-inventory.md`](../.docs/model-inventory.md)。
