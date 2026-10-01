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

**預設落盤到 harness home 底下的 `sessions`**（`$NEXUS_AGENT_HOME/sessions`，沒設就是 `~/.nexus-agent/sessions`），
照 dsh base 出廠的 `session-persistence-jsonl`（[#444](https://github.com/DemianLi/nexus-agent/issues/444)）。
`--session-log <dir>` 是**換位置**，不是開關；banner 的「會話日誌：」那一行印的是這一次實際寫去的目錄。目錄 `0700`、
檔 `0600`，同一台主機上的其他使用者讀不到。

日誌裡有你打的每一句話、模型的每一則回覆，以及工具讀到的檔案內容與指令輸出——連同裡面可能有的秘密。
**不想留的話，把清單上 `session-persistence` 那一列關掉**（[#612](https://github.com/DemianLi/nexus-agent/issues/612)），
照 dsh 在部署設定裡拿掉 `session-persistence-jsonl` 那一列的做法。在 `$NEXUS_AGENT_HOME/cordis.patch.yml` 或
`--patch <檔>` 裡寫：

```yaml
- id: session-persistence
  disabled: true
```

關掉之後兩個入口**一個位元組都不寫**（連 `sessions` 目錄都不建），banner 那一行改印「只在記憶體裡」並點名是這一列
關的；serve 的 thread 列表回「列不出來」，網頁記住的 thread 重開後是空的。**`--resume` 與 `--session-log` 跟它
矛盾，給了就啟動失敗**：前者是因為接回來之後什麼都寫不回去、下一次也接不到（照 dsh headless 的 `--session-id`），
後者是一個明說的旗標跟一份明說的設定打架，安靜地讓哪一邊贏都會讓人讀錯。已經寫下來的舊日誌不會因此被刪，要清
自己清那個目錄。

三條約束：

- **不能落在 `--workspace` 底下**，預設的那一個也算。寫在可寫根裡，模型自己 `read_file` 就讀得到、也改得動整份
  對話史。`--workspace ~` 或把 `NEXUS_AGENT_HOME` 設進工作區，啟動就會被擋，訊息講得出兩條出路：`--session-log`
  指到外面，或把 `NEXUS_AGENT_HOME` 移出去。
- **換位置要換到一個留得住的目錄。** 指進 `/tmp` 或某個會被清掉的暫存目錄，那一跑跑完就什麼都沒剩。
- **遙測開著的話這些內容也原樣送出去**；部署方的脫敏規則只作用在送出去的那一份，本機的 jsonl 照舊是原文。

CLI 每一次啟動各自一個 run 目錄，一份會話一個 `.jsonl` 加一個 `.header.json`。`serve` 吃同一個旗標、同一個預設，
會話根按目錄分，底下一條 thread 一個檔——**所以重開 `serve` 之後，網頁的 thread 清單會帶回同一個目錄底下以前的對話**。
兩者共用同一個根：run 目錄以時間戳開頭，`serve` 那一格以 `--` 開頭，撞不到。eval 那條路沒有會話日誌，而那是一個登記過的決定
（理由與絆索見 `apps/harness/src/eval/runner.ts` 的檔頭）。

日誌記哪幾種事件見 `session-log.ts` 的聯集。格式 9 起它記的是整段對話：人打的字、模型的回覆、
工具呼叫與它的結果、外掛塞進對話的話、壓縮的摘要。要留 live 跑的證據，留 JSONL 就夠了。

**停 `serve` 按一次 Ctrl-C 就好**（[#599](https://github.com/DemianLi/nexus-agent/issues/599)）。第一次
訊號會把每一條 thread 的日誌排空、關檔之後才結束（退出碼 130；`SIGTERM` 是 0）；收尾最多等 5 秒，
到了就強制結束。**收尾中再按一次是「我不等了」**，當場結束，沒排空的那一截會丟——一輪之中已經有
檢查點把使用者那句話與之前每一步先寫下去（`session-checkpoint-policy`，見下面 core 那幾顆），所以
最多丟最後一步的尾巴。用腳本或監管程式停它時，送一次訊號、等它自己結束，不要連送。

**日誌寫不下去時，下一個模型或工具呼叫就不做了**（同上，#599）。以前是背景寫入被拒就 warn 一行、
暫停自動寫入、這一輪照跑，等到收尾才響亮地失敗；現在檢查點排空被拒時：模型不被叫，這一輪以失敗
收尾；工具不動手，圍堵把它收成一則錯誤結果交給模型。同 dsh：寧可不做，也不要做出一段沒有紀錄的事。

## 接著上一次跑下去

CLI 用 `--resume <run 目錄>` 讀回那個目錄裡 root 的那一份日誌、往同一個檔續寫；serve 不用旗標——
碰到一條以前在同一個會話根寫過的 thread 就接回來。

**回來的是日誌上推得出來的**：沙箱模式、目標（授權打回 disarmed，要 `/goal resume` 才會再往下走）、
計劃模式，以及對話——模型歷史從日誌推出來、在第一輪之前灌回模型。**推不出完整歷史的就不灌半截**，
模型從空的開始，入口會講原因。

**回不來的**：虛擬檔案系統、摘要器的會話歷史檔，以及停在核准點還沒答的那張卡——它們只在 graph state 裡。

**工具結果暫存回得來**：過大的工具結果原文存在主機的私有目錄（預設 `<harness home>/tool-results/`，目錄 0700、檔案 0600，按會話分目錄），續接時預覽指的路徑照樣讀得到。保留天數與位置在 `tool-result-stash` 那一列設定（`cleanupPeriodDays` 預設 30，`0` 表示不清）；根目錄寫不進去時退回記憶體暫存並講一聲。

**外溢門檻可調、可關**：一則工具結果超過 `spill-policy` 那一列的 `maxInlineTokens`（出貨 12500，估算 token）時，全文存進上面那個暫存目錄，模型只收到頭尾預覽和一句帶路徑的通知（`Full formatted result stored at: …`），要全文就用 `read_file` 照路徑讀；`read_file` 自己的結果不外溢。日誌記的是這份預覽，不是全文，所以全文只在暫存目錄的保留期內讀得回。把 `maxInlineTokens` 刪掉（或把那一列標成 `disabled: true`）就停用；停用之後超過 80,000 字元的結果仍由基座換成預覽，那一條關不掉。暫存目錄寫不進去、或沒有會話日誌時不外溢，原樣交給模型。

**搜尋結果看筆數、不看字數**：`grep` 命中超過 `tool-fs-search` 那一列的 `grepMaxMatches`（出貨 250）、`glob` 或 `ls` 超過 `globMaxResults`（出貨 100）時，模型只收到前段，結尾一句帶路徑的定位（`Full grep result stored at: …`），完整結果存進上面那個暫存目錄，用 `read_file` 照路徑讀。`grep` 只管逐行命中（`content`）那種輸出，`count`／`files_with_matches` 照原樣。暫存目錄寫不進去、或沒有會話日誌時照樣只留前段，結尾改講沒存到，搜尋不算失敗。把那一列標成 `disabled: true` 就回到基座原樣：超過 80,000 字元由工具自己截掉，原文不留。

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
照日誌重播在畫面上，一次最後 50 則，更早的按「載入更早的對話」往前翻。停在核准或提問時重新整理，
serve 沒重開過的話面板會回來、答了接著跑；重開過就是上面那條「回不來的」。

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

**同一個瀏覽器別開超過兩個分頁**（[#632](https://github.com/DemianLi/nexus-agent/issues/632)）。每個分頁最多掛著
兩條不斷的連線：正在看的那條 thread 的事件，與側欄上全部會話的狀態。`serve` 講的是 HTTP/1.1，瀏覽器對同一個
來源（同一個主機加 port，經 SSH 轉 port 也一樣）最多同時開 6 條連線，所以開到第 3 個分頁就用滿了。用滿之後，
任何一個分頁再送出的請求（送訊息、列清單）都要排隊等一條連線空出來，看起來就是按了沒反應；再開一個分頁的話，
連載入網頁本身都要排隊，會卡在載入畫面。關掉多的分頁就好。

## 金鑰放哪裡

真實供應商（`--live`）的 key 是 `NVIDIA_API_KEY`（[#730](https://github.com/DemianLi/nexus-agent/issues/730)）。**每次模型請求前**才解析一次，
依序找，先找到的算數：

1. **啟動環境**：shell 裡 `export` 的、或行程管理器傳進來的。
2. **受管憑證檔**：`~/.nexus-agent/.credentials.yaml`（`NEXUS_AGENT_HOME` 可以換位置）。
3. **目前資料夾的 `.env`**（已被 `.gitignore` 排除）。
4. **harness home 的 `.env`**：`~/.nexus-agent/.env`，不跟著專案走。

```yaml
version: 1
refs:
  NVIDIA_API_KEY: nvapi-...
```

- **受管檔一定要 `chmod 600`。** group 或 other 任何一位有權限，serve／CLI 起動就拒絕，訊息帶著要跑的指令。
  檔案格式錯（未知頂層鍵、`version` 不是 1、重複的鍵、非字串的值）也是起動就失敗；訊息指名檔案，不會把值印出來。
- **它的值不進行程的環境變數**，所以子行程（`execute`、MCP、git 快照）看不到它。兩份 `.env` 則是照舊寫進
  行程環境（啟動環境已有的變數不會被蓋掉）。
- **改了下一個請求就生效**，不必重啟：每次請求前先 `stat` 一次，修改時間、大小、inode 或權限變了才重讀。
  執行期改壞（格式錯、權限放寬）時，繼續用上一份可用的內容並在 stderr 警告一次；還沒讀成功過就直接失敗。
  key 被整個拿掉的話，那個請求會失敗並指名缺哪一個。
- **兩份 `.env` 不准設行程怎麼起的變數**（`PATH`、`NODE_OPTIONS`、`LD_PRELOAD`、`NEXUS_AGENT_*` 這類），起動就失敗並指名檔案與變數；
  代理設定（`HTTP_PROXY` 等）只認 home 那一份。
- **搬家**：程式碼資料夾根目錄的舊 `.env` 不再讀取。key 解析不到、而舊檔還在時，錯誤訊息會指出舊檔位置與該搬去哪裡。
  搬法：`mkdir -p ~/.nexus-agent && mv <程式碼資料夾>/.env ~/.nexus-agent/.env`，或改存成受管檔。

## 經代理連外

模型請求與走 HTTP 的 MCP server 會經標準代理環境變數指定的代理發出（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）。
啟動時讀一次，不需要別的設定；做法與限制照 dsh 的 `docs/user/guide/network-proxy.zh.md`。Node 要 22.19 以上（`package.json` 的 `engines`）。

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

- **設在哪裡**：shell 匯出的，或 harness home 的 `.env`（`~/.nexus-agent/.env`）；匯出的優先。**目前資料夾的 `.env` 不能設**，
  會隨 `git clone` 進來的檔案不該決定你的流量去哪，設了就拒絕啟動並指名檔案與變數（大小寫寫法都擋）。
  要帳密就寫在網址裡：`http://user:password@proxy:8080`；診斷只指名變數，不印網址。
- **哪些名字**：`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，小寫優先；只設 `ALL_PROXY` 也行，兩種協定都用它；`https:` 沒設時退到 `HTTP_PROXY`。
- **`NO_PROXY`** 寫主機名，連子網域一起放行（`example.com` 含 `api.example.com`），可帶 `:port`，`*` 全放行。
  **不支援 CIDR**（`10.0.0.0/8` 不會生效），改寫主機名或網域尾巴。`localhost`、`127.0.0.0/8`、`::1` 永遠直連，不必列。
- **不支援 SOCKS。** `socks5://…` 會在啟動時報出來（訊息以 `代理：` 開頭）並讓那個協定直連，不會借用另一個協定的代理。請改指向代理軟體的 HTTP 埠。
- **做 TLS 攔截的企業代理**要它的憑證：啟動前 `export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem`（Node 只在行程啟動時讀）。
- **子行程走同一個代理**：git 快照與以 stdio 起的 MCP server 繼承這些變數（`execute` 目前沒有註冊；哪天開了，要走同一份清洗過的環境）；子行程若是 Node，
  要 22.21 以上才會遵守（我們替它補 `NODE_USE_ENV_PROXY=1`），更舊的直連。代理值有一個是被拒絕的（例如 SOCKS）時不補旗標，
  Node 子行程直連，`curl` 與 `git` 仍讀得到那個值。
- **代理網址裡的密碼，子行程也讀得到**：它就是一個普通環境變數，MCP server 與 git 都拿得到（名字不像憑證，清洗不會拿掉它）。
  在意的話，請提供無需帳密的代理入口。
- **刻意直連**：遙測（OTLP 匯出走 Node 自己的 HTTP 客戶端，不經代理；禁止直連的環境裡它只會失敗，沒有功能依賴它）、本機上的一切。

驗證：`--live` 送一則訊息，同時看代理軟體的連線紀錄；沒看到請求時，用 `env | grep -i proxy` 確認變數真的在啟動這個行程的環境裡。

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

**同一步平行跑的工具呼叫也有上限**：模型一步吐出很多顆工具呼叫時，同時在跑的最多 10 顆（照 dsh），
其餘照模型給的順序等空位；一次性與背景子代理同一個值。要改就改清單裡 `agent-loop` 那一列的
`config.maxParallelToolCalls`（至少 2，改了要重啟）。**今天每一顆都可以跟別顆重疊**——dsh 只讓宣告了
平行安全的工具重疊、其餘一顆一顆跑，那一半還沒做（[#711](https://github.com/DemianLi/nexus-agent/issues/711)）。

**目標不會自己往下走，除非你說可以。** `--goal-driver`（CLI 與 `serve` 共用）打開之後，一個 active
的目標在每一輪落定時會自己再開一輪，直到它被完成、被擋住，或用完自己的 `max_goal_rounds`（預設 256）。
預設關。模型從第 `blockedAfterConsecutiveRounds` 輪（預設 3）起可以把自己標成 blocked 而退出迴圈，
但那是准許不是保證。額外那條「連續 N 輪沒進展就停」刻意沒做，理由在
`apps/harness/src/goal-driver.ts` 的檔頭。

## 背景子代理

**`serve` 出廠就是背景續行**（[#841](https://github.com/DemianLi/nexus-agent/issues/841)，照 dsh base bundle 的做法）：模型看到的委派工具是
`subagent`，派出去預設在背景跑、當場回編號，模型接著做別的事；另有 `list_agents`、`interrupt_agent`、`send_message`
三顆控制工具，可以看有哪些、只停某一個當下那一輪、給某一個追加指示（正在跑的子代理在下一步收到，閒著的開新的一輪）。子代理做完（或被停、撞到上限、失敗）會**叫醒主對話多跑一輪**，
模型讀到一則結算通知；子代理也可以用 `send_message` 在半路寫話給主對話。要等結果才能往下時，模型傳 `run_in_background: false`，
那次呼叫等它跑完，行為與一次性相同。

**開關是 `background-subagents` 那一列**（欄位名照 dsh）：`backgroundMode: continuable`（出貨）／`one-shot`，
`maxActiveSubagents`（出貨 8）。改成 `one-shot`，或把那一列標成 `disabled: true`，模型看到的就回到基座的 `task`：一次性、等結果、
沒有那三顆控制工具，與這個功能之前逐字相同。**只有 `serve` 讀這一列**：REPL 一行一輪、一次性模式答完就退出，
背景子代理做完沒有可以叫醒的一輪，結果送不回來，所以那兩條路不論這一列寫什麼都是一次性。

**部署方要知道的後果：**

- **上限是每個主對話各 8，不是整台主機的。** 同時在跑的背景子代理到「會話數 × 8」這個量級；主機上開的 thread 越多，這個量越大。
  已經做完的不佔名額；滿了再派會被拒絕，模型收到說明上限的錯誤結果。
- **主對話按停止不連帶停背景子代理。** 停止只作用在主對話當下那一輪；背景子代理各自跑完，要停得靠模型呼叫 `interrupt_agent`。
- **模型用量會變多。** 每個子代理做完都會叫醒主對話多跑一輪；一次委派多個子代理時，
  主對話的輪數大約是「派出去那一輪 ＋ 每個子代理各一輪」。
- **模型可能在子代理做完之前就先答了使用者**，之後才被結算通知叫醒補上結論。畫面上這一輪不是使用者說的話，不畫成使用者的泡泡。
- **每個背景子代理有自己的會話日誌**，路徑是 `<主對話會話>/<編號>`；關閉一條 thread 時會等它進行中的背景輪收完。
- 結算通知與子代理寫來的話**都不算使用者的直接授權**：目標（goal）判斷「這一輪背後有沒有人」時不採計它們。

### 子代理選模型的政策（#709 的第一段）

`subagent-model-selection` 那一列（欄位名照 dsh）決定**以後新開的會話**允許子代理挑哪些模型：`enabled`（出廠 `false`）與
`allowedModels`（`live-model` 型錄裡的 id；我們只有一個端點，所以不像 dsh 是 `{provider, model}`）。開著卻清單空、有重複、
或有型錄裡沒有的 id，`serve` 起不來。

**政策在新會話建立時取樣一次，寫進 root 日誌的 `subagent/model-selection-policy`，之後只讀日誌那一份**：
把設定打開只影響以後新開的會話，舊會話（沒有那顆事件）續接仍然沒有；開著時建的會話把設定關掉再續接，政策仍在。
**模型面（#877）**：這個會話有政策時，`subagent` 工具多兩格 `model`（授權清單裡的型錄 id）與 `reasoning_effort`，並多一顆
`list_subagent_models`（無參數列授權清單，帶 `model` 看那顆的推理等級）；沒有政策時兩者都不出現，模型硬帶那兩格也會被拒絕，不靜靜忽略。
規則：

- **都不給＝沿用主對話的模型**。給了任何一格，「有效路由」（有給 `model` 就是它，否則是主對話那顆）都必須在授權清單裡。
- **只有背景委派（預設）能指定**；`run_in_background: false` 走基座的 `task`，模型在組裝期寫死，帶 `model`／`reasoning_effort` 會被拒絕。
- **推理等級只有 `off` 與 `default`**，而且必須是型錄條目宣告過的名字；`off` 會把型錄寫的關閉方式帶進這個子代理的每次請求，
  `default` 等於沒給。型錄宣告了別的等級也先拒絕（沒有量過線上寫法，不猜）。
- **一個編號的模型與推理等級從派出到收線不變**：`send_message` 追加指示沿用同一份，不能換。
- 建不出那顆模型（端點設定、憑證）時，工具結果講原因，主對話那一輪不受影響。

### 子代理的工具允許／拒絕清單（#707）

`background-subagents` 那一列（`cordis.yml`）可以填 `toolFilter: { allow?, deny? }`，**出廠不填**（同 dsh）。填了之後套在每個子代理上
（前景的 `task`、背景的 `subagent`、fold 補的 `general-purpose`），root 不受影響：

```yaml
- id: background-subagents
  config:
    toolFilter:
      deny: [write_file, edit_file, delete]
```

- `deny` 拿掉列到的；`allow` 只留列到的（`allow: []` 是一個都不留，不是沒填）；兩邊都列到同一個名字時 `deny` 贏。
- **只遮繼承來的**：全域註冊的工具，以及基座的檔案工具（`ls`、`read_file`、`write_file`、`edit_file`、`delete`、`glob`、`grep`、`execute`）。
  子代理自己那一層註冊或自帶的不遮，所以列它們的名字算寫錯。
- 被遮的工具不在子代理的請求裡；模型照基座的檔案系統說明硬叫一次，拿到一則說明原因的錯誤結果，工具本體不執行。
  **已知限制**：基座那段檔案系統說明是固定文字，仍會描述被遮的工具。
- 掛了 `rootOnly` 的工具：`deny` 列到就整顆消失；`allow` 留下時仍是拒絕樁。
- 與 `backgroundMode` 無關，REPL 與一次性模式也讀。
- **寫錯會起不來**：名字不存在、或設了 `toolFilter` 卻沒有 `allow` 也沒有 `deny`，`serve` 與 CLI 都在起動時失敗
  （`background-subagents` 是必掛的列；這也代表 `maxActiveSubagents` 寫壞同樣起不來，以前只是警告）。

## plugin 清單

零設定的 CLI 與 serve 掛哪些 plugin，由**出貨的 `apps/harness/cordis.yml`** 決定
（[#454](https://github.com/DemianLi/nexus-agent/issues/454)）。那份檔案進版控，是「這個
agent 由什麼組成」的來源。例外是組裝點在程式碼裡掛的三顆（host-services，以及有 `--workspace` 才掛的
sandbox-policy 與 workspace-changes），它們不在清單上，patch 指不到。

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
    - id: mcp-github
      name: '@nexus/plugin-mcp'
      config:
        serverName: github
        connection:
          transport: stdio
          command: npx
          args: ['-y', '@modelcontextprotocol/server-github']

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
- **哪一列的設定寫壞了，啟動時就講。** CLI 在進對話之前、`serve` 在印出網址之前，都先驗過每一列的設定、
  照清單組一次 agent（`serve` 組完就收，[#749](https://github.com/DemianLi/nexus-agent/issues/749)），設定不合法、
  外掛掛上去時拋錯，都在那一刻報出來，訊息兩邊同一句。**`disabled: true` 的那一列不驗設定。**
- **報了之後起不起得來，照必掛與可少掛**（[#751](https://github.com/DemianLi/nexus-agent/issues/751)，照 dsh）。
  設定驗不過、模組載不起來、外掛掛上去時拋錯的那一列掉了：啟動時印一段「警告：N 列沒有掛上」指名它與原因，
  其餘照樣起來，掉了的列算沒掛（跟寫 `disabled: true` 一樣）。**必掛的只有 `browser-session` 與 `system-prompt`**（後者掉了，模型拿到的提示詞就不是部署方寫的那份），它們掉了整個起不來，訊息連
  其他掉了的列一起列——CLI 也一樣，因為兩個入口共用這份清單；帶 `--live` 時 `live-model` 掉了也整個起不來，
  不會退回預設那個對外的端點。啟動程式自己加的那幾顆外掛（沙箱圍堵與工作區改動紀錄那些，不在清單上）掛上去時拋錯，
  照舊整個起不來。
  **警告只印在啟動時**：CLI 印到標準錯誤，`serve` 印到伺服器日誌、在印出網址之前。`serve` 啟動時掉了的列，
  之後每條對話都直接算沒掛，不再重試，到重啟為止；啟動時沒掉、某一條對話組裝時才掉的列，只在那條對話裡不掛，
  伺服器日誌記一行「[組裝] thread "…" 這一條沒掛上」。
- **掛上了、但外掛自己有話要講的，也在那段警告裡。** 例如 MCP 伺服器連不上：那一列照 dsh 照樣掛上、那台
  沒有工具，啟動時印「警告：N 則外掛掛上時交出的話」指名它與原因。`serve` 每條對話各連一次，某一條又連不上
  就記一行「[組裝] thread "…" 警告：…」，伺服器回來之後開的對話就有工具了。要它連不上就算掉，那一列的
  `config` 寫 `failOnStartupError: true`（掉了之後照上一條，到重啟為止不再連），見
  [`packages/nexus-plugin-mcp/README.md`](../packages/nexus-plugin-mcp/README.md)。
- **空檔與只有註解的檔會讓啟動失敗。** 要停用某一層請寫 `[]`——「我把它清空了」與「我把它
  寫壞了」在磁碟上長得一樣，所以不猜。
- **patch 檔只有你自己動得了才會被接受。** 檔案本身與它每一層上層目錄都不能讓群組或其他人
  可寫（sticky 的目錄除外），否則拒絕啟動。這台機器是多人共用的，而一份 patch 檔決定這個
  行程**載入哪些模組**——`insert` 進來的列會被直接 import，相對路徑錨在 patch 檔旁邊。
- **`insert` 進來的模組檔也一樣**（[#542](https://github.com/DemianLi/nexus-agent/issues/542)）。
  指到檔案的那一列（`./`、`../`、絕對路徑、`file://`）在 import 之前照同一條規則檢查模組檔與它每一層
  上層目錄。放在開發組共用的 `0775` 目錄裡、或 `umask 002` 下建出來的 `0664` 檔，都會拒絕啟動，訊息
  指名是哪一列。**檢查只到那一個檔**：模組自己再 import 的旁邊檔案不逐一看，所以放 plugin 的目錄要整個
  私有（`chmod 700`，檔案 `600`）。套件名（`@nexus/*` 這類）不檢查——它們在安裝樹裡，跟出貨的
  `cordis.yml` 同一條邊界。
  - **擁有者也算**：別人擁有的模組檔，就算只有他寫得動也會被拒。
  - **要共用 plugin**：複製一份到自己的私有目錄再指過去，或裝成套件用套件名引用。直接指向開發組共用的
    目錄不再起得來。
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

今天有十七列：

| id | 管什麼 | 有 `config` 嗎 | 關得掉嗎 |
| --- | --- | --- | --- |
| `repeat-reminder` | 連續重複同參數呼叫同一個工具時提醒模型 | 有（四格） | 關得掉 |
| `tool-result-pruner` | 摘要之前先剪掉過長工具結果的中段 | 有（三格） | 關得掉 |
| `summarization` | 壓力達標時把舊訊息摘要成一則，歷史 offload 到 backend | 有（四格） | 關得掉 |
| `observation-policy` | 先讀後改：沒讀過的檔不准改 | **沒有** | 關得掉 |
| `model-usage` | 每一次模型呼叫的 token 帳目記進會話日誌 | **沒有** | 關得掉 |
| `session-checkpoint-policy` | 模型請求與工具動手之前（root 與子代理都是），先把會話日誌排空到磁碟 | **沒有** | 關得掉 |
| `approval-gate` | 核准閘門 | **沒有** | **關不掉** |
| `session-persistence` | 會話日誌落盤本身，以及它的批次窗口（毫秒） | 有（一格） | 關得掉（＝不落盤） |
| `thread-title` | 會話標題的三個上限（退回標題的詞數與位元組，以及任何來源的標題的位元組） | 有（三格） | **關不掉** |
| `thread-title-llm` | `--live` 時由模型依第一句話產生會話標題 | 有（五格，另有選配的 `modelId`） | 關得掉（＝只剩退回標題） |
| `thread-search` | 按內容搜尋以前的會話（側欄的搜尋框）；**出廠不開** | 有（一格） | 關得掉（＝搜尋一律失敗） |
| `browser-session` | 瀏覽器 cookie 的絕對有效期 | 有（一格） | **關不掉** |
| `deliverable-files` | 交付檔的三個上限（一頁位元組／整檔位元組（只管整檔讀）／一頁行數） | 有（三格） | **關不掉** |
| `tool-text` | 一段工具結果文字放上線的位元組上限 | 有（一格） | **關不掉** |
| `live-model` | `--live` 時真實供應商的連線值（端點／預設模型 id／逾時／重試次數），加上模型型錄（每顆的窗口、輸出上限、收不收圖、怎麼關推理） | 有（五格） | **關不掉** |
| `agent-default-model` | 沒帶 `--live` 時用哪個模型提供者（出貨值 `cli-script` 是內建的腳本） | 有（一格） | **關不掉** |
| `recursion-limit` | agent 迴圈的 super-step 上限 | 有（一格） | **關不掉** |
| `agent-loop` | 模型同一步吐出多顆工具呼叫時，同時在跑的最多幾顆 | 有（一格） | **關不掉** |

**最後十列裡，九列是「不裝功能、只講設定」的那一型；`session-persistence` 例外，它代表落盤本身**
（[#612](https://github.com/DemianLi/nexus-agent/issues/612)，關掉就不落盤）。**十列的擁有者分兩邊**：`session-persistence` 住在
`@nexus/core`（值的家在那個套件裡），其餘九列住在 `apps/harness`
（[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
**更要緊的分界是消費點跑的時刻**：

- **`session-persistence`、`thread-title`、`thread-title-llm`、`thread-search`、`browser-session`、`deliverable-files`、
  `tool-text`、`live-model` 跑在註冊表存在之前**，所以 `apply` 是空的、值在起動期解一次往下傳。`thread-search`、
  `browser-session`、`deliverable-files`、`tool-text` 的消費點分別是內容搜尋的索引、瀏覽器會話的建構子、兩支交付方法（`deliverable.read`／`deliverable.readBytes`）、
  以及工具結果文字那兩條（即時的 `ThreadPump` 與重播的 `historyPage`，都在 `createWireHandler` 的閉包底下），
  **只在 `serve` 上有作用**；**`session-persistence`、`thread-title` 與 `live-model` 兩條路都讀**——`session-persistence` 由
  `cli.ts` 與 `serve.ts` 各自在接落盤時讀；`thread-title` 在 serve 上給冷讀清單、pump 與歷史，在 CLI 上給
  寫退回標題的 `runTurn`（[#647](https://github.com/DemianLi/nexus-agent/issues/647)）；`live-model` 各自在起動期
  解一次、交給組裝去建 model（只有 `--live` 用得到）；`thread-title-llm` 跟它一起在建 model 的那一刻讀，
  另建一顆標題用的（[#650](https://github.com/DemianLi/nexus-agent/issues/650)）。

**換模型提供者**（[#670](https://github.com/DemianLi/nexus-agent/issues/670)，照 dsh 的 `agent-default-model`）：沒帶 `--live`
時模型由 `agent-default-model` 那一列的 `provider` 選。出貨值 `cli-script` 是程式碼裡內建的腳本；要換就在 patch 裡
`insert` 一列提供者（目前有 `#settings/scripted-model`，腳本當 `config.turns`），再把那一列的 `provider` 寫成提供者的 `id`。
**`--live` 不看這一列**——它是進 live 的唯一閘門，因為 `.env` 與代理在載入清單之前就依它處理好了。指到的 id 找不到、
被停用、或那一列不是提供者，啟動時當場拋。這是給測試與嵌入方用的接縫，不是換真實供應商的辦法（那是 `live-model`）。
- **`recursion-limit` 與 `agent-loop` 相反，它們的消費點在組裝期**（`agent-factory`），跟前七列同一個位置，所以它們
  跟前七列完全同形（`apply` 提供一顆服務、組裝點去讀）。**CLI 的 `--recursion-limit` 仍然贏過
  這一列**——程式路徑上直接傳的參數贏過這份清單，那條規則對它照樣適用。

**這十列裡關得掉的有三列。** `session-persistence`（[#612](https://github.com/DemianLi/nexus-agent/issues/612)）
代表落盤本身，關掉就是不落盤（見上面「會話日誌」一節）；它曾經也關不掉，那時它只講批次窗口、
關掉只會回到預設，而 #444 讓落盤預設開著之後，「想停掉日誌的人第一個試的就是這一格」。
`thread-title-llm` 關掉就真的沒有模型產生的標題，只剩從第一句話截出來的退回標題（見下面那一段）。
`thread-search` 關掉就真的沒有內容搜尋；它跟出廠的 `openAt: never` 差在哪裡見下面那一段。

**其餘七列關不掉**，但理由分兩種。起動期那五列是「關掉沒有意義」：它們**不裝任何東西**，關掉
不會讓標題不再被裁切、cookie 不再過期、交付檔不再有上限、工具結果不再被截、
`--live` 不再有連線設定——那一列
被當成沒有那一列，值回到 schema 的預設，行為一個位元組都不變。`recursion-limit` 與 `agent-loop` 硬一級
——關掉它確實會讓那顆服務消失，但組裝點接著落回內建的 100／10，**護欄還在**，讀起來卻像把上限
解除了（基座自己那層是一萬／不限）。兩種都只會讓你以為關掉了什麼。寫 `disabled: true` 是啟動失敗，
**訊息會指名你那一列自己的理由**，不是一段通用的話。

**改 `tool-text` 的 `maxBytes` 會讓一條跨套件的比例失效，而且沒有任何東西會擋你。**
`@nexus/wire` 的一頁歷史上限是 8 MB，那個數字是照每張工具卡的最壞值算的：一張卡是結果文字加上給專屬卡的
結構化資料（`meta`），文字的上限是這一格，`meta` 的上限是這一格（搜尋、改檔）或它的兩倍（讀檔，
[#630](https://github.com/DemianLi/nexus-agent/issues/630)），所以一頁最多裝 80 張滿版搜尋卡、約 53 張滿版
讀檔卡。那個關係由 `apps/harness` 的一條測試釘著，
但**它只釘得住出廠那一份**：你在 patch 裡把 `maxBytes` 改小，一頁能裝的滿版卡就變多，8 MB 那個上限相對
變鬆；改大則相反。兩邊都
不會有任何錯誤訊息。這是明著接受的代價（[#538](https://github.com/DemianLi/nexus-agent/issues/538)
三選一的第三條）——另外兩條要把協定常數變成設定、或讓 wire 反過來收 harness 注入的值，都在動協定層
的形狀。**實務上的建議：動這一格時，一頁歷史的大小上限要自己重算一次。**

**`session-persistence` 的 `windowMs` 有兩個方向的邊界**：`0` 合法，意思是不批次、每一顆事件各
寫一次；上限是 `setTimeout` 收得住的 2 147 483 647，**超過它的值會讓計時器立刻觸發**（等於窗口
消失，也就是最勤的那一種，不是最懶的），所以那種值驗不過：那一列掉了、會話只在記憶體裡，啟動時的警告
指名它——不會拿那個值靜靜跑起來。

**`live-model` 的五格**（[#545](https://github.com/DemianLi/nexus-agent/issues/545)、型錄 [#729](https://github.com/DemianLi/nexus-agent/issues/729)）只在 `--live` 時才用；
出貨值是原本寫死的那幾個，每個數字怎麼量出來的寫在 `apps/harness/src/live-model.ts` 各常數的檔頭，
**改之前先讀那一段**。幾件會咬人的事：

- **`models` 是模型型錄，`modelId` 必須在裡面**，不在就起不來（訊息指名那一列與那個 id）。每一筆帶 `id`、
  `contextWindow`（窗口）、`maxTokens`（這顆每一次請求送出去的輸出上限）、選配的 `input`（收哪些種類，
  `[text]` 或 `[text, image]`；這是對端點的宣告，不是檢查——宣告收圖而端點不收，請求當下才被供應商拒絕）、
  `reasoningEfforts`（`off:` 是不推理）與 `compat`（關推理的 chat template 參數）。**寫 `models` 是整份取代**，
  不是逐筆合併：想只改預設那一筆的 `maxTokens`，要把整筆連 `reasoningEfforts` 與 `compat` 一起重述。
  出貨型錄只有預設那一筆。**新增一筆之前先確認它吃得下自己的 `maxTokens`**——出貨那顆模型是拿「吃不吃得下
  16384」當淘汰門檻選出來的，吃不下的模型會**每一次**呼叫都失敗，沒有任何東西會擋你。
- **`baseUrl` 要是 `http:` 或 `https:` 的網址，不能帶帳密、query 或 fragment**（照 dsh）。`http:` 放行，
  所以指向內網的明文端點是合法的——**key 會以明文送過去**，那是部署自己的判斷。
- **`maxRetries` 上限 10**：退避是指數成長而且沒有上限，10 次的累計等待已經是 17–34 分鐘。
  `timeoutMs` 在串流上管兩段：連線到第一則事件（逾時會重試），以及之後每一段之間的閒置（逾時不重試，
  因為已經送到畫面上的字作廢不了）。上限是 2 147 483 647（同 `windowMs` 的理由）。**最壞情況是它乘上
  重試次數**：開了線卻一個位元組都不吐時，每一次都等滿，預設 90 秒 × 7 次，再加退避。
- **關推理的寫法在型錄那一筆**（[#650](https://github.com/DemianLi/nexus-agent/issues/650)、原本的 `thinkingOffBody`）：
  `off` 那一級加 `compat.chatTemplateKwargs`（`$var: thinking.enabled` 在 `off` 解成 `false`）。它只有標題呼叫會
  加進請求 body，主請求不帶。出貨那顆模型不關推理的話，標題那 64 個輸出 token 全被推理吃光，一個標題都回不出來
  （實測 0/6；關掉之後 6/6）。換一顆不認得 `chat_template_kwargs` 的模型時，那一筆不要寫 `compat`，或另外量它自己
  的寫法——不認得的參數可能讓標題請求整個 400，也可能靜靜沒效果。
- **key 不在這一列**：從 `NVIDIA_API_KEY` 讀，來源與順序見「金鑰放哪裡」。
- **`eval` 與 `spike` 不跟這一列走**：它們量的是出貨預設那一組設定底下的模型。

**`thread-title-llm`**（[#650](https://github.com/DemianLi/nexus-agent/issues/650)）只在 `--live` 時才跑：每條新
thread 的第一句話開跑、主回覆的第一次模型呼叫送出之後，另外打一次標題請求，回來的標題蓋過退回標題
（列表、畫面標頭、歷史都讀最後一顆）。續接回來的舊 thread、第二句以後、子代理都不打。幾件要知道的事：

- **每條新 thread 多一次請求**，走 `live-model` 那一列的端點與 key，輸出上限是這一列的
  `maxOutputTokens`（64，不看型錄）。**模型預設沿用 `live-model` 的預設模型**；選配的 `modelId`（[#657](https://github.com/DemianLi/nexus-agent/issues/657)）
  可以改挑那一列 `models` 型錄裡的另一筆（例如一顆便宜、沒有推理的），關推理的寫法跟著那一筆走。
  挑的 id 不在型錄裡，帶 `--live` 時 CLI 與 serve 都在啟動時起不來，訊息指名這一列與那個 id。換之前照 #650 的量法量一次
  （`maxOutputTokens` 64 下，關推理與不關推理各跑 6 次）。`session/title-llm-request` 的 `route.model` 與標題的來源記的是實際走的那一顆。
  dsh 那一對成對的 `provider`／`model` 我們只有 `modelId`：一個組裝一條連線，沒有第二個端點可挑。這次呼叫**不計進會話統計，也不寫 `model/usage`**（同 dsh），所以用量表上看不到它。
- **重試次數沿用 `live-model` 的 `maxRetries`**，但整段有這一列的 `timeoutMs`（60 秒）封頂，所以最壞是等滿
  60 秒。
- **失敗只講一聲**：serve 記進伺服器日誌、CLI 印在 stderr，前綴都是 `[標題]`，退回標題留著，不重試。
  `finish_reason` 不是 `stop`（例如推理吃光上限）、要求呼叫工具、正規化後是空的、輸入超過 `maxInputBytes`，
  都算失敗。
- **CLI 一次性的呼叫多半等不到它**：主回覆收完行程就收尾，還沒回來的標題請求會被中止（不講話），只留退回標題。
- 送出去的系統提示與訊息原文記在日誌的 `session/title-llm-request`，想知道模型看到什麼去讀那一顆。

**`thread-search`**（[#631](https://github.com/DemianLi/nexus-agent/issues/631)）讓側欄按**內容**搜尋以前的會話，
不只比標題。**出廠不開**，同 dsh 的產品組裝：要不要多背一份搜尋索引是部署自己的選擇。多人共用的主機上沒有「整台
一起設」的那一層，想用的人在自己的 `~/.nexus-agent/cordis.patch.yml` 加這一段：

```yaml
- id: thread-search
  config:
    openAt: first-search
```

- **`openAt` 三個值**：`first-search` 是第一次搜尋才開索引；`startup` 是 serve 起動就開（Node 載不起來的話 serve
  起不來，比到第一次搜才發現好）；`never` 是出廠那一個。**schema 的預設是 `startup`**，所以把 `config:` 整段
  拿掉等於打開。
- **`never` 與 `disabled: true` 不一樣**：`never` 時沒有會話可搜回空、有的話回「這個部署沒開」；`disabled: true`
  是沒掛，一律回失敗。兩種失敗網頁都退回只比標題。
- **要 Node 內建的 `node:sqlite`**：Node 22.13 以上不必加旗標，Node 22 載入它時 stderr 會印一行實驗功能的警告
  （24 以後不印）。Node 太舊時搜尋回失敗、講明要哪一版，其他功能照常。`never` 時它一次都不載入。
- **索引只放在記憶體裡，而且不小**：serve 重開之後的第一次搜尋要把這個目錄的日誌全部讀一次重建，之後每次搜尋
  只重讀變了的那幾條。**建好之後一直佔著記憶體，直到 serve 結束**。合成資料量過的數字（1000 條會話、每條 40 輪、
  日誌共 343 MB，本機 Node 25）：第一次搜尋約 2.7 秒；之後沒有變動時約 0.1 秒，兩個字的中文約 0.2 秒，命中很多條的
  英文字約 0.6 秒；**索引佔約 350 MB**（行程的 RSS 從 286 MB 漲到 639 MB，JS 堆積只有 45 MB）。多人共用的主機上，
  每個打開它的人各佔一份。
- **搜什麼**：人打的字、模型回覆的文字與它要叫的工具（名字與參數）、外掛塞進對話的訊息、壓縮換上去的摘要。
  **推理、工具結果、標題不搜**；**被壓縮換掉的那幾則搜不到**（模型也看不到它們了），同 dsh。只搜這台 serve
  列得出來的會話（同一個工作目錄、不含子代理）。
- **怎麼比對跟 dsh 不同**：子字串比對，英文不分大小寫、連續空白算一個。dsh 的斷詞把連續的中文當成一個詞，
  句子中間的「搜尋」「會話」都搜不到，所以這裡換掉了；代價是索引大一些。
- 日誌不落盤（`session-persistence` 關掉）時沒有東西可搜，一律回空。

`observation-policy`、`model-usage`、`session-checkpoint-policy`、`approval-gate` 那四列**不用加
`config:`**——它們沒有設定，寫了也沒有作用：照 dsh 原樣交下去、那一列照樣掛，啟動時印一句警告指名它。前三列
列在這裡的唯一意義就是讓 `disabled: true` 指得著；最後那一列相反，見本節最後。

**關掉 `observation-policy` 等於這個組裝接受盲改**，不是省一點開銷：模型可以對一個沒讀過的
檔直接 `edit_file`。只有「只寫新檔、從不編輯」那種批次流程才該關它。

**`tool-result-pruner` 只在摘要開著時有作用**（摘要不掛就沒人叫剪刀），但它的設定照樣在載入
期驗——寫錯不會因為今天剛好沒用到就放過。

**關掉 `model-usage` 之後，落盤日誌裡就沒有逐次呼叫的 token 帳了**，web 用量表的「目前大小」
那一行也跟著沒有（#528：它讀 root 最新那一筆 `model/usage`；環與比例讀的是摘要器的量測，照舊在）。
加總 `model/usage` 的仍然沒有——基準測試那條路的用量數字是它自己從模型回報的 `usage_metadata`
加的，跟這一列無關。這些代價只有從這裡讀得到，沒有人會替你紅。

**關掉 `session-checkpoint-policy` 之後，會話日誌只在批次窗口到期與收尾時落地**（#599）。正常收尾
一樣完整；但收尾被打斷（收尾中再按一次 Ctrl-C、`kill -9`、當機）時，丟的可能是整輪，而不只是
最後一步的尾巴——腳本模型與行程裡的第一條 thread 上，實測就緒那一刻整輪都還只在記憶體裡。CLI 與
`serve` 一律落盤（#444），所以這一列在兩個入口上都有作用。

**關掉 `summarization` 之後，web 的用量表整個不畫**：它的分母就是這一列的觸發門檻（`trigger`
有幾道就量幾道，patch 改過就用改過的值），摘要不掛就沒有門檻、也沒有量測（`context/measure`）。

**`approval-gate` 關不掉，寫了 `disabled: true` 是啟動失敗。** 這一列跟上面六列不同型：上面
六列的 `disabled` 真的會讓那一顆 middleware 不在 stack 裡，這一列的 `disabled` 是一個錯誤，
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

**最後十列的 `config` 同樣是整份替換。** 沒重述的欄位回到 schema 的預設值，不是保留原本那一列
寫的值——例如 `thread-title` 只寫 `maxBytes` 的話，`maxWords` 拿到的是預設的 5。`thread-title`、
`thread-title-llm`、`browser-session` 與 `deliverable-files` 的預設（`5`／`40`／`80`；`5` 詞／`10` 字／4096 位元組／
64 token／60 秒；`30` 天；2 MiB／32 MiB／5000 行）都照 dsh 的產品組裝；**`session-persistence` 的 `10` 毫秒沒有 dsh 的對應物**——dsh 的落盤後端只收根目錄
與壓縮兩格，它的批次是呼叫端傳一整批而不是計時器攢批，所以這個旋鈕是我們自己的，形狀抄的是
同一份清單上 core 那幾列；**`deliverable-files` 的 `maxLines` 是雙用的**——它同時是「不給 `limit` 時
每頁幾行」與「給了就不准超過幾行」，所以改那一格會同時動到兩個行為（dsh 同形）。
**`maxBytes` 也是雙用的**：一頁文字的上限，同時是位元組窗口（`deliverable.readBytes`）`length` 的預設與
上限（[#544](https://github.com/DemianLi/nexus-agent/issues/544)，dsh 同形）。
`recursion-limit` 的 `100`
**沒有 dsh 的對應物**（dsh 不跑 LangGraph），它是對著一次實測跑掉的執行校準出來的，換算成幾輪
模型呼叫取決於這一次掛了哪些 middleware——預設組裝是 33 輪，再給 `--workspace` 是 32 輪。逐段
實測見 `apps/harness/src/settings/recursion-limit.ts` 的檔頭。
`agent-loop` 的 `10` 照 dsh（`maxParallelToolCalls`），**但最小只收 2，dsh 收 1**：LangGraph 的
`maxConcurrency: 1` 跑完第一顆就靜靜收掉那一步，其餘工具呼叫沒跑也不報錯，理由與絆索在
`apps/harness/src/settings/agent-loop.ts` 的檔頭。

### 部署方的身分與 persona

系統提示詞最前面那句身分、以及前後各一段，由 `system-prompt` 這一列決定
（[#720](https://github.com/DemianLi/nexus-agent/issues/720)，照 dsh 的 `systemPrompt` 三格）。出貨值是：

```yaml
- id: system-prompt
  config:
    includeHarnessIdentity: true   # 最前面那句 "You are an AI agent powered by nexus-agent."
    personaPrefix: 'You are a helpful assistant powered by the {{model}} model.'
    personaSuffix: 'Your working directory is {{cwd}}.'
```

送給模型的順序是：**身分句、前綴、（基座與各 plugin 附加的指引）、後綴**。後綴掛成 `last`，
排在每一顆會往提示詞附加文字的 middleware 內側，所以不論掛了 `--workspace`、skills 或子代理，
它都是最後一段；子代理也拿到同樣的前後綴。

- **`config` 是整份替換**：想只改後綴，前綴要一起重述，否則前綴回到空字串。
- **插值是嚴格的**：只認 `{{model}}`（這個 agent 的模型）與 `{{cwd}}`，寫了別的名字就是
  **啟動失敗**（CLI 與 `serve` 都在進對話、印網址之前報出來，指名是哪一格哪個變數）。不是空字串、也不是原樣保留。
- **`{{cwd}}` 是 `/`**：agent 看到的檔案系統是虛擬的（掛了 `--workspace` 也是），
  真實路徑不會告訴模型。
- 三格都空、身分句也關掉時，這顆 middleware 根本不掛。
- 這一列是必掛的：`disabled: true` 或設定寫壞，整個起不來。

### 看這台機器上疊出來的是什麼

```bash
pnpm --filter @nexus/harness run cli -- --dump-config
```

`serve` 也收同一個旗標。它印出**啟動會掛的那份清單**（不含上面說的那三顆由程式碼掛的），而且一個 plugin 都不載、不開
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

**覆寫檔壞了的時候**（權限被開到別人也寫得動、YAML 寫壞），`--dump-config` 自己也印不出來——它一定會去讀
`$NEXUS_AGENT_HOME/cordis.patch.yml`，讀不過就拋，訊息指名壞的是哪個檔。這時候用：

```bash
pnpm --filter @nexus/harness run cli -- --dump-default-config
```

它**只印出貨那一層**（`apps/harness/cordis.yml`），真的不讀 home 覆寫檔，所以壞掉的檔不會擋它，輸出裡也沒有
那個檔的路徑。拿它跟壞掉的那份對照，就知道你的覆寫檔本來該改的是哪幾列。`serve` 也收同一個旗標。

三種印法（`--dump-config`、`--dump-config-schema`、`--dump-default-config`）**一次只能用一種**；
`--dump-default-config` 另外不能配 `--patch`（它不讀任何覆寫檔，靜靜收下會讓人以為看到的是疊過的樣子），
CLI 上也不能配 `--resume` 或要說的話。`--dump-config` 以前會靜靜收下要說的話再印完就退出，現在同樣拒絕。

### 寫覆寫檔之前先看欄位規格表

```bash
pnpm --filter @nexus/harness run cli -- --dump-config-schema > nexus-config.schema.json
```

`serve` 也收同一個旗標。它用跟 `--dump-config` 同樣的三層與 `--patch`，印出**一份 JSON Schema 2020-12 文件**
（[#741](https://github.com/DemianLi/nexus-agent/issues/741)）：根描述疊完之後的條目清單，`$defs.patchList` 描述
覆寫檔（`cordis.patch.yml`、`--patch`）的格式。編輯器與 agent 拿它就能事先知道某一列收哪些欄位、預設值是多少，
打錯欄位名不必等到啟動才發現——對認得的 `id` 整份換掉 `config` 時，多寫一個欄位、型別不對都驗不過。

- **標準輸出只有那份 JSON**，診斷走標準錯誤。載入 plugin 模組時它們寫進 `process.stdout.write` 的東西會被轉到標準錯誤；
  直接寫檔案描述子的攔不到。
- **每一列都會 import，包括停用的**（停用的正是你可能想重新打開的那一列）；不會套用任何一顆 plugin，也不開 server。
  停用的列可以省略必填的 `config`，但有寫的值仍然要驗——這比啟動時嚴，啟動時對停用的列完全不驗設定。
- **轉不出來的限制不會被靜靜丟掉。** `refine`／`superRefine`、`z.custom`、`transform`／`preprocess`／`pipe` 這類
  回呼式的驗證，JSON Schema 講不出來，那一列標成 `partial`，診斷指名是哪個欄位；**只要有任何一列 `partial`、或有一列載不起來，
  退出碼就是 1**，即使文件本身照樣可用。退出碼回答的是「這份文件能不能取代原本的驗證」：`partial` 的那幾列，
  文件比實際的驗證寬，通過它不代表啟動時一定過。出貨的清單目前就有這幾列（`live-model`、`thread-title`、`present`），
  所以不帶任何 patch 跑一次退出碼也是 1。
- **沒有 `Config` 的列是 `absent`**：欄位未知，不是禁止設定，不算不完整。
- **指到檔案的列（`file:`）先過私有檔檢查**：別人寫得動的模組不會被 import，那一列標成 `failed`。
- 根上的 `x-nexus` 註記帶 `complete`、`entries`（每一列的狀態、`configRef` 與轉不出來的位置）、`diagnostics`、`patchSchema`。
  輸出是隨版本重新產生的參考，不是穩定的格式。

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

`exit_plan_mode` 不走核准：它問一題「同意這份計劃並離開計劃模式？」，計劃全文附在題目裡，選「繼續規劃」
可以寫意見給模型（#652，照 dsh）。所以「規劃 → 交計劃 → 有人按同意 → 開始動手」整條路只有 `serve` 加
`--live` 走得完——假模型的腳本寫死在 `cli.ts`，它不會呼叫 `exit_plan_mode`；CLI 沒有人回答問題，
`exit_plan_mode` 會拒絕並請你打 `/plan off`。

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
