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
「跑掉了」，不是「複雜任務」。真的需要更長的呼叫端自己傳——程式裡是 `recursionLimit`，CLI 是
`--recursion-limit <n>`（`serve` 沒有這個旗標）。

**一次性模式撞到這條上限時退出碼是 `2`**，其他失敗是 `1`，所以包它的腳本分得出「護欄切掉了」與
「壞掉了」；REPL 裡撞到只印一行，不退出。

**目標不會自己往下走，除非你說可以。** `--goal-driver`（CLI 與 `serve` 共用）打開之後，一個 active
的目標在每一輪落定時會自己再開一輪，直到它被完成、被擋住，或用完自己的 `max_goal_rounds`（預設 256）。
預設關。模型從第 `blockedAfterConsecutiveRounds` 輪（預設 3）起可以把自己標成 blocked 而退出迴圈，
但那是准許不是保證。額外那條「連續 N 輪沒進展就停」刻意沒做，理由在
`apps/harness/src/goal-driver.ts` 的檔頭。

## 核准

**`serve` 是三個入口裡唯一會停下來的那個。** CLI 與 eval 收不了核准決定，所以它們把核准關掉
（`HEADLESS_APPROVALS`）——需要核准的工具拿到一則說明是「沒有人被問到」的拒絕，其餘照跑完，
而不是整輪停在那裡等一個不會來的答案。CLI 每次啟動都會把這件事印在 banner 上。

預設清單不觸發任何中斷，所以核准的按鈕沒有東西可按。要在瀏覽器裡跑到核准那一段，換一份把工具
標成要核准的清單：

```bash
pnpm --filter @nexus/harness run serve --plugins src/approval.fixture.ts
```

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
