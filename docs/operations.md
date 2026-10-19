# 操作指南

跑起來之後會撞到的事：圍堵、會話日誌、瀏覽器會話的安全約束、執行上限、評測。
怎麼安裝與怎麼起一條 agent 見 [README.md](../README.md)；協作流程見 [AGENTS.md](../AGENTS.md)。

## 檔案圍堵

**要 `--workspace` 才存在。** 沒給的話檔案跑在虛擬檔案系統裡，那道 fence 根本不在路徑上。

給了之後 `--sandbox <mode>` 決定**起始**強度——`read-only`、`workspace-write`（預設）、
`danger-full-access`（出廠的權限表沒有這一組，要部署方加回，見下一節）——而跑起來之後 `/permission` 切得動它：不帶引數報告現在是哪一組權限組合與可寫根，
帶一個組名就切過去（見下一節）。切換同時作用在兩個地方：檔案工具擋不擋得住，以及模型自己知不知道現在在哪一格
（那句話每次模型呼叫重算）。每一次真的變了都會在會話日誌裡留一顆 `sandbox/mode`，接線當下也會
釘一顆起始值——所以一份日誌答得出「這一輪跑的時候政策是哪一格」。

### 權限組合：`/permission`

[#437](https://github.com/DemianLi/nexus-agent/issues/437)。把「檔案政策」與「核准政策」兩顆旋鈕捆成使用者看得懂的具名組合，
**是切換它們的唯一入口**（舊的 `/sandbox` 拿掉了）。出廠兩組，名字與值照 dsh 的前兩組：

| 組                        | 檔案政策          | 核准政策                |
| ------------------------- | ----------------- | ----------------------- |
| `read-only`               | `read-only`       | `ask`（要改動時先問你） |
| `workspace-write`（預設） | `workspace-write` | `ask`                   |

**出廠不給全開**（[#1621](https://github.com/DemianLi/nexus-agent/issues/1621)）：dsh 出廠還有第三組 `danger-full-access`
（檔案政策 `danger-full-access`、核准 `never`，要人點頭的事一律直接回絕）。serve 多人共用一台主機，同一把 token 底下的每個人都切得到，
所以出廠拿掉（偏離 dsh，理由 2）；CLI 用同一份表，也跟著少（理由 1：出貨層只有一份表，表達不出「serve 少一組、CLI 照舊」）。
部署方要全開就自己加回（見下面「設定」那條），加回之後的行為跟以前一樣，下面各條講到全開的地方都是指加回之後。
已經切到全開的舊會話，續接時**自動收回**：日誌記的檔案政策比表裡每一組都寬，就切到預設組（`defaultPreset`，沒設就是表裡檔案政策最寬的那一組，
出廠表是 `workspace-write`），並寫進日誌（`permission/preset`、`sandbox/mode`、`approval/policy`，只寫變了的）；server 日誌（CLI 是標準錯誤）會留一行
`[權限] thread "…" …`，說明從哪一組收到哪一組。下一次寫檔就照預設組的圍堵判。部署方把全開加回表裡就不收；用 `--sandbox read-only` 起動的部署，要讓全開的舊會話收到 `read-only` 而不是 `workspace-write`，要設 `defaultPreset: read-only`（參與者拿不到 `--sandbox`）；停在 `read-only`、而表裡沒有 `read-only` 的會話比
`workspace-write` 窄，也不收（顯示 `custom`）。切走之後切不回全開。**已知缺口**：冷復活的背景子代理拿的是當初的委派快照，不會被這一步收窄（[#1739](https://github.com/DemianLi/nexus-agent/issues/1739)）。

- **現在是哪一組是推導出來的**：兩顆旋鈕實際的值對上哪一組就是哪一組，對不上任何一組顯示 `custom`（只能顯示，不是切換目標）。
- **`--sandbox` 同時決定核准的起始值**：`--sandbox danger-full-access` 是「全開＋不問」，**要先把那一組加回表裡，否則起動失敗**
  （serve 在起動當下就失敗，不是等到第一條 thread；訊息是「對不上組合表裡任何一組……要嘛在表裡補上那一組，要嘛設定 defaultPreset」）。
  **這是行為改變**：以前它只放寬檔案、核准照舊會問。
  續接（`--resume`、重開 server 接回同一條 thread）一律用日誌裡記的值，日誌沒記核准的舊會話照 `ask`。
- **日誌上多一顆 `permission/preset`**（格式 35）：只記使用者選了哪一組（意圖），執行仍由 `sandbox/mode` 與 `approval/policy` 各自控制。
  新會話接線當下釘一顆起始組合。
- **子代理**：背景子代理的核准一律 `never`；前景子代理跟主對話**當下**的核准政策走（要核准的操作停下來問人，詳見「前景子代理的核准」）；組合名只在部署方加回全開那一組、而且父代理在那一組時帶下去，兩種一樣。
- **web**：目錄走 RPC `permission.catalog`，目前是哪一組走會話投影 `permissions`（`{ currentValue }`）；切換送的就是 `/permission <組名>` 這一行。
- **設定**：清單上 `permission-presets` 那一列。`presets` 整份替換、每組必填 `sandbox` 與 `approval`；`defaultPreset` 選填，
  與明確給的 `--sandbox` 矛盾時啟動失敗。有 `--workspace` 時這一列關不掉（會話中就沒有任何辦法改兩顆旋鈕），沒有 `--workspace` 時它什麼都不註冊。
  部署方要全開，把整張表重寫一份、加回那一組，放進自己的 `--patch <檔>`（或 `plugin config set permission-presets --file -`）：

  ```yaml
  - id: permission-presets
    config:
      presets:
        read-only:
          sandbox: read-only
          approval: ask
          description: 只能讀，不能改檔；要改動時先問你。
        workspace-write:
          sandbox: workspace-write
          approval: ask
          description: 可以寫工作區；要超出時先問你。
        danger-full-access:
          sandbox: danger-full-access
          approval: never
          description: 經符號連結寫得到工作區外，而且不問你：要人點頭的事一律直接回絕。
  ```

  `presets` 是整份替換，所以出廠那兩組也要寫出來，漏寫的就不在表裡了。

**被擋下來時，模型可以請一次升級。** 拒絕後面會接一行指引，模型照著呼叫
`request_sandbox_escalation`，指名那個檔、要升到哪一格、一句給人看的理由；核准卡上看得到這三樣。
核准之後**只有那一個檔的下一次變更**在升上去的那一格跑，用完就沒了，session 的模式不動。
不比現在寬的請求不會去問人。

**沒有 `--workspace` 的組裝不會有 `/permission`、那句話，也不會有升級工具**：一格圍堵都沒有的時候
講「目前是 workspace-write」是說謊。

### 這道 fence 管不到的

[#1291](https://github.com/DemianLi/nexus-agent/issues/1291)。先講結論：**檔案 fence 與三個權限組合是防「失手」的政策圍欄，
不是擋惡意模型的安全邊界。** 它防的是模型手滑把檔寫到工作區外、或在 `read-only` 下改了東西；一個存心繞過的模型、
或任何能在你機器上跑程式的路徑，不在它的設計範圍內（`apps/harness/src/contained-backend.ts` 檔頭同一個說法：policy fence，
不是 kernel boundary）。下面三條是今天實測到的邊界，不是待補清單。

**1. 讀取面幾乎沒有圍堵。** fence 只圍變更（寫、改、刪、上傳）；讀走 deepagents 基座，策略歸 `permissions`，
而出貨的設定**沒有任何一條 deny 規則**。所以：

- **工作區裡的目錄 symlink 讀得穿到根外。** `read`、`ls` 經一條指向根外目錄的 symlink 看得到那邊的檔案——基座的
  `O_NOFOLLOW` 只管路徑的最後一段，祖先目錄照跟。這是目前唯一讀得出去的路。
- 其餘三種讀法今天被擋，擋的是基座不是我們：最後一段是檔案 symlink → `ELOOP`；路徑含 `..` 或以 `~` 開頭 →
  `Path traversal not allowed`；主機絕對路徑（如 `/etc/hosts`）被當成工作區底下的子路徑 → `ENOENT`，讀不到真的那個檔。
- 這四條由 `apps/harness/src/contained-backend.test.ts` 的「讀取面的今日實況」釘住：文件與實際漂開時測試會先紅。
  基座哪天補上目錄 symlink 的圍堵，第一條會紅——那時該回來改這一節，不是把測試翻回去。
- 想擋讀，現在唯一的辦法是在 `permissions` 自己加 deny 規則，或把 agent 跑在你信得過的隔離環境裡。
- serve 啟動時會拒絕把 key 的來源與 harness home 擺在工作區裡（見下面「serve：key 與 home 不能跟工作區重疊」），但那道檢查
  **只看路徑本身**：工作區裡一條指向 home 或指向 `.env` 所在目錄的目錄連結擋不到，經它照樣讀得到（就是上面第一條）。
  不掃描是刻意的：要擋得掃整棵樹，而且連結可以在啟動之後才建。

**2. 以 stdio 起的 MCP server 子行程不在 fence 底下。** 它們是外部程序，走自己的檔案系統，既不經過 `permissions` 也不經過
backend；`read-only` 也攔不住它們寫檔。harness 管得住的只有「MCP 讀來的資料經由內建 `write_file` 寫進工作區」那一條。
要圍堵 MCP server 本身，只能從**啟動它的方式**下手（例如把 server 跑在容器裡，`command` 指向 `docker run …`）；我們沒有
包一層沙箱，也不打算在不改設計的前提下假裝有。細節見 [`packages/nexus-plugin-mcp/README.md`](../packages/nexus-plugin-mcp/README.md)
的「明文限制」。

**3. 出廠兩個組合，加上部署方可以加回的全開，都是政策，不是隔離。** `read-only` / `workspace-write` / `danger-full-access` 決定的是 harness 內建檔案工具肯不肯
動手；它們不涵蓋子行程與網路，對讀也幾乎沒有作用（見第 1 條）。`danger-full-access` 放行 symlink 逃逸，但基座字面的 `..`
檢查仍在，所以它也不是 dsh 那種真正的不設防（偏離登記在 `contained-backend.ts` 檔頭）。**執行期的提示詞與 `/permission` 的輸出不會講這些**：它們描述的是「檔案工具現在擋不擋」，
並沒有宣稱整台機器被隔離。需要真正隔離的場合（多人共用主機、不信任的模型或 MCP server），請在這層之外自己加容器或帳號邊界。

### serve：key 與 home 不能跟工作區重疊

[#1620](https://github.com/DemianLi/nexus-agent/issues/1620)。serve 帶 `--workspace` 起來時，先檢查下面四個路徑，**任何一個跟工作區
重疊就當場起不來**（沒有逃生旗標）：

- 目前資料夾的 `.env`（存在才算，**不看 `--live`**：同一個目錄下次帶 `--live` 重啟，讀的就是這一份）；
- harness home 本身（`NEXUS_AGENT_HOME`，沒設就是 `~/.nexus-agent`；還不存在也算）；
- home 的 `.env`（存在才算）；
- 程式碼資料夾根目錄的舊 `.env`（存在才算；它不會被讀，但檔案還在的話裡面多半就是 key；**打包出來的安裝樹沒有這一項**）。

為什麼：讀取不受圍堵（上面第 1 條），而 serve 是多人共用的——落在工作區裡的 key、瀏覽器會話密鑰、所有人的附件與會話日誌，
任何一位使用者叫模型讀一次就拿到了。在專案目錄下跑 `serve --live --workspace .`，模型一個 `read_file .env` 就讀得到 key。

- **重疊算兩個方向**：路徑在工作區裡、就是工作區，或工作區在它底下（例如 `--workspace ~/.nexus-agent/attachments`）都算。
- **比的是實際位置**：經符號連結的別名、macOS 上大小寫不同的寫法都會被解開再比。
- **檢查排在拿 home 鎖、讀 `.env` 之前**：被拒的那一次工作區裡一個檔都不會多，`.env` 一份都不讀。錯誤訊息只講路徑，不讀也不印
  檔案內容。印設定的那幾個旗標（`--dump-config` 這一類）不寫 home，不檢查。
- **怎麼繞**（擇一）：把 `.env` 搬到工作區外面（例如 home 的 `.env`），或改在啟動環境 export；把 `NEXUS_AGENT_HOME` 設到工作區
  外面；或換一個不跟這些路徑重疊的 `--workspace`。
- **只有 serve 檢查**。CLI 是一個人在自己的終端機跑，跟模型對話的人就是 key 的主人，不擋。

## 會話日誌

**預設落盤到 harness home 底下的 `sessions`**（`$NEXUS_AGENT_HOME/sessions`，沒設就是 `~/.nexus-agent/sessions`），
照 dsh base 出廠的 `session-persistence-jsonl`（[#444](https://github.com/DemianLi/nexus-agent/issues/444)）。
`--session-log <dir>` 是**換位置**，不是開關；banner 的「會話日誌：」那一行印的是這一次實際寫去的目錄。目錄 `0700`、
檔 `0600`，同一台主機上的其他使用者讀不到。

日誌裡有你打的每一句話、模型的每一則回覆，以及工具讀到的檔案內容與指令輸出——連同裡面可能有的秘密。
**不想留的話，把清單上 `session-persistence` 那一列關掉**（[#612](https://github.com/DemianLi/nexus-agent/issues/612)），
照 dsh 在部署設定裡拿掉 `session-persistence-jsonl` 那一列的做法。用 `plugin disable session-persistence`
（寫進變更紀錄，要重啟才生效），或在 `--patch <檔>` 裡寫：

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
  指到外面，或把 `NEXUS_AGENT_HOME` 移出去。serve 上這種情形更早就被「key 與 home 不能跟工作區重疊」那一道擋下
  （home 在工作區裡，`--session-log` 指到外面也一樣），訊息是那一道的。
- **換位置要換到一個留得住的目錄。** 指進 `/tmp` 或某個會被清掉的暫存目錄，那一跑跑完就什麼都沒剩。
- **遙測開著的話這些內容也原樣送出去**；部署方的脫敏規則只作用在送出去的那一份，本機的 jsonl 照舊是原文。

CLI 每一次啟動各自一個 run 目錄，一份會話一個 `.jsonl` 加一個 `.header.json`。`serve` 吃同一個旗標、同一個預設，
會話根按目錄分，底下一條 thread 一個檔——**所以重開 `serve` 之後，網頁的 thread 清單會帶回同一個目錄底下以前的對話**。
兩者共用同一個根：run 目錄以時間戳開頭，`serve` 那一格以 `--` 開頭，撞不到。eval 那條路沒有會話日誌，而那是一個登記過的決定
（理由與絆索見 `apps/harness/src/eval/runner.ts` 的檔頭）。

`.header.json` 自格式 30 起記下**寫這份日誌的是誰**（#1025）：程式碼的 commit 與工作樹有沒有未提交的改動、疊完的插件清單
（每一列的 `name`、`id`、是否停用，**不含設定內容**）、整份設定的雜湊，以及 root 用的模型型錄 id（只在 `--live`）。`serve` 記的是
那條 thread 組裝時重讀的那一份清單（#1405），所以同一台 server 上改了清單之後開的對話，header 跟著不同。續接不改它，
永遠是最初那一個行程。設定雜湊是帶鍵的，鍵在 `~/.nexus-agent/config-hash-key.json`（`0600`）：**只能跟同一個 home 寫的日誌比**，
拿到日誌的人反推不出設定裡的值。刪掉那個檔，之後的日誌換一套雜湊。離線掃描（`pnpm --filter @nexus/harness eval:sessions scan <目錄>`）每一份
印一行這些欄位，舊日誌沒記的印「—」。

拿 header 的插件清單對照時有兩件事要知道（#1049）：

- **對照的基準是 `--dump-config`，不是 `serve` 啟動時印的「plugin：」那一行。** header 每一列的 `name` 是模組 specifier
  （`@nexus/plugin-todo`、`#settings/…`、`file:…`），`id` 是那一列自己寫的 id——跟同一組 env 與 `--patch` 跑一次
  `--dump-config` 印出的 `name`、`id` 逐字相同。「plugin：」那一行印的是每顆 plugin 自己報的名字（例如 `todo`），
  是另一個值，而且停用的列也照印；它是給人一眼看掛了哪些的，不拿來對日誌。
- **清單與設定雜湊記的是宣告值，不是實際掛上的樣子**，同 `--dump-config`。啟動時才掉的列（模組載不進來、設定驗不過、
  `serve` 試組時掉的、某一條 thread 組裝時才掉的）照宣告的樣子記，`disabled` 仍是 `false`；「這一列實際沒掛」只在啟動
  警告（`serve` 是伺服器日誌）裡。要知道某一份日誌當時實際少了哪幾列，看那一次的啟動輸出。

日誌記哪幾種事件見 `session-log.ts` 的聯集。格式 9 起它記的是整段對話：人打的字、模型的回覆、
工具呼叫與它的結果、外掛塞進對話的話、壓縮的摘要。要留 live 跑的證據，留 JSONL 就夠了。

**停 `serve` 按一次 Ctrl-C 就好**（[#599](https://github.com/DemianLi/nexus-agent/issues/599)）。第一次
訊號會把每一條 thread 的日誌排空、關檔之後才結束（退出碼 130；`SIGTERM` 是 0）；收尾最多等 5 秒，
到了就強制結束。**收尾中再按一次是「我不等了」**，當場結束，沒排空的那一截會丟——一輪之中已經有
檢查點把使用者那句話與之前每一步先寫下去（`session-checkpoint-policy`，見下面 core 那幾顆），所以
最多丟最後一步的尾巴。用腳本或監管程式停它時，送一次訊號、等它自己結束，不要連送。

**強制結束時還在跑的 git 會被一起收掉**（[#1542](https://github.com/DemianLi/nexus-agent/issues/1542)）。
三條強制結束的路（收尾中再按一次、收尾逾時、下面 #1501 的致命退出）都不等子行程；`workspace-changes` 起的 git 在行程
結束那一刻被送 SIGKILL，不留孤兒。只收 git 本身：git 再起的行程（例如使用者自訂的 clean／smudge filter）收不到。`kill -9`、OOM 這類
不經過 Node 的結束一樣什麼都收不到。**起不來的子行程不送訊號**（[#1742](https://github.com/DemianLi/nexus-agent/issues/1742)）：spawn 失敗、`'error'` 還沒送到時 `ChildProcess` 沒有 pid，這時 `kill()` 送出去的是 `kill(0, sig)`，也就是整個行程群組（含 serve 自己）；git 與 rg 的收尾、以及行程結束時的強殺，送之前都先看 pid。MCP 的 stdio server **不在這裡強殺**：正常收尾時 MCP 插件會關掉
連線（最多等 5 秒），強制結束時 server 的 stdin 會被關掉，所以**自己接的 stdio server 要在 stdin
關掉時自己結束**，不然 serve 走了它還留著。

收尾時某一條 thread、某一份日誌關不掉，**不會讓其餘的跟著留著**（[#1511](https://github.com/DemianLi/nexus-agent/issues/1511)）：
每一份都會被收完，失敗收集成一則錯誤印出來，訊息點名是哪條 thread、哪一步、底下的原因鏈。
寫租約是在日誌關檔時放的，所以這一條也是「下次續接同一份會話不會撞上 `SessionAlreadyOwnedError`」的前提。

**`serve` 遇到沒人接的例外會先收尾再以 1 結束**（[#1501](https://github.com/DemianLi/nexus-agent/issues/1501)）：
未處理的 rejection 或未捕捉的例外，stderr 會印一行 `nexus-agent serve: fatal load failure: …`（rejection）或
`nexus-agent serve: fatal uncaught exception: …`（例外），後面接 `util.inspect` 的內容（`code`／`cause` 都在）；
然後走和 Ctrl-C 同一條收尾（排空日誌、關檔、放租約），**最多等 2 秒**，不論收完與否都以 1 結束。
監管程式與日誌搜尋認那兩個標籤，不翻譯。收尾中再來的例外一律吞掉，不蓋掉第一顆。
以前 Node 預設的崩潰沒有這一步：日誌沒排空、租約沒放，下次續接要等租約過期。
CLI（`nexus-agent` 的單次執行）不在這張的範圍。

**每一批寫進日誌的事件都寫滿並 fsync，磁碟滿了不會把日誌寫壞**（[#1506](https://github.com/DemianLi/nexus-agent/issues/1506)）：
一批要嘛整批落盤，要嘛整批不在。寫到一半拋錯、`fsync` 拋錯時，檔案會截回這一批之前的大小再回報失敗，
協調器保留整批、之後重送；以前殘留的半批會留在檔案裡，重送的內容接在它後面，下次續接讀到中段壞行而接不回來，
而且空間不夠時 `write(2)` 只寫一部分、不拋錯，那幾筆事件就無聲丟了。斷電時最多丟最後一批（以前是上一個檢查點之後的全部）。
代價是 `fsync` 次數等於批數，不是檢查點數；`session-checkpoint-policy` 的排空本身不再多一次。
**已經被這個問題寫壞的舊日誌這一刀救不回來**，列表與搜尋讀得到、續接不行。

**新會話第一次落盤是原子的**（[#1510](https://github.com/DemianLi/nexus-agent/issues/1510)）：header 先寫成暫存檔
（`<會話>.header.json.<12 位十六進位>.tmp`）、`fsync`，再用 `link` 發佈，然後 `fsync` 會話目錄，目錄項斷電後才還在；
`fsync` 完才建日誌檔。第一次落盤時遇到斷電或行程被殺，結果只有兩種：這份會話整份都在，或整份都不在——
不會再留下空的或半份的 header，讓這條 thread 之後每次打開都回「建不起來」、id 也重建不了。檢查點的 `flush()`
說「已落盤」時，新檔的目錄項也一起落盤。目錄 `fsync` 失敗會往外報（不吞），重試只補沒做完的那一步，不會撞上自己剛發佈的 header。
當機時殘留的 `*.tmp` 不會清（列表與離線掃描只認 `.header.json` 結尾，不會撿到它），可以手動刪。Windows 開不了目錄，
照樣用 `link` 發佈但不做目錄 `fsync`。**已經被舊版寫成空 header 的 thread 這一刀救不回來**：把那個 `<會話>.header.json` 刪掉，
同一個 id 才能重建。

**續接不再就地覆寫 header、讀日誌本文走穩定快照**（[#1509](https://github.com/DemianLi/nexus-agent/issues/1509)）：
以前每次續接都把 header 先截成 0 位元組再寫，當機或斷電會留下空的或半份的 header，那條 thread 從此接不回來、側欄也找不到。
現在 header 版本已經是這一版就**完全不寫**；版本較舊才換，換法是暫存檔寫滿、`fsync`、`rename` 蓋過去、再 `fsync` 會話目錄，
中途失敗 header 原樣、暫存檔刪掉。同時進來的唯讀讀方（側欄列表、搜尋索引、釘選檢查）只會看到舊的或新的完整一份。
日誌本文讀前讀後各 `stat` 一次，變了就重讀，第二次還在變就取讀前大小的前綴，所以讀到一半被截尾重寫不會拼出一行垃圾。
Windows 上 `rename` 遇到暫時性的 `EACCES`／`EBUSY`／`EPERM` 會有界重試。**已經被舊版寫成空 header 的 thread 這一刀救不回來**，
處理方式同上一段。

**日誌尾端的壞行可復原丟棄**（[#1508](https://github.com/DemianLi/nexus-agent/issues/1508)，照 dsh 的 `recoverable` 解碼）：
斷電後尾端可能多出一行「有換行、但讀不懂」的完整行。續接與預設讀取遇到時，**壞行與它之後沒有收尾的行一起丟掉**，
由續接補「中斷」收尾後照常續聊；只有**壞行之後還有 `turn/end` 或 `turn/failed`**（壞行落在已收尾的輪中間，不是當機的尾巴）
才照舊拒絕，回「存檔壞了：第 N 行…」。續接第一次寫入之前把尾巴截掉並 `fsync`，serve 日誌會多一行 warn：
thread id、截到第幾個位元組、丟了幾個位元組。**截掉的位元組不另存**，warn 是唯一的紀錄。唯讀的讀取（列表、搜尋、冷讀）
只是不算那一段，不截、不講。位元組偏移算在原始位元組上，所以磁碟損壞造成的非法 UTF-8 不會讓截斷多留幾個位元組。
離線掃描（`eval/session-scan.ts`）仍是 strict：任何壞行都報成讀不了。

**日誌寫不下去時，下一個模型或工具呼叫就不做了**（同上，#599）。以前是背景寫入被拒就 warn 一行、
暫停自動寫入、這一輪照跑，等到收尾才響亮地失敗；現在檢查點排空被拒時：模型不被叫，這一輪以失敗
收尾；工具不動手，圍堵把它收成一則錯誤結果交給模型。同 dsh：寧可不做，也不要做出一段沒有紀錄的事。

### 不變量量測記錄

不變量配套入口的違規原本只進 `console.error`（CLI 是 stderr 的 `[不變量] …`，serve 是伺服器日誌），
沒有計數、沒有留存，所以「這些檢查過去有沒有報過」答不了。為了讓第二刀（那八個配套入口要不要留）
的決策有數字（[#976](https://github.com/DemianLi/nexus-agent/issues/976)），CLI 與 serve 都會另外
append 一份 `$NEXUS_AGENT_HOME/invariant-log.jsonl`，一行一筆、兩種：

- `{"kind":"installed","sessionId":…,"packages":[…]}`：**每一份會話日誌各一行**，列這一份上真的
  裝上了哪幾個 package 的檢查。這是分母——沒有它，「零違規」與「檢查根本沒掛上」長得一模一樣。
  過濾成空集合時 `packages` 是空的，照樣寫。
- `{"kind":"violation","sessionId":…,"package":…,"message":…}`：一條違規，`message` 最多留前 500 個字元。

**跟著會話日誌的兩條承諾走**：清單上 `session-persistence` 那一列關掉時一個位元組都不寫（home 不建）；
home 落在 `--workspace` 底下時也不寫（不拋——量測記錄不值得擋掉一次啟動；只有 CLI 到得了這一格，serve 上 home 在工作區裡
就起不來）。檔案 `0600`、目錄 `0700`，
不輪替，要清就直接刪。寫不進去只講一次，不影響產品；違規本身仍照舊印出來。

每個 package 掛上幾個會話、報了幾次違規：

```bash
jq -rs '
  (map(select(.kind=="installed") | .packages[]) | group_by(.) | map({key: .[0], value: length}) | from_entries) as $s
  | (map(select(.kind=="violation") | .package) | group_by(.) | map({key: .[0], value: length}) | from_entries) as $v
  | ([$s, $v] | map(keys) | add | unique) as $all
  | (["package", "sessions", "violations"] | @tsv),
    ($all[] | [., ($s[.] // 0), ($v[.] // 0)] | @tsv)' ~/.nexus-agent/invariant-log.jsonl | column -t
```

`sessions` 是 0 而 `violations` 不是 0 的列是異常（報了違規卻沒有「裝上」那一行），先查記錄有沒有被截斷或
換過 home。**零違規是弱證據**：一個人在自己機器上跑一陣子沒報過，不代表檢查沒有價值（它們擋的是回歸，
測試也擋回歸）。這份記錄是 dsh 沒有的、我們自己加的；第二刀若選全部拿掉，它跟著拿掉。

## 接著上一次跑下去

CLI 用 `--resume <run 目錄>` 讀回那個目錄裡 root 的那一份日誌、往同一個檔續寫；serve 不用旗標——
碰到一條以前在同一個會話根寫過的 thread 就接回來。

**回來的是日誌上推得出來的**：沙箱模式、目標（授權打回 disarmed，要 `/goal resume` 才會再往下走）、
計劃模式，以及對話——模型歷史從日誌推出來、在第一輪之前灌回模型。**推不出完整歷史的就不灌半截**，
模型從空的開始，入口會講原因。

**回不來的**：虛擬檔案系統、摘要器的會話歷史檔，以及停在核准點還沒答的那張卡——它們只在 graph state 裡。

**工具結果暫存回得來**：過大的工具結果原文存在主機的私有目錄（預設 `<harness home>/tool-results/`，目錄 0700、檔案 0600，按會話分目錄），續接時預覽指的路徑照樣讀得到。保留天數與位置在 `tool-result-stash` 那一列設定（`cleanupPeriodDays` 預設 30，`0` 表示不清）；根目錄寫不進去時退回記憶體暫存並講一聲。

**上傳的檔案存在 harness home**（[#732](https://github.com/DemianLi/nexus-agent/issues/732)，只有 `serve`）：`POST /threads/:id/uploads` 把檔案的原始位元組存到 `<harness home>/attachments/v1/`，內容定址、同樣的內容只存一份；目錄 0700、檔案唯讀（0400），檔名清成葉名。回一張收據，只在收下它的那條 thread 有效、行程重開就失效。模型用 `read_file` 讀 `/attachments/<雜湊前兩碼>/<雜湊>/<檔名>`（唯讀路由，不是主機路徑）。沒有保留期清理，也沒有單檔大小上限（照 dsh `file-upload`）。**上傳不受請求本文上限管**：Node 轉接層（`wire-server.ts`）對上傳路由是串流——位元組從 socket 一路流進儲存，行程記憶體不跟著檔案大小漲（實測 480 MiB 的檔 RSS 約漲 80 MiB，有界；整份緩衝是近 2 GiB）。其他路由（JSON）先收完整份，本文上限 300 MiB（`DEFAULT_MAX_REQUEST_BODY_BYTES`，照 dsh `client/connection` 的 `http-bridge.ts`），超過回 413 並斷線。**所以 300 MiB 的上限擋不到上傳**，上傳也沒有儲存配額（dsh 預設也沒有），磁碟寫滿由主機管。要清就自己刪 `attachments/` 底下沒有被會話引用的檔。

**送出時帶附件**（#732）：`run.start` 的 `attachments` 收「上傳收據」與「內嵌的圖（base64）」。收據收下就用掉（同一份不能用第二次；整句被拒時放回去）；圖在收下時驗過（PNG／JPEG／GIF／WebP，每張 20 MiB、每句 20 張／200 MiB、每張 6400 萬像素，只看檔頭不解碼）才存進同一個 `attachments/`（不縮圖、不轉檔）。**日誌、存檔點、軌跡裡只有參照**（雜湊、檔名、大小、圖的寬高）；位元組只在組請求的那一刻讀回來：檔案換成一行字（路徑與「用檔案工具讀」的說明），圖換成 `image_url`。目前的模型在型錄宣告了純文字（`input` 沒有 `image`）時，帶圖的送出回 `model_does_not_support_images`；會話中途換成純文字模型，之前送過的圖在請求裡變成一行佔位字。沒宣告 `input` 的模型照送圖。圖的位元組每次呼叫模型都從磁碟重讀、重編 base64，沒有快取；`attachments/` 被清掉的話，帶它的舊訊息在請求裡變成「已不在儲存裡，請重新附上」的一行。

**圖片額度與 `image/offload`**（#1270，#732 第 8 項）：型錄的 `imageBudget { maxImages?, maxBytes? }`（張數、圖片 base64 總長度；單位不是 token）宣告這顆模型一次請求收得下多少圖，**沒寫就不檢查**。每次叫模型時 adapter 在請求送出**之前**算請求裡還留著的圖，超額就以 `IMAGE_OFFLOAD_REQUIRED` 失敗並帶還要省略幾張（照 dsh：adapter 只量、不決定）；root 的接住層（middleware）把**最舊的**幾張記成一筆 `image/offload { targets: [{ seq, imageIndexes }] }`（`seq` 是產出那則人話的 `turn/start`／輪中插話 `user/message` 事件），並在這次請求裡換成一行佔位字（`[image omitted to fit request image limits; …]`，請使用者重新附上）。**之後每次請求都沿用，重啟續接之後也一樣**（日誌格式 43、不可忽略：略過它就是舊圖又被送出去）。接住層排在起訖紀錄器與用量記錄器的內側，那次被擋下的嘗試沒有送出任何東西：不花供應商的重試額度、不記 `llm/retry`，也不多一對 `model/start`／`model/end`。圖本身還在附件儲存裡，畫面看得到，只是模型看不到。出貨型錄只有 90b 宣告了：端點每次請求最多一張圖（`maxImages: 1`，真端點實測，見 `cordis.yml`），所以第二張圖進來時第一張就被省略。畫面端的線上形狀：人話的 `omittedAttachments`（`attachments` 裡被省略的位置）與 `image-offload` custom frame，見 `@nexus/wire` 的 `image-offload.ts`。沒有來源記號的圖（今天沒有生產者）算進額度但選不到；能省的省完之後仍超出時，`IMAGE_OFFLOAD_REQUIRED` 原樣往外，這一輪以失敗收尾（同 dsh：沒有可省略的就委派給一般失敗路徑）。

**斜線命令帶附件**（#732）：命令用 `input.attachments: true` 宣告收附件（`slash.list` 的 descriptor 上看得到），`slash.run` 的 `attachments`（形狀同 `run.start`）才會被收下。**收下的時機在執行器確認命令宣告之後、handler 之前**：沒宣告的命令帶了附件，這次執行落定成 `error`（日誌有 `command/run`＋`command/done` 一對），收據與儲存一個字不動；不是命令的一行（`kind: 'unknown'`）同樣什麼都不收，輸入框可以當一般訊息送。命令回 `error`（或拋錯、發派的請求中止）時用掉的收據放回去，輸入框留著草稿與附件。`/goal` 是第一個宣告的：`/goal create|edit <目標>` 帶附件時，附件跟著開出來的那一輪訊息（`turn/start.attachments`），固定的一句 `Reference attachments for the goal objective.` 是那一輪的文字；其他子命令（`status`／`pause`／`resume`／`clear`）帶附件回 `error`，沒有目標文字只有附件也回 `error`。

**讀圖**（#733）：`GET /threads/:id/attachments/:attachmentId`（`attachmentId` 是 `sha256:<hex>`，整段 URL 編碼；同會話 cookie 認證）回 `{ attachment, data }`（參照加 base64，照 dsh `session.attachment`）。**授權是「這條 thread 的日誌引用過它」，不是知道 id**：附件儲存是整個 harness home 共用、內容定址的，所以別條 thread、沒引用過的 id、檔案（只收圖）、壞編號、沒載入的 thread 一律 `attachment_not_found`，不細分。只讀已經載入的 thread（記憶體裡那份日誌，含還沒落盤的），不為了讀圖建 thread。日誌引用了但位元組不在了（`attachments/` 被清）是 `unknown_error`。

**附件物件損毀（`ATTACHMENT_CORRUPT`）**（#1338）：附件是內容定址的，物件的路徑就是它內容的 sha256。**這個碼的意思是物件的內容重算出來對不上路徑上的雜湊**（磁碟損毀、寫到一半被中斷、有人動過儲存目錄；大小對不上參照也算），harness 不把來路不明的位元組交出去。**三個地方會撞到**：讀圖（網頁取圖回 `unknown_error`、harness 記一行 `[讀圖] thread … 的圖 sha256:… 讀不回來`，原因是「圖片的內容對不上它的雜湊」或「圖片的大小對不上參照」；組給模型的請求把那張圖換成 `is no longer available in attachment storage` 的佔位字，這一條不記警告，所以只看佔位字會漏掉）；上傳檔案與送出內嵌圖時，碰到已經存在的同雜湊物件也會重算，對不上就整個上傳失敗（`unknown_error`，訊息是「既有物件的內容對不上它的雜湊（sha256:…），不拿來去重」），不會回一張指向壞物件的收據。

**壞物件在** `<harness home>/attachments/v1/file-objects/<雜湊前兩碼>/<sha256>`（物件是 `0400`、目錄是 `0700`）；雜湊在警告的 `sha256:…` 或上傳失敗的訊息裡；只有佔位字時只看得到前八碼，去 `file-objects/<前兩碼>/` 底下找前綴相同的那個。**怎麼修（2026-10-11 在 macOS、本機檔案系統實測）**：

- **圖片**：刪掉那個物件，再上傳一次同一張圖。內容一樣雜湊就一樣，重傳之後是同一個 `attachmentId`，**舊會話日誌裡的參照不用改，直接讀得回來**（實測重傳後 `readImage` 拿舊參照成功、位元組與原圖相同）。刪掉之後、重傳之前，讀同一張圖會是「圖片讀不到」（物件不在），不是 `ATTACHMENT_CORRUPT`。
- **檔案**：同樣刪掉那個物件，再上傳一次同一個檔案。重傳時 harness 會比對檔名別名（`files/<前兩碼>/<sha256>/<檔名>`）跟新物件是不是同一個 inode，不同就用新的硬連結**原子地**換掉別名（先連到暫存名再 `rename` 蓋過去，別名不會有一段時間讀不到）；實測重傳之後別名與物件是同一個 inode、模型用路徑讀到的是正確內容（#1352；在那之前只刪物件修不好，別名還指著舊的壞 inode，得連 `files/<前兩碼>/<sha256>/` 整個目錄一起刪）。換一個檔名重傳只會建新別名，舊名那一條沒重傳就不會被修。
- 重傳的得是**同樣的位元組**；內容不同就是另一個雜湊，修不到舊參照。

**已知缺口**：模型經檔案路徑讀附件（`ATTACHMENTS_PREFIX` 的路由）不經 `AttachmentStore`，讀的時候不驗內容；壞內容只有在重傳去重碰到物件時才會被發現。dsh 的檔案讀取會驗（`file-store.ts:179`），要不要在路由上補是另一件事。

**外溢門檻可調、可關**：一則工具結果超過 `spill-policy` 那一列的 `maxInlineTokens`（出貨 12500，估算 token）時，全文存進上面那個暫存目錄，模型只收到頭尾預覽和一句帶路徑的通知（`Full formatted result stored at: …`），要全文就用 `read_file` 照路徑讀；`read_file` 自己的結果不外溢。日誌記的是這份預覽，不是全文，所以全文只在暫存目錄的保留期內讀得回。把 `maxInlineTokens` 刪掉（或把那一列標成 `disabled: true`）就停用；停用之後超過 80,000 字元的結果仍由基座換成預覽，那一條關不掉。暫存目錄寫不進去、或沒有會話日誌時不外溢，原樣交給模型。

**搜尋結果看筆數、不看字數**：`grep` 命中超過 `tool-fs-search` 那一列的 `grepMaxMatches`（出貨 250）、`glob` 或 `ls` 超過 `globMaxResults`（出貨 100）時，模型只收到前段，結尾一句帶路徑的定位（`Full grep result stored at: …`），完整結果存進上面那個暫存目錄，用 `read_file` 照路徑讀。`grep` 只管逐行命中（`content`）那種輸出，`count`／`files_with_matches` 照原樣。暫存目錄寫不進去、或沒有會話日誌時照樣只留前段，結尾改講沒存到，搜尋不算失敗。把那一列標成 `disabled: true` 就回到基座原樣：超過 80,000 字元由工具自己截掉，原文不留。

**`grep` 用的 ripgrep 是產物內附的，不看主機的 `PATH`**（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 4）：`@vscode/ripgrep` 的平台套件隨 `pnpm install` 與 release tarball 一起來，主機有沒有裝 rg、是哪個版本都無關，完全內網的主機也不必另外裝。啟動時 serve 會印一行 `搜尋（grep）：內附 ripgrep <路徑>`；印的是「不可用」就是產物壞了（平台套件被刪、或 rg 沒有執行權限），這時每一次 `grep` 都會以 `SEARCH_FAILED` 失敗，**沒有退路**，重新安裝即可。rg 以 `--no-config` 啟動，`~/.ripgreprc` 與 `RIPGREP_CONFIG_PATH` 影響不到搜尋。

**接得回來要站在同一個地方**，兩道守衛，兩個入口都擋：

- **同一個目錄。** 一份會話記著它建立當下的工作目錄，接不回別的目錄；**沒記的也拒**，不猜。
- **同一個工作區。** 格式 13 起還記著 `--workspace` 解析出來的根。同一個目錄底下換一個
  `--workspace` 接回來，上一段日誌裡那些檔案路徑就指到另一個工作區裡的同名檔了，而畫面上
  跟讀對了一模一樣——所以擋下，訊息會講出該用哪一個根。**13 以前寫的日誌沒有那一格**，
  那些照常接得回來（也不會被補上：錨是整份日誌一個值，補進去等於替更早的事件宣稱一個沒人
  驗證過的根）。

`--resume` 不能配 `--sandbox`（模式從日誌來，要換就接起來之後 `/permission`）或 `--session-log`
（就寫回那個目錄）。**同一份會話同一時間只有一個行程寫得進去**：另一個行程還開著它時當場擋下。
只有 macOS 與 Linux 鎖得到；其他平台照常寫，第一次要鎖的時候講一聲。

web 那端把 thread id 記在瀏覽器裡，重新整理之後接的是同一條。切回以前的 thread 時，之前說過的話
照日誌重播在畫面上，一次最後 50 則，更早的按「載入更早的對話」往前翻。停在核准或提問時重新整理，
serve 沒重開過的話面板會回來、答了接著跑；重開過就是上面那條「回不來的」。

## 瀏覽器會話的安全約束

**側欄的釘選與封存**（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）存在伺服器端，換瀏覽器、重新整理之後都還在：
`$NEXUS_AGENT_HOME/thread-organization.json`（目錄 `0700`、檔案 `0600`，按 home 分，跟會話日誌同一個「有落盤才有」的條件）。
這份檔只有兩串 id（釘選最近釘的在前、封存依封存順序），**不含對話內容**。

- **封存的會話不跑模型**（照 dsh 的 `ArchivedSessionGate`）：每一次模型呼叫之前都問，不只輪頭。往封存的會話送話、排著的輸入、
  目標續行、背景子代理的結算與來信，仍會開一輪，但**一個模型請求都不發**，這一輪以 `turn/end { reason: { kind: 'blocked' } }`
  收（日誌格式 40）。被擋下的那句話**不進模型的對話**，取消封存之後模型看不到它（日誌的 `turn/start.text` 與畫面歷史仍留著
  使用者打了什麼）。背景子代理的每一步同樣過閘門：被擋下的子代理輪在它自己的日誌上以 `blocked` 收，結算原因是 `refusal`。
- **封存會讓進行中的目標停下，取消封存不會自己接回來**：目標續行那一輪被擋下，目標轉成 `blocked`（`prompt-rejected`，同 dsh 的
  目標驅動器：它不認得封存，只看到這一輪在進入 step 之前被拒絕）。取消封存之後要打 `/goal resume` 才會繼續。
- **封存時還在跑的會話**（有一輪在跑、或背景子代理還在跑）：不帶 `stopActivity` 會被拒絕（`thread_active`，附 `activity`
  是哪幾類）；帶了就先記下封存、再停掉那一輪與全部背景子代理（不等停穩）。
- **改名**（`thread.rename`）把使用者的標題追加成會話日誌上的一顆 `session/title`（`source: user`），**釘住**：之後的退回標題與模型標題都不會蓋過它。
  標題照設定的 `maxTitleBytes` 正規化，正規化完是空的回 `title_invalid`。**寫在日誌上，所以沒落盤的 server 上改名只活到這個行程結束**；
  只在磁碟上的會話改名時會被重新打開。列表讀的是落盤的那份，改名到列表上看得見有短暫的落盤延遲，開著的頁面從即時的標題推送看得到。
- **檔壞了 serve 起不來**：版本不對、JSON 壞、欄位型別不對、兩個集合有重複或互相重疊，或權限讓別人讀得到（會要你 `chmod 600`），
  啟動就失敗，**不會覆寫它**。要重設就刪掉這個檔再重啟——釘選與封存會全部清空。
- **一個 home 只能起一個 serve**（[#1503](https://github.com/DemianLi/nexus-agent/issues/1503)）。釘選、封存、插件快照這些 home 層的檔都假設只有一個 serve 在寫，
  所以 `serve` 啟動時對 `$NEXUS_AGENT_HOME/serve.lock` 拿一把 kernel 鎖（`flock`），握到行程結束；**第二個 serve 在碰 home 底下任何檔之前就起不來**，
  錯誤講出是哪個 home、鎖檔在哪：
  `這個 home（…）已經有另一個 serve 在用：鎖檔 …/serve.lock 被別的行程握著…`。要並行就各給一個 `NEXUS_AGENT_HOME`（多人共用主機時各人用各自的 home）；
  要查是誰握著，執行 `lsof <鎖檔>`——鎖檔是空的，不寫 PID。
  行程不管怎麼死（`kill -9`、當機、致命退出），kernel 都放鎖，沒有要手動清的殘骸；鎖檔本身留著，不用刪。**正常停 `serve`** 時鎖是最後一步放的，
  排在日誌、thread、插件都收完之後。致命退出（上面那條）後**馬上**重啟，若舊行程還在做那最多 2 秒的收尾，新行程會被這把鎖擋一下，舊行程一結束就拿得到。
  只擋 serve 對 serve：一次性 CLI 與 `plugin-change` 照樣能在 serve 跑著時用同一個 home。
  只有 macOS 與 Linux 鎖得到（原生模組 `@deepseek-ai/node-addon-system` 載不起來也一樣）；其他情形 `serve` 照常起來，伺服器日誌講一行 `[home 鎖] 這個平台拿不到 home 鎖，不擋第二個 serve`，
  同會話寫租約。拿不到鎖的原因是 `EACCES` 這類權限／IO 錯誤則不照常起來，原樣報出。

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

  **卡住的分頁不會拖垮 serve，但閒著的死線要靠 sshd 收**（[#1504](https://github.com/DemianLi/nexus-agent/issues/1504)）。
  筆電闔上、網路斷在半路時，serve 這一端的 loopback 連線還開著。事件一直在流的時候，serve 發現對方不收（寫入緩衝卡著、連兩個心跳
  間隔都沒有排出去）就自己斷線，那條 thread 的記憶體與名額跟著放掉；事件沒在流、緩衝是空的死線，serve 看不出來，要等 sshd 判死，
  這段時間那條 thread 撤不掉（閒置逐出要「沒有下行掛著」）。主機管理者在 `sshd_config` 設 `ClientAliveInterval` 與
  `ClientAliveCountMax`，使用者在自己的 `~/.ssh/config` 設 `ServerAliveInterval`，這一段就會在以秒計的時間內收掉，而不是以小時計
  （sshd 預設只剩 TCP keepalive）。

**下行串流的心跳與位元組上限**（`downlink` 那一列，[#1504](https://github.com/DemianLi/nexus-agent/issues/1504)）。每條下行（SSE）每
`heartbeatIntervalMs` 毫秒（出廠 2000）在兩顆 frame 之間寫一行看不見的註解 `: ping`，解碼端本來就跳過它；寫入緩衝裡有位元組卡著、連
2 拍都沒有排出去，serve 斷那一條線並在伺服器日誌記一行 `[下行] 斷開卡住的串流 …`（含路徑與卡住的位元組數，不含對話內容）。另外每條線
排著等送的事件有位元組上限 `maxQueuedBytes`（出廠 2 MiB）：對方活著但比事件產生得慢、積壓超過上限時，只斷那一條線，其他分頁不受影響。
**單一事件本身就超過 `maxQueuedBytes` 時**（例如極大的工具結果）**那條線也會被斷開重連**，所以調大 `spill-policy` 或讀檔的上限時，`maxQueuedBytes` 要跟著調大。斷線之後網頁走既有的重連（狀態列短暫出現「連線中斷，正在重新連線…」，接回來後重抓歷史）。**預設開、這一列關不掉**（`disabled: true`
會在啟動時拋錯）：要放寬就把兩個數值調大；改了要重啟 serve。數值全照 dsh（`websocketHeartbeatIntervalMs` 預設 2000、漏 2 拍淘汰、
`TerminalFollower` 的 2 MiB）。

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
- **key 長什麼樣才收**（[#1541](https://github.com/DemianLi/nexus-agent/issues/1541)）：四層都過同一道檢查，
  在啟動時（`--live` 組裝當下）與每個請求前各判一次。
  - 頭尾的空白、換行**靜靜修掉**（貼 key 時常帶到）。
  - 修完是空的、或中間有空白／換行／非 ASCII 字元（全形字元、零寬空白都算），**拒收**：`--live` 起不來，
    或那一輪以 `INVALID_CREDENTIAL` 失敗、不送出請求、不重打。訊息指名 `NVIDIA_API_KEY` 與是哪一層
    （受管檔寫出路徑、`.env` 寫出路徑、或「啟動環境」），**不含 key 的任何片段**。
  - 只有空白的值就是空白，**不會往下一層退**：最高優先那一層有值就是它，要退就把那一行拿掉。
  - 受管檔裡不要用 YAML 的 `|`（或 `>`）區塊寫 key：區塊會在值尾端留換行（尾端的會修掉），key 一旦折成多行，
    中間的換行（或 `>` 折出來的空白）就會被拒收。直接寫成 `NVIDIA_API_KEY: nvapi-...` 一行。
- **兩份 `.env` 不准設行程怎麼起的變數**（`PATH`、`NODE_OPTIONS`、`LD_PRELOAD`、`NEXUS_AGENT_*` 這類），起動就失敗並指名檔案與變數；
  代理設定（`HTTP_PROXY` 等）只認 home 那一份。
- **搬家**：程式碼資料夾根目錄的舊 `.env` 不再讀取。key 解析不到、而舊檔還在時，錯誤訊息會指出舊檔位置與該搬去哪裡。
  搬法：`mkdir -p ~/.nexus-agent && mv <程式碼資料夾>/.env ~/.nexus-agent/.env`，或改存成受管檔。
  **只對原始碼樹**：打包出來的安裝樹（產物根有 `build-stamp.json`）沒有「程式碼資料夾根目錄」，不找舊位置，
  也不會把 `/opt/.env` 這類系統目錄底下的檔當成舊檔叫人搬。

## 經代理連外

模型請求與走 HTTP 的 MCP server 會經標準代理環境變數指定的代理發出（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）。
啟動時讀一次，不需要別的設定；做法與限制照 dsh 的 `docs/user/guide/network-proxy.zh.md`。Node 要 22.19 以上的 22.x，或 24 以上（23 已 EOL，不支援），以 `package.json` 的 `engines` 為準。

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

## 核對安裝內容

[#1545](https://github.com/DemianLi/nexus-agent/issues/1545) 步驟 4、6。Release 上每個版本附四個檔：

| 檔 | 是什麼 |
| --- | --- |
| `nexus-agent-<版本>-linux-x64.tar.gz` | 產物本身（`pnpm deploy --prod` 的完整閉包，見〈用 systemd 常駐〉） |
| `nexus-agent-<版本>-linux-x64.tar.gz.sha256` | tarball 的雜湊 |
| `nexus-agent-<版本>-linux-x64.cdx.json` | SBOM：閉包裡每一顆套件的 name、version、license，第三方的再加 lockfile 記的 integrity（CycloneDX 1.6 JSON） |
| `nexus-agent-<版本>-linux-x64.cdx.json.sha256` | SBOM 的雜湊 |

tarball 裡另有 `LICENSE`、`THIRD_PARTY_NOTICES.md`（第三方授權清單）和 `sbom.cdx.json`，最後這份與 Release 附的那份位元組相同。
以下全程離線，主機上只要有 Node（產物本來就要它）。第 1、2 步在放這四個檔的下載目錄裡執行。SBOM 列的是 linux-x64 版的
閉包，平台套件（原生二進位、內附的 ripgrep）也是 linux-x64 那一版：Release 只出這一個平台。第 4 步有測試盯著
（`apps/harness/src/release-scripts.test.ts`），改它要讓那條測試照樣過：

<!-- verify-install:start -->
```bash
# 1. 兩個雜湊：擋得住下載或搬運途中的損壞
sha256sum -c nexus-agent-<版本>-linux-x64.tar.gz.sha256 nexus-agent-<版本>-linux-x64.cdx.json.sha256

# 2. 解開之後，產物裡的 SBOM 就是 Release 附的那份
cmp /opt/nexus-agent/nexus-agent-<版本>-linux-x64/sbom.cdx.json nexus-agent-<版本>-linux-x64.cdx.json

# 3. 列出閉包裡的每一顆（名字@版本、授權），拿去對機關的弱點資料庫
cd /opt/nexus-agent/nexus-agent-<版本>-linux-x64
node -e 'const b=require("./sbom.cdx.json");for(const c of [b.metadata.component,...b.components])console.log(`${c.group?c.group+"/":""}${c.name}@${c.version}\t${c.licenses.map(l=>l.expression??l.license.id??l.license.name).join(" ")}`)'

# 4. 主機上實際裝著的套件與 SBOM 逐顆對：印「一致」並以 0 結束；有漏或多就列出來、以 1 結束
node -e '
const fs=require("fs"),path=require("path");
const id=(dir)=>{const m=JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8"));return m.name+"@"+m.version};
const installed=new Set([id(".")]);
const store="node_modules/.pnpm";
for(const entry of fs.readdirSync(store,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.name==="node_modules")continue;
  const modules=path.join(store,entry.name,"node_modules");
  for(const first of fs.readdirSync(modules)){
    if(first.startsWith("."))continue;
    const names=first.startsWith("@")?fs.readdirSync(path.join(modules,first)).map((second)=>first+"/"+second):[first];
    for(const name of names){const dir=path.join(modules,name);if(!fs.lstatSync(dir).isSymbolicLink())installed.add(id(dir))}
  }
}
const bom=JSON.parse(fs.readFileSync("sbom.cdx.json","utf8"));
const listed=new Set([bom.metadata.component,...bom.components].map((c)=>(c.group?c.group+"/":"")+c.name+"@"+c.version));
const missing=[...installed].filter((x)=>!listed.has(x)),extra=[...listed].filter((x)=>!installed.has(x));
if(missing.length+extra.length===0){console.log("一致："+installed.size+" 顆")}else{console.log("SBOM 漏了："+missing.join("、")+"\nSBOM 多了："+extra.join("、"));process.exitCode=1}'
```
<!-- verify-install:end -->

第 4 步跟發版時 `release:verify-packed-install` 做的是同一件事（`scripts/release/sbom.ts` 的 `sbomProblems`）：每一顆都在 SBOM 裡，SBOM 裡也沒有閉包外的。
CI 在每張動到 TypeScript 的 PR 與每次 Release 上都跑過；主機上再跑一次，核的是「解開之後到現在，沒有人往 `node_modules` 裡加或換過套件版本」。

- **SBOM 的雜湊是 registry tarball 的。** 第三方套件的 `hashes` 取自閉包 lockfile 的 integrity（npm registry 上那個 `.tgz` 的 SHA-512），
  拿來對弱點資料庫或 registry 都對得上，但**不能**拿主機上解開的檔案重算出來。我們自己的套件（`@nexus/*`）lockfile 不記 integrity，所以沒有 `hashes`，
  版本與內容跟 tarball 一起由 `.sha256` 釘住；授權取 repo 根 `LICENSE`（MIT）。
- **缺口：擋得住損壞，擋不住惡意替換。** `.sha256` 與 SBOM 跟 tarball 從同一個 Release 頁面下載；能換掉 tarball 的人也換得掉另外三個檔，
  雜湊照樣對得上。產物簽章不在這張（#1545 Q3 (a)），併進企業決議 §八 的發行金鑰（[#1428](https://github.com/DemianLi/nexus-agent/issues/1428) 第二版）。

## 用 systemd 常駐

[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 5。對象是 Release 打出來的 `nexus-agent-<版本>-linux-x64.tar.gz`（解開即用，目標機不用裝 pnpm、不用連 registry），
Node 要 22.19 以上的 22.x，或 24 以上（23 已 EOL，不支援），以 `package.json` 的 `engines` 為準。

```bash
sudo useradd --system --home-dir /var/lib/nexus-agent --shell /usr/sbin/nologin nexus-agent
sudo install -d -m 0700 -o nexus-agent -g nexus-agent /var/lib/nexus-agent
sudo -u nexus-agent install -m 600 /dev/null /var/lib/nexus-agent/.credentials.yaml
sudo -u nexus-agent "${EDITOR:-vi}" /var/lib/nexus-agent/.credentials.yaml   # 填 version: 1 與 refs.NVIDIA_API_KEY，格式見〈金鑰放哪裡〉
sudo mkdir -p /opt/nexus-agent /srv/nexus-agent/workspace
sudo tar -xzf nexus-agent-<版本>-linux-x64.tar.gz -C /opt/nexus-agent
sudo ln -sfn /opt/nexus-agent/nexus-agent-<版本>-linux-x64 /opt/nexus-agent/current
sudo chown nexus-agent:nexus-agent /srv/nexus-agent/workspace
# 單元檔：把下面那段存成 /etc/systemd/system/nexus-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-agent
```

<!-- systemd-unit:begin（apps/harness/src/systemd-unit.test.ts 讀這一段，改了要一起過） -->
```ini
[Unit]
Description=nexus-agent serve
Documentation=https://github.com/DemianLi/nexus-agent/blob/develop/docs/operations.md
After=network-online.target
Wants=network-online.target
# 起不來（例如 home 鎖被別的行程占著）時不要無限重啟：60 秒內 5 次就停手。
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=nexus-agent
Group=nexus-agent

# harness home：會話日誌、瀏覽器會話密鑰、受管憑證檔都在這裡。systemd 替這個使用者建出 /var/lib/nexus-agent。
# 它必須在 --workspace 之外（見〈serve：key 與 home 不能跟工作區重疊〉）。
StateDirectory=nexus-agent
StateDirectoryMode=0700
Environment=NEXUS_AGENT_HOME=/var/lib/nexus-agent
WorkingDirectory=/var/lib/nexus-agent

# 直接 exec node，不經 pnpm：pnpm 會把 SIGTERM 吃掉，serve 收不到停止要求（#1464）。
# systemd 要求絕對路徑；node 不在 /usr/bin 就改成 which node 印出來的那個。
ExecStart=/usr/bin/node /opt/nexus-agent/current/lib/serve.js --live --workspace /srv/nexus-agent/workspace --port 8787

# SIGTERM 是 serve 的一般停止要求（退出碼 0）。serve 自己的收尾上限是 5 秒，到了就自己結束，
# 所以這裡留 10 秒：serve 先自己收完，systemd 的 SIGKILL 只是最後一道。
KillSignal=SIGTERM
TimeoutStopSec=10

# 只在失敗時重啟：systemctl stop 與 SIGTERM 的退出碼 0 不會被拉起來，致命例外（退出碼 1）會。
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```
<!-- systemd-unit:end -->

- **`TimeoutStopSec` 要大於 serve 的收尾上限。** 收尾上限是 `apps/harness/src/process-shutdown.ts` 的 `PROCESS_SHUTDOWN_TIMEOUT_MS`（5 秒，
  [#599](https://github.com/DemianLi/nexus-agent/issues/599)／[#1501](https://github.com/DemianLi/nexus-agent/issues/1501)）：`SIGTERM` 之後 serve 最多等 5 秒收完每條 thread，
  到了就強制結束、退出碼仍是 0。`apps/harness/src/systemd-unit.test.ts` 讀這一段，`TimeoutStopSec` 不大於那個常數就紅。
  這兩個數字改其中一個，另一個要跟著改。
- **`ExecStart` 指的是 `current` 這個符號連結。** 升級就是解開新版、`ln -sfn` 換掉 `current`、`systemctl restart nexus-agent`；
  回退就是把 `current` 指回舊版。連結換掉之前跑著的行程不受影響。
- **`--live` 要有 key，而且要在第一次 `enable --now` 之前就位。** 上面第三、四步放進 home 的受管憑證檔最合適（`chmod 600`，擁有者是 `nexus-agent`；
  見〈金鑰放哪裡〉），它的值不進行程的環境變數。**不要把 key 寫在命令列或 heredoc 裡**：那會跟著指令進管理員的 shell history（`~/.bash_history`）；
  所以先建出權限 600 的空檔，再用編輯器填。單元檔不要寫 `Environment=NVIDIA_API_KEY=…`：`systemctl show` 讀得到，子行程也繼承得到。
  沒有 key 的話 serve 印「缺少環境變數 NVIDIA_API_KEY」就以 1 結束，`Restart=on-failure` 每 5 秒拉一次，滿 `StartLimitBurst` 後單元進 `failed`；
  補上 key 之後 `sudo systemctl reset-failed nexus-agent && sudo systemctl start nexus-agent`。
  代理設定寫在 `/var/lib/nexus-agent/.env`（見〈經代理連外〉）。因為 `WorkingDirectory` 就是 home，兩份 `.env` 是同一份，不會讀兩次。
- **只監聽 `127.0.0.1`。** `serve` 沒有綁其他位址的旗標；要讓別台機器連進來，前面放反向代理（本專案不附設定）。
- **啟動印的網址帶登入 token，會進 journal。** 讀得到 journal 的人（`systemd-journal`、`adm` 群組、root）就拿得到：
  `journalctl -u nexus-agent -n 20` 找「nexus-agent 在 http://…」那一行。token 每次重啟都換新。
- **一個 home 只能起一個 serve**（`<home>/serve.lock`，[#1503](https://github.com/DemianLi/nexus-agent/issues/1503)）：
  第二個單元共用同一個 `NEXUS_AGENT_HOME` 會起不來，被 `StartLimitBurst` 擋下；要兩套就各給一個 home 與 port。
- **刻意沒加的**：`ProtectSystem=`、`PrivateTmp=` 這類 systemd 沙箱指令。agent 的檔案圍堵由 `serve --sandbox` 做（見〈檔案圍堵〉），
  疊上 systemd 的沙箱會改變 git 快照、MCP server 看得到的路徑，要加請在你的機器上實測過再加。

驗證：

```bash
systemd-analyze verify /etc/systemd/system/nexus-agent.service   # 語法與路徑
systemctl status nexus-agent                                     # active (running)
journalctl -u nexus-agent -n 20                                  # 找到「nexus-agent 在 http://…」
sudo systemctl stop nexus-agent; systemctl status nexus-agent    # inactive (dead)，Main PID 的 status=0/SUCCESS
```

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
`config.maxParallelToolCalls`（至少 1，`1` 就是串行，同 dsh；改了要重啟）。**只有宣告了「可以重疊」的工具才會跟別顆重疊**，
其餘一顆一顆照模型給的順序跑，同時也擋住後面的（[#711](https://github.com/DemianLi/nexus-agent/issues/711) 第 2 步，照 dsh）：
基座工具靠名字表，只有 `read_file`、`task`（與選配的 `subagent`）可以重疊，`grep`、`glob`、`ls`、`write_file`、`edit_file`、`execute`
與沒宣告的外掛工具都是獨佔；外掛工具要重疊，在工具的 `metadata` 上寫 `concurrencySafe: true`（只有剛好是 `true` 才算）。
**要核准的工具因此一次只問一顆**：同一步裡排前面的先問，後面的等它答完才開卡。

**目標自己往下走與否，CLI 與 `serve` 的預設相反**（[#445](https://github.com/DemianLi/nexus-agent/issues/445)）。
開著的時候，一個 active 的目標在每一輪落定時會自己再開一輪，直到它被完成、被擋住，或用完自己的
`max_goal_rounds`（預設 256）。**CLI 預設關**，要 `--goal-driver` 才開：CLI 的核准是自動拒絕，續行只會一再撞
同一個拒絕、空轉燒輪。**`serve` 預設開**，要 `--no-goal-driver` 才關：要核准的工具在 `serve` 上是停下來等人，
不會空轉（`serve` 也接受 `--goal-driver`，意思是明講要開；兩個一起給會報錯）。啟動時印的那一行「續行：…」
講的是這一次實際的狀態。模型從第 `blockedAfterConsecutiveRounds` 輪（預設 3）起可以把自己標成 blocked 而退出迴圈，
但那是准許不是保證。額外那條「連續 N 輪沒進展就停」刻意沒做，理由在
`apps/harness/src/goal-driver.ts` 的檔頭。

**目標在跑的時候也能暫停，按下去當場停掉這一輪**（[#1516](https://github.com/DemianLi/nexus-agent/issues/1516)，照 dsh `goal-round-driver` 對暫停的反應）。
有**兩個入口**，效果一樣：wire 的 `goal.pause`（帶目標的 `goalId` 與看到的 `revision`；`revision` 過期回 `{ ok: false, error: { code: 'goal-stale', current } }`，
不假裝成功；目標不是 active 回 `goal-not-active`；沒有目標回 `goal-not-found`；沒有 goal 域的組裝回 `not_supported`；**不依賴續行排程器**，`--no-goal-driver` 也照樣收，暫停是 goal 服務本身的事，同 dsh 的 `@Remote('pause')`），與斜線命令 `/goal pause`。
兩個入口**一輪跑著、停在核准點時都收**，而且**不分這一輪是續行輪還是人打的那一輪**：只要暫停是人下的，server 就走停止鈕那條路中止在跑的輪次
（續行預約整件拿掉、排在後面的人類輸入保留但停住，下一次送出才照順序跑；停在核准點則是收回待答的問題）。
**模型自己在輪內用 `update_goal` 暫停不算**（那是它的工具寫的，不是人在外面按的），那一輪照常收完。判斷「誰下的」靠暫停發生那一刻的 async 身分
（`ThreadPump` 的 `AsyncLocalStorage`，對應 dsh 的 `currentInitiator()`）：比的是**這一輪的身分**，不是「有沒有身分」，所以別條 thread 的輪內鏈、
或上一輪留下的計時器晚到觸發的暫停，都算人下的。
**停止鈕不變**（[#265](https://github.com/DemianLi/nexus-agent/issues/265) Q8）：只收回續行授權，目標仍是 active，要 `/goal resume` 才會再往下走；暫停則是把相位改成 paused。
**停止鈕落在兩輪續行之間的空檔也算數**（[#1518](https://github.com/DemianLi/nexus-agent/issues/1518)）：一輪收尾後，排程器決定要續行、`flush()`（落盤時約一次 `fsync`）還沒回來、預約還沒排進佇列的那一段，沒有輪在跑可以中止；以前這時按停止是 no-op，續行照排。現在 `ThreadPump.cancel()` 看到排程器在飛就收回續行授權（相位不動，不寫日誌、沒有 aborted 收尾，所以之後 `/goal resume` 照常自己續上），`flush()` 回來的第二次決定讀到 `disarmed` 就不排。**dsh 在這一格有同一個洞**（`agent.cancel` 在 idle 時什麼都不做，`goal-round-driver` 的 `drive` 在 `await ctx.sessions.flush` 之後只複查 `readyAfterCheckpoint`，不含停止），這是補上的，不是照做的。
**暫停或停止之後 `/goal resume` 會自己續上，不用再送一句話**：中止（aborted）、拋錯、撞輸出上限收回授權，只針對**收尾當時**那份授權——driver 讀日誌決定，收尾**之後**又有人下了 `create` 或 `resume`，那次收尾就不再收回剛武裝的授權（`goal-driver.ts` 的 `reauthorizedSince`）。
dsh 是在 `turn/end` 抵達的當下收回（`goal-round-driver/src/index.ts:353-357`），事後的 resume 本來就不受影響；我們的決定是無狀態的，要靠日誌上的先後分開「收尾在授權前」與「收尾在授權後」。授權之前就收尾的（同一份授權跑的那一輪被中止）照舊收回。
**一輪跑著時其餘斜線命令照舊被擋**（`/plan`、`/goal <目標>`、`/goal edit`、`/goal resume`、`/goal clear`、`/goal` 本身，回「這條 thread 正在跑：等這一輪跑完再打斜線命令」）：
命令用 `runWhileBusy` 宣告「忙的時候也放行」的**完整字面值**（`/goal` 只宣告 `pause`，逐字比對，`/goal PAUSE` 不算），`slash.list` 的 descriptor 帶著這一格讓 web 知道哪些呼叫跑著時還能點。
忙的時候放行的呼叫不能 `steer`（會把兩輪疊起來）。與 dsh `keepInbox: true` 的逐項比對：佇列保留、停住、下一次送出才跑，我們的停止鈕早就是這個形狀（[#637](https://github.com/DemianLi/nexus-agent/issues/637) Q2），同一條路。

## 前景子代理的核准

**前景子代理要核准的操作，卡片送到使用者面前**（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 1 項，**dsh 沒有**：dsh 委派時把子代理的核准政策釘成 `never`，
`packages/subagent/subagent/src/child-agent.ts:220-247`）。為什麼做：前景時主對話本來就停著等這個子代理，Claude Code 的前景子代理也是這樣；要核准的事一律回絕，
子代理能做的事就比主對話少得多。這翻了 #324 的決定，**僅限前景**。

- **政策與管道跟主對話當下的一樣**：核准政策（`ask`／`never`，#437）每次要問人之前讀一次，所以主對話中途切到 `never`，子代理下一次要核准的操作就確定性回絕。
  入口沒有人（一次性模式、沒有存檔點）時同主對話：回絕，理由說的是「沒有人被問到」。
- **畫面怎麼認出是哪個子代理在問**：`input.requested` 的 `namespace` 第一段是基座給那次委派呼叫的，與 `task`／`subagent` 那張卡折出來的子代理對得上；
  卡片上看得到工具名與理由。同一顆中斷只會送一次（基座會在子代理層與 root 層各露面一次，後一次吞掉）。
- **拒絕只拒那一次**：子代理收到「有人看過並拒絕了 …」的工具結果，照常往下；它再叫一次就是一顆新的問題。**按停止**收回所有待答的問題，這一輪收尾。
- **root 上委派的那張卡維持「執行中」**（子代理在它底下等人），即時與重新整理後的重播一樣。
- **背景子代理不變**：背後沒有人在等，要核准的操作一律回絕（`policy-never`，#737，照 dsh）；它的日誌上有 `approval/policy { never, source: 'delegation' }`，前景子代理的日誌沒有這一顆（它用主對話的）。
- **子代理被告知的話也分兩版**：前景說「需要核准的操作會交給使用者決定」，背景仍是 dsh 那句「會自動被拒絕」（`FOREGROUND_SUBAGENT_DELEGATION_CONTEXT`／`SUBAGENT_DELEGATION_CONTEXT`）。問答工具與沙箱升級在子代理裡仍確定性回絕，不受這一項影響——升級的核准子代理認領不到（一次性 grant 一律不給子代理，照 dsh），問了等於騙人；回絕的理由因此是 `delegated`（「子代理拿不到升級的核准」），不再說「這個 session 關掉了人工核准」。前景只有一條路：基座的 `task`（產品的 `subagent` 工具帶 `run_in_background: false` 時改派給它）。
- **審計**：`approval/asked`／`approval/decided` 仍記在 root 日誌上（與 `interrupt/raised` 同一份，軌跡靠 id 配對），`callId` 對得上子代理日誌裡那顆 `tool/call`。
  日誌格式沒有變。
- **重開行程**：沒有為子代理另開一條路，行為同主對話的核准（這個行程裡掛著的中斷重開過就不在了，畫面上那幾張卡照即時規則收成失敗）。**沒有實測過子代理這一條**。

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
- **子代理的會話不是一條 thread**（#1544）：把 `<主對話>/<編號>` 當 thread id 開（下行、`run.start` 等任何會組出 thread 的路，以及 `run.cancel`——照 dsh，對子代理會話的取消也拒絕）會回專屬碼 `thread_is_subagent`，message 說明「這是子代理的會話，要對它說話請從主對話用 `subagent.send`」，不是暫時失敗、重試沒用。serve 在碰日誌之前就拒絕（只冷讀 header、不拿寫租約、不補結），子代理的日誌一個位元組都不動。判準是 header 帶 `parentSession`，與 `GET /threads` 不列子代理是同一份（`isSubagentSessionHeader`）。
- **重啟 serve 之後，做完的背景子代理還叫得醒**（#1271，缺口源自 #737，照 dsh 的 continuable）。身分（哪一種子代理、哪顆模型與推理等級）記在子代理自己日誌的第一輪之前，
  `subagent/descriptor`（日誌格式 44）；重啟後載體讀主對話日誌上的 `subagent/catalog` 認得它們，現況裡列為 `idle`，**列出不復活任何一個**。
  只有往它送話（畫面上的 `subagent.send`、模型的 `send_message`）才接回來：拿寫入租約、補上當掉那一輪的收尾、按日誌上的身分編圖、把對話從日誌**重播**灌回圖，
  再照一般的投遞走。`interrupt` 對冷的是 no-op。這跟主對話的續接是同一種做法（存檔點不落盤，靠日誌重播），不是還原存檔點。
  - **名額在重建之前佔**：已達並存上限就拒絕（`subagent_at_capacity`／工具結果的 `ACTIVATION_LIMIT_REACHED`），沒去握租約；有一個做完騰出名額後再送即可。
  - **叫不醒的**：格式 44 以前派出的（日誌沒有身分）、日誌檔不在了或壞了。啟動不受影響；`list_agents` 照樣列出並附原因，`subagent.send` 回 `subagent_not_found` 並說明，
    現況裡沒有它（畫面當收線）。叫醒本身失敗（別的行程握著寫入把手、規格或模型已不存在、對話灌不回去）回 `unknown_error` 並帶原因，子代理仍是冷的，修好之後可以再送。
  - **只做背景子代理**；前景子代理隨那一輪結束。關掉落盤（`session-persistence` 那一列 `disabled`）的 serve 與 CLI 不認得重啟之前的子代理。
  - 冷讀要把每個子日誌整份讀一次來折出身分，只在 thread 載入時做、且只有 root 日誌上有 continuable 目錄時才做。
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

- **都不給＝走基線**（定義釘的，沒釘就是主對話**此刻**的選擇，見下一節），基線不受授權清單管。給了任何一格，「有效路由」（有給 `model` 就是它，否則是基線的模型）都必須在授權清單裡。
- **只有背景委派（預設）能指定**；`run_in_background: false` 走基座的 `task`，這一次呼叫不收模型的指定，帶 `model`／`reasoning_effort` 會被拒絕（前景用哪顆見下一節）。
- **推理等級只有 `off` 與 `default`**，而且必須是型錄條目宣告過的名字；`off` 會把型錄寫的關閉方式帶進這個子代理的每次請求，
  `default` 等於沒給。型錄宣告了別的等級也先拒絕（沒有量過線上寫法，不猜）。
- **一個編號的模型與推理等級從派出到收線不變**：`send_message` 追加指示沿用同一份，不能換。
- 建不出那顆模型（端點設定、憑證）時，工具結果講原因，主對話那一輪不受影響。

### 子代理定義裡的模型與上限（#328 第 3 項）

寫 plugin 的人在 `registry.subagents.register()` 的定義上可以多給三格（`NexusSubAgent`）：

| 欄位              | 意思                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| `model`           | 型錄 id（字串）：這個子代理一律用它。也可以給模型實例（不經型錄）。   |
| `reasoningEffort` | 推理強度（`off`／`default`）；沒給 `model` 時套在主對話當下的模型上。 |
| `maxTurns`        | 一次執行最多叫幾次模型，正整數；到了就收尾。                          |

**註冊當下就驗**：`model` 不在型錄、`reasoningEffort` 不是那顆模型宣告過而且今天實作的等級、`maxTurns` 不是正整數，
都在組裝時失敗，訊息指名註冊的 plugin 與子代理，不等到委派。沒連真實供應商的組裝沒有型錄，字串 `model` 與 `reasoningEffort` 一律拒絕。
出廠沒有任何 plugin 註冊子代理，所以這一節只對自己寫子代理的部署方有影響；**沒有設定列**。

**沒設定的子代理走哪顆模型（行為改變）：** 以前前景子代理（`task`、`general-purpose`）一律用部署預設那顆，使用者在會話裡換了模型也不跟。
現在是 **定義釘的 > 主對話此刻的選擇（#723）> 部署預設**：

- **前景子代理逐次跟隨**：每次叫模型前現算，所以子代理跑到一半使用者換了模型，下一次叫模型就換過去。沒選過的會話與以前逐位相同。
- **背景子代理在委派那一刻定下**，之後使用者換模型不影響已經派出去的（照 dsh：子代理建立時取父代理當下的選擇，之後固定）。
- 模型在委派時自己挑的（`model`／`reasoning_effort` 兩格）蓋過定義釘的；兩者撞在一起照 dsh `requestedAgentOptions`
  （`tool-subagent/src/model-selection.ts:99-128`）：要求 > 定義釘的 > 父代理；要求換了路由又沒給強度，定義釘的強度丟掉。
- **授權清單只管模型自己挑的**：定義釘的與沿用主對話的都不查清單。只給 `reasoning_effort` 時，有效模型是釘的（沒釘才是主對話的）那顆，
  它要在清單裡（dsh `assertAllowedModelSelection`，`:139-152`）。

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
agent 由什麼組成」的來源。例外是組裝點在程式碼裡掛的一顆（host-services）。**`serve` 另有一層專屬的出貨清單**
（`apps/harness/cordis.serve.yml`），疊在上面那份之後，放 serve 才有的列（今天是 `workspace-changes`：每一輪改了哪些檔；
沒給 `--workspace` 它什麼都不做）；CLI 不載那一層。 `sandbox-policy` 是清單上的一列：有 `--workspace` 時
它是檔案政策的全部（升級、`sandbox/mode`；切換入口在 `permission-presets` 那一列），**這時關掉它啟動會失敗**（fence 還在擋，模型卻不知道）；沒有
`--workspace` 時它只講一句不宣稱圍堵的政策，關掉合法。

要改它不是去編輯那份檔案，而是疊自己的覆寫。**三層，後面的蓋前面的**：

1. 出貨的 `apps/harness/cordis.yml`（serve 另疊 `cordis.serve.yml`）
2. **變更紀錄** `$NEXUS_AGENT_HOME/plugin-journal.jsonl`（預設 `~/.nexus-agent/plugin-journal.jsonl`）：用 `plugin` 寫入口
   停用、啟用、改設定寫進去，只增不改，清單從它導出（[#1412](https://github.com/DemianLi/nexus-agent/issues/1412)，
   見下面「後台改清單」）
3. 任意個 `--patch <檔>`，照命令列順序

**home 的 `cordis.patch.yml` 不再是一層**：第一次啟動時它的每條 patch 被遷進變更紀錄（見「後台改清單」的遷移），
之後放一個進來只會警告、不讀。下面講的 patch 檔格式仍然是 `--patch <檔>` 的格式，也是變更紀錄裡 `patch` 那種紀錄的內容。

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
- **`serve` 改了清單，新對話就生效，不必重啟**（[#1405](https://github.com/DemianLi/nexus-agent/issues/1405)）。每條對話組裝時
  照同一組 env 與 `--patch` 重讀一次清單，所以用 `plugin` 寫入口改了變更紀錄，之後開的對話看得到：哪幾列掛、組裝時讀的設定
  （`agent-loop`、`recursion-limit`、`tool-fs-search` 與 `@nexus/core/*` 那幾列，`session-persistence` 除外）。**已經開著的對話不變**；重開 server 之後才
  第一次碰到的舊對話，拿的是那一刻的清單。兩件事照舊要重啟：
  - **換插件的版本**：同一個模組只載一次，改了程式碼要重啟。
  - **啟動時讀一次的那幾列**（`browser-session`、`thread-title`、`thread-title-llm`、`thread-search`、`thread-capacity`、`memory-gauge`、`deliverable-files`、
    `session-persistence`、`tool-text`、`projection-flush`、`downlink`、`tool-result-stash`、`spill-policy`、`background-subagents`、
    `live-model`、`subagent-model-selection`）：改了伺服器日誌記一行「[清單] 「…」改了，已儲存，待重啟」，新對話照舊用啟動時的值。
    `agent-default-model` 不在這裡：沒帶 `--live` 時它在每條對話組裝時讀，改了新對話就生效。

  **`goal`、`sandbox-policy`、`workspace-changes` 關掉也是新對話生效，不必重啟**：這三顆每條對話組裝時各取一份，沒掛就缺席
  （`commands` 不是清單上的一列，執行器是宿主自己建的，要動只能改程式碼）。**`sandbox-policy` 有 `--workspace` 時關掉，之後每條新對話
  都開不起來**（檔案系統有圍堵而沒有政策那一列，組裝當場拋），不是「照舊」；**`permission-presets` 同理**（有 `--workspace` 時
  它是 `/permission` 的唯一入口，關掉組裝一樣當場拋）。

  重讀時清單讀不起來、或必掛的列掉了，**只有那一條對話開不起來**，錯誤訊息同啟動那一次，伺服器照常，下一條再讀一次。
- **哪些已儲存、還沒生效，看 `$NEXUS_AGENT_HOME/plugin-snapshot.json`**（[#1406](https://github.com/DemianLi/nexus-agent/issues/1406)）。
  `--dump-config` 只印磁碟上疊出來的那一份；`serve` 另外把「磁碟上現在的」與「啟動時讀進去、試組過的」逐列對照，寫成這個檔：
  啟動時寫一次，之後每條對話組裝時重讀清單、各更新一次（先寫暫存檔再 `rename`，讀的人不會讀到寫一半的；模式 0600）。
  伺服器日誌記一行 `[對照快照] N 列，與執行中相同 …、新對話生效 …、待重啟 …；寫在 <路徑>`，第一次一定記，之後只在哪一列的
  `sync` 變了才記。寫不進去不影響 `serve`，只記一次警告，下一次重讀再試。

  ```bash
  jq '.rows[] | select(.sync != "same")' "$NEXUS_AGENT_HOME/plugin-snapshot.json"
  ```

  每一列只有 `id`、`module`、`running`、`saved`、`sync`（與下面兩個選填的 `unaudited`、`live`），`running` 與 `saved` 裡只有
  `state`（`mounted`／`disabled`／`dropped`／`absent`）和掉了才有的 `dropStage`（`module`／`config`／`apply`／`requires`）。
  `sync`：`same` 沒有差別、`next-thread` 已儲存新對話生效、`restart` 已儲存待重啟。**檔裡不帶設定值，也不帶掉了的原因原文**
  （設定可能放了秘密，原因照舊只進伺服器日誌）。
  `running` 是啟動時的樣子；組裝期讀的列，已儲存的那份已經在新對話生效，所以是 `next-thread`。列的全集與順序同
  `--dump-config`，磁碟上新插進來的列接在最後（`running` 是 `absent`）。分類依據是
  [`.docs/plugin-reload-classification-2026-10-08.md`](../.docs/plugin-reload-classification-2026-10-08.md)，表在
  `apps/harness/src/plugin-row-classes.ts`。**不開 wire 路由**：還沒有管理員身分，`/threads` 底下每個登入的人都看得到；
  有了之後改走那道閘的只讀路由。
- **還有哪些對話握著舊設定，看每一列的 `live`**（[#1442](https://github.com/DemianLi/nexus-agent/issues/1442)，版本路由的第一刀）。
  改了設定之後，進行中的對話還握著組裝當下那一份，新對話才用新的；`live` 把「這一列的哪一版設定 → 哪些對話在用」列出來。
  **只有至少一條對話綁著那一列時才有這一格**，剛開機、還沒開過任何對話的檔沒有它。一項是 `{ version, current, threads }`：

  | 欄位 | 意思 |
  |---|---|
  | `version` | 那一份宣告（列 id、模組名、設定）的帶鍵雜湊，`hmac-sha256:` 加 16 個十六進位字元，鍵同會話日誌 header 的 `configHash`（`config-hash-key.json`）。**不含設定值**；設定改了又改回來是同一版。 |
  | `current` | 它是不是**寫這份檔當下**清單上那一列的那一版，也就是下一條新對話會拿到的那一版。 |
  | `threads` | 握著這一版的對話 id（只有主對話；子代理沿用主對話那一份，不另列），已排序。 |

  ```bash
  jq -r '.rows[] | select(.id == "<列 id>") | .live[]? | select(.current | not) | .threads[]' "$NEXUS_AGENT_HOME/plugin-snapshot.json"
  ```

  上面那行列出「用著這一列舊版設定的對話」。要重新讀設定，那些對話要重開（或重啟 serve）。
  - **剛用寫入口改完設定，要等下一條對話開出來，`current` 才會換。** 寫入口是另一個行程、不寫這個檔（檔只有 serve 一個寫者）；
    檔上的 `current` 是「serve 上一次寫檔當時」清單上的那一版，跟 `saved` 同一個時間點。
  - **停用或掉了的列，沒有任何一版是 `current`。** 已儲存那份把這一列停用、或這一列在已儲存那份裡掉了，下一條新對話不會掛它，
    所以它底下列的版本都是 `current: false`，上面那行 jq 會把還握著它的對話全部列出來。
  - **綁上之後、對話才在接線那一步建不起來，檔上會暫時留著那個對話 id。** 組裝與續接都成功才綁；但綁完之後 wire 那端
    還有幾步（接日誌、接參與者）可能拋，那時會把這條對話收掉、放掉它的綁定，而**放掉只動記憶體、不寫檔**，檔要等下一次寫快照
    （任何一條對話讀清單或綁定）才更新。所以檔上偶爾有一個沒有真的活著的對話 id，下一條對話開出來就消失；要確認是不是真活著，
    看 `GET /threads`。
  - **綁的規則**：只算實際掛上的列——停用的、這條對話掉了的、樹上自我停用的不算；啟動時讀一次的那幾列也不算（它們生效的是啟動那一份，
    改了看 `sync: restart`）。對話建好之後才綁，只看過歷史、沒跑過一輪的對話也算（它下一輪真的會用那一版）。**出廠開著閒置逐出**（`thread-capacity` 的 `idleEvictAfterMs`，
    2 小時），被撤掉的對話在撤完的當下從名單消失
    （serve 撤完會重寫這個檔，寫失敗只記一行日誌、不擋撤，檔留舊的直到下一次寫）；逐出關掉（`idleEvictAfterMs: 0`）或沒有落盤時，對話只在 serve
    關機時才拆，名單只增不減，直到重啟。表在行程記憶體裡，重啟之後從零開始。要分「正在跑」還是「閒著」，看 `GET /threads` 的 `running`。
  - **對話 id 進了這個檔**，擴大了上面「不帶設定值」的揭露範圍：對話 id 本來就經 `GET /threads` 給每個登入的人看，這個檔是 0600，
    只有進得了主機的人讀得到，所以曝露面比 wire 小。**這個前提在 #1428／#1429 做逐人可見之後不成立**（`GET /threads` 不再是每個人都看得到
    全部）；那時這個檔仍然列出全部對話，因為讀者只有主機上的人，但要重審。
  - **關掉會話落盤**（`session-persistence` 列停用）的 serve 沒有這一格：版本字串用 `config-hash-key.json` 那把鍵，落盤關掉的啟動不在 home 底下建鍵檔。
  - 這一版交付的是「設定版本」，不是「程式碼版本」：寫入口沒有換模組的動作，同一列在一個 serve 行程裡只會因為宣告（模組名加設定）改了而出現兩版。
- **報了之後起不起得來，照必掛與可少掛**（[#751](https://github.com/DemianLi/nexus-agent/issues/751)，照 dsh）。
  設定驗不過、模組載不起來、外掛掛上去時拋錯的那一列掉了：啟動時印一段「警告：N 列沒有掛上」指名它與原因，
  其餘照樣起來，掉了的列算沒掛（跟寫 `disabled: true` 一樣）。**必掛的只有 `browser-session` 與 `system-prompt`**（後者掉了，模型拿到的提示詞就不是部署方寫的那份），它們掉了整個起不來，訊息連
  其他掉了的列一起列——CLI 也一樣，因為兩個入口共用這份清單；帶 `--live` 時 `live-model` 掉了也整個起不來，
  不會退回預設那個對外的端點。啟動程式自己加的外掛（交協作者的 host-services，不在清單上）掛上去時拋錯，
  照舊整個起不來。
  **掛上那一刻的警告只印在啟動時**（組裝之後外掛執行期交出的話，例如 MCP 掉線重連的進度，另外逐條印：CLI 一行一條到標準錯誤、前綴 `[外掛]`，`serve` 記進伺服器日誌 `[外掛] thread "…"：…`）：CLI 印到標準錯誤，`serve` 印到伺服器日誌、在印出網址之前。`serve` 啟動時掉了的列，
  之後每條對話都直接算沒掛，不再重試，到重啟或那一列的設定改了為止（改了，下一條對話重新試它；重讀時新掉的列在伺服器日誌記一次
  「[清單] 這一列沒掛上」）；啟動時沒掉、某一條對話組裝時才掉的列，只在那條對話裡不掛，
  伺服器日誌記一行「[組裝] thread "…" 這一條沒掛上」。
  **有一個例外：掉在「需要的能力沒有人提供」（`requires`）那一步的列**（[#1426](https://github.com/DemianLi/nexus-agent/issues/1426)）。
  它自己沒有錯、錯在它依賴的那一列不在，依賴的列之後被打開，它的設定一個字沒變，照上一條就永遠回不來。所以這一步掉的列，
  變更紀錄裡有新的被接受改動（停用、啟用、設定、恢復、patch；`failed`、`rejected` 與 `self-disabled` 不算）之後，下一條對話重新試它一次，
  又掉就記住這一次的位置、不再試，直到紀錄又有新的被接受改動。相容層的 `requires` 檢查排在 `apply` 之後，所以這一次「試」是真的
  跑一次它的 `apply` 再撤掉，不是每條對話都試。`module`、`config`、`apply` 那幾步掉的列不變，照上一條只看設定。
  邊角：依賴的列自己因為工作區而 `apply` 失敗、連帶它掉在 `requires`，依賴的列照上一條不重試，所以它等到紀錄有改動才回來。
- **掛上了、但外掛自己有話要講的，也在那段警告裡。** 例如 MCP 伺服器連不上：那一列照 dsh 照樣掛上、那台
  沒有工具，啟動時印「警告：N 則外掛掛上時交出的話」指名它與原因。`serve` 每條對話各連一次，某一條又連不上
  就記一行「[組裝] thread "…" 警告：…」，伺服器回來之後開的對話就有工具了。要它連不上就算掉，那一列的
  `config` 寫 `failOnStartupError: true`（掉了之後照上一條，到重啟或改了那一列為止不再連），見
  [`packages/nexus-plugin-mcp/README.md`](../packages/nexus-plugin-mcp/README.md)。
- **MCP 伺服器的使用指引與資源也進得來**（[#431](https://github.com/DemianLi/nexus-agent/issues/431)、
  [#430](https://github.com/DemianLi/nexus-agent/issues/430)）：伺服器 `initialize` 回的 `instructions` 會加上
  `### MCP server: <名字>` 接在系統提示詞後面，模型另有 `list_mcp_resources`、`list_mcp_resource_templates`、
  `read_mcp_resource` 三支工具讀它的資源。指引連同標頭超過 `maxInstructionBytes`（預設 32768 位元組）那一列算連線失敗，
  走上一條的 `failOnStartupError` 規則。細節見同一份 README。
- **MCP 結果會帶名稱與網址，並請模型標出處**（[#1319](https://github.com/DemianLi/nexus-agent/issues/1319)，超出 dsh）：
  server 回的 `resource_link` 給模型的文字是 `Resource link: <名稱> (<URI>)`（以前只有網址）；系統提示詞多一段
  `## MCP citations`，要模型說出答案用到哪個 MCP server、並把結果裡的連結用 markdown 連結標出來；只有**結果含 resource link
  時**，工具結果結尾才多一句引用提示。**這是對模型的請求，不是保證**：模型可能不照做，也可能只標連結不講系統名。server 回的結果沒有
  連結（只有文字）時，今天沒有任何東西能標出處——要等結構化來源（地圖 [#1318](https://github.com/DemianLi/nexus-agent/issues/1318) 的階段 B）。
- **同一段 `## MCP citations` 多兩條規則：只講結果裡有的事實、查無要先明說**（[#1345](https://github.com/DemianLi/nexus-agent/issues/1345)，
  超出 dsh）：結果只有標題或連結時要明說讀不到內容並附連結，不描述文件「應該」寫了什麼；結果說查無時先講查了什麼、什麼也沒找到，
  之後才可以問一個澄清問題。起因是 [#1329](https://github.com/DemianLi/nexus-agent/issues/1329) 的量測（B 組編流程 10/24、
  C 組先反問 20/24）。放在 MCP 段不放 persona，所以沒掛 MCP 時不出現。**同樣是請求不是保證**，效果與限制記在 #1345。
- **MCP 工具結果的原始資料不進會話日誌**（[#1320](https://github.com/DemianLi/nexus-agent/issues/1320)）：server 回的內嵌資源與
  `structuredContent` 模型看不到，但 adapter 把它們放在訊息的 `artifact`、會跟著進日誌（實測 3 MB 的資源就是約 3.1 MB 的
  `tool/result`，磁碟與記憶體都吃）。單條超過 8 KiB 的換成 `{ type: 'mcp_omitted', originalType, bytes, uri?, mimeType? }`，
  所以事後從日誌回放看不到那份原始內容，只看到它存在過、多大、哪個 URI。瀏覽器那一側本來就收不到（串流與歷史端點只送結果文字）。
- **MCP 伺服器掛上之後掉了線會自動重連**（[#1099](https://github.com/DemianLi/nexus-agent/issues/1099)，照 dsh）：500 ms
  起每次連續失敗加倍、上限 30 秒，連續失敗 10 次放棄，連上之後撐過 30 秒失敗次數歸零；斷線期間工具照列但呼叫失敗，連回來之後同一批
  工具又叫得動、定義不變。放棄之後那台的工具對模型隱藏，到下一次組裝才恢復。進度往伺服器日誌（stderr）寫。`reconnect.enabled: false`
  關掉。`tools/list_changed` 與重連後的新工具不處理（工具集合在組裝時定下）。
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
- **`insert` 進來的模組宣告的 `@nexus/core` 範圍要滿足**（[#1137](https://github.com/DemianLi/nexus-agent/issues/1137)）。
  指到檔案的那一列在 import 之前讀最近的 `package.json`，把 `peerDependencies["@nexus/core"]` 對執行中的 core 版本
  （`packages/nexus-core/package.json` 的 `version`）跑 semver 比對；不滿足時那一列掉了、其餘照樣起來，訊息
  寫 `套件@版本 需要 @nexus/core <範圍>，執行中的是 <版本>`，模組的程式碼一行都沒跑。範圍寫壞、`package.json` 讀不了一樣掉。
  沒宣告（沒有 `package.json`、沒有 `peerDependencies`、沒有 `@nexus/core` 那一格）就放行。**沒有豁免機制**。
  - **這個版本只有人守得住**：改了 registry 的形狀（欄位改名、註冊點簽章換形狀、聯集少一支）要跟著升 core 的 `version`，
    不然範圍檢查會放行一個其實已經不相容的插件。目前沒有機械守著。
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

出貨清單上這幾列（完整名單與順序以 `apps/harness/cordis.yml` 為準，這裡不寫顆數）：

| id                          | 管什麼                                                                                                                         | 有 `config` 嗎                   | 關得掉嗎                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------ |
| `repeat-reminder`           | 連續重複同參數呼叫同一個工具時提醒模型                                                                                         | 有（四格）                       | 關得掉                   |
| `tool-result-pruner`        | 摘要之前先剪掉過長工具結果的中段                                                                                               | 有（三格）                       | 關得掉                   |
| `summarization`             | 壓力達標時把舊訊息摘要成一則，歷史 offload 到 backend                                                                          | 有（四格）                       | 關得掉                   |
| `observation-policy`        | 先讀後改：沒讀過的檔不准改                                                                                                     | **沒有**                         | 關得掉                   |
| `model-usage`               | 每一次模型呼叫的 token 帳目記進會話日誌                                                                                        | **沒有**                         | 關得掉                   |
| `session-checkpoint-policy` | 模型請求與工具動手之前（root 與子代理都是），先把會話日誌排空到磁碟                                                            | **沒有**                         | 關得掉                   |
| `approval-gate`             | 核准閘門                                                                                                                       | **沒有**                         | **關不掉**               |
| `session-persistence`       | 會話日誌落盤本身，以及它的批次窗口（毫秒）                                                                                     | 有（一格）                       | 關得掉（＝不落盤）       |
| `thread-title`              | 會話標題的三個上限（退回標題的詞數與位元組，以及任何來源的標題的位元組）                                                       | 有（三格）                       | **關不掉**               |
| `thread-title-llm`          | `--live` 時由模型依第一句話產生會話標題                                                                                        | 有（五格，另有選配的 `modelId`） | 關得掉（＝只剩退回標題） |
| `thread-search`             | 按內容搜尋以前的會話（側欄的搜尋框）；**出廠不開**                                                                             | 有（一格）                       | 關得掉（＝搜尋一律失敗） |
| `thread-capacity`           | serve 行程裡最多同時有幾條 thread，與閒置的 thread 多久之後撤出記憶體；**出廠開著**（500 條、2 小時）                           | 有（兩格）                       | **關不掉**               |
| `downlink`                  | 下行串流的心跳間隔，與每條下行線排著等送的位元組上限；**出廠開著**                                                              | 有（兩格）                       | **關不掉**               |
| `browser-session`           | 瀏覽器 cookie 的絕對有效期                                                                                                     | 有（一格）                       | **關不掉**               |
| `deliverable-files`         | 交付檔的三個上限（一頁位元組／整檔位元組（只管整檔讀）／一頁行數）                                                             | 有（三格）                       | **關不掉**               |
| `tool-text`                 | 工具結果的結構化資料（`meta`）與壓縮摘要全文放上線的位元組上限（結果文字本身不截）                                             | 有（一格）                       | **關不掉**               |
| `live-model`                | `--live` 時真實供應商的連線值（端點／預設模型 id／逾時／重試次數），加上模型型錄（每顆的窗口、輸出上限、收不收圖、怎麼關推理），以及全機的模型請求並行上限（選配，出廠不限） | 有                       | **關不掉**               |
| `agent-default-model`       | 沒帶 `--live` 時用哪個模型提供者（出貨值 `cli-script` 是清單上的腳本提供者那一列）                                             | 有（一格）                       | **關不掉**               |
| `recursion-limit`           | agent 迴圈的 super-step 上限                                                                                                   | 有（一格）                       | **關不掉**               |
| `agent-loop`                | 模型同一步吐出多顆工具呼叫時，同時在跑的最多幾顆                                                                               | 有（一格）                       | **關不掉**               |

**從 `session-persistence` 往下的這一段，除了 `session-persistence` 之外，都是「不裝功能、只講設定」的那一型；`session-persistence` 例外，
它代表落盤本身**（[#612](https://github.com/DemianLi/nexus-agent/issues/612)，關掉就不落盤）。**擁有者分兩邊**：`session-persistence` 住在
`@nexus/core`（值的家在那個套件裡），表上 `thread-title` 以下的其餘各列住在 `apps/harness`
（[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。
**更要緊的分界是消費點跑的時刻**：

- **`session-persistence`、`thread-title`、`thread-title-llm`、`thread-search`、`thread-capacity`、`browser-session`、`deliverable-files`、
  `tool-text`、`live-model` 跑在註冊表存在之前**，所以 `apply` 是空的、值在起動期解一次往下傳。`thread-search`、
  `browser-session`、`deliverable-files`、`tool-text` 的消費點分別是內容搜尋的索引、瀏覽器會話的建構子、兩支交付方法（`deliverable.read`／`deliverable.readBytes`）、
  以及工具結果 `meta` 與壓縮摘要那兩條（即時的 `ThreadPump` 與重播的 `historyPage`，都在 `createWireHandler` 的閉包底下），
  **只在 `serve` 上有作用**；**`session-persistence`、`thread-title` 與 `live-model` 兩條路都讀**——`session-persistence` 由
  `cli.ts` 與 `serve.ts` 各自在接落盤時讀；`thread-title` 在 serve 上給冷讀清單、pump 與歷史，在 CLI 上給
  寫退回標題的 `runTurn`（[#647](https://github.com/DemianLi/nexus-agent/issues/647)）；`live-model` 各自在起動期
  解一次、交給組裝去建 model（只有 `--live` 用得到）；`thread-title-llm` 跟它一起在建 model 的那一刻讀，
  另建一顆標題用的（[#650](https://github.com/DemianLi/nexus-agent/issues/650)）。

**換模型提供者**（[#670](https://github.com/DemianLi/nexus-agent/issues/670)，照 dsh 的 `agent-default-model`）：沒帶 `--live`
時模型由 `agent-default-model` 那一列的 `provider` 選。出貨值 `cli-script` 是 `cordis.yml` 上的一列腳本提供者（`#settings/scripted-model`，假模型的預設腳本就是它的 `config.turns`，`--dump-config` 看得到）；要換就在 patch 裡
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
不會讓標題不再被裁切、cookie 不再過期、交付檔不再有上限、工具結果的 `meta` 與摘要不再被截、
`--live` 不再有連線設定——那一列
被當成沒有那一列，值回到 schema 的預設，行為一個位元組都不變。`recursion-limit` 與 `agent-loop` 硬一級
——關掉它確實會讓那顆服務消失，但組裝點接著落回內建的 100／10，**護欄還在**，讀起來卻像把上限
解除了（基座自己那層是一萬／不限）。兩種都只會讓你以為關掉了什麼。寫 `disabled: true` 是啟動失敗，
**訊息會指名你那一列自己的理由**，不是一段通用的話。

**改 `tool-text` 的 `maxBytes` 會讓一條跨套件的比例失效，而且沒有任何東西會擋你。**
`@nexus/wire` 的一頁歷史上限是 8 MB，那個數字是照每張工具卡的最壞值算的：一張卡是結果文字加上給專屬卡的
結構化資料（`meta`），`meta` 的上限是這一格（搜尋、改檔）或它的兩倍（讀檔，
[#630](https://github.com/DemianLi/nexus-agent/issues/630)）。結果文字自
[#736](https://github.com/DemianLi/nexus-agent/issues/736) 起不歸這一格管：它原樣上線，上限在模型面（`spill-policy`
那一列與讀檔自己的上限），算法寫在 `HISTORY_PAGE_MAX_BYTES` 的說明上。那個關係由 `apps/harness` 的一條測試釘著，
但**它只釘得住出廠那一份**：你在 patch 裡把 `maxBytes` 改小，一頁能裝的滿版卡就變多，8 MB 那個上限相對
變鬆；改大則相反。關掉 `spill-policy` 也會讓卡上的文字沒有上限（同 dsh），8 MB 是軟的，超標時 server 只會講一聲。兩邊都
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
  `reasoningEfforts`（`off:` 是不推理）、`imageBudget`（一次請求收得下的圖，見「圖片額度與 `image/offload`」，沒寫不檢查）與 `compat`（關推理的 chat template 參數）。**寫 `models` 是整份取代**，
  不是逐筆合併：想只改預設那一筆的 `maxTokens`，要把整筆連 `reasoningEfforts` 與 `compat` 一起重述。
  出貨型錄有三筆：預設那顆；`meta/llama-3.2-11b-vision-instruct`（宣告純文字：#732 實跑量到它在**請求帶 `tools`** 時，圖在**整段對話的第一則使用者訊息**就 400「The number of image tokens (0) must be the same as the number of images (1)」（前面已有一輪往返再帶圖就正常），產品每一輪都帶 `tools`，而型錄表達不出「第一則不收」，所以寧可收件時就拒圖，也不讓最常見的路——新對話第一句帶圖——跑到一半撞 400；代價是已有歷史時它其實看得到圖卻被擋）；與看圖模型 `meta/llama-3.2-90b-vision-instruct`（帶 `tools` 也收得了圖，單次約 68–76 秒，**每次請求最多一張圖**（`imageBudget.maxImages: 1`，#1270 量到 2 張起回 400），**窗口只有 32,768**，2026-10-09 真端點量過：`max_tokens` 131072 回 400「maximum context length is 32768」）。`maxTokens` 取 4096 是選擇不是上限。**新增一筆之前先確認它吃得下自己的 `maxTokens`**——出貨那顆模型是拿「吃不吃得下
  16384」當淘汰門檻選出來的，吃不下的模型會**每一次**呼叫都失敗，沒有任何東西會擋你。
- **`baseUrl` 要是 `http:` 或 `https:` 的網址，不能帶帳密、query 或 fragment**（照 dsh）。`http:` 放行，
  所以指向內網的明文端點是合法的——**key 會以明文送過去**，那是部署自己的判斷。
- **`retryPolicy`：模型請求失敗的重試，一條政策、一份預算**（[#1427](https://github.com/DemianLi/nexus-agent/issues/1427)，形狀與驗證逐條照 dsh 的 `retryPolicy`）。
  **首事件之前與之後共用同一份次數**，SDK 層不重試（`@langchain/openai` 底層 client 的 `maxRetries` 恆為 0），打到端點的請求數就是 `maxRetries + 1`，
  日誌上 `llm/retry` 的顆數就是實際重打的次數。標題、摘要器生摘要的那一次呼叫也吃同一份。寫法：

  ```yaml
  retryPolicy:
    mode: normal                 # 寫了 retryPolicy 就必填；只收 normal，always 拒收（見下）
    maxRetries: 6                # 非負整數，0 關掉；沒有上限
    retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]   # 預設就是這五個；不能空、不能重複
    backoff:
      initialDelayMs: 500        # 大於 0，之後每次加倍；不能大於 maxDelayMs
      maxDelayMs: 10000          # 單次等待上限，也是 retry-after 肯等的上限
      jitterRatio: 0.1           # 0 到 1
  ```

  整個不寫就是上面這組出廠值。**次數取 6（dsh 預設 5）**：不計抖動的累計等待約 25.5 秒，蓋得過 2026-08-28 量到的 16 秒限流窗口——
  **那次量的是 `openai/gpt-oss-120b`，出貨的 nemotron 沒量過**。代價：串流中段失敗最壞重付 6 次整個回覆。
  **重打只看失敗的碼**（#1437）：失敗只有一支分類器，`llm/retry` 與 `turn/failed` 同一個碼，碼在 `retryableCodes` 裡才重打。
  碼的對應：429（含沒帶 `retry-after` header 的）是 `RATE_LIMIT`、5xx（含串流中段與沒有數字碼的錯誤信封）是 `SERVER`、逾時是 `TIMEOUT`、
  連線層的失敗（連線被拒、讀串流時被切斷）是 `TRANSPORT`、「模型說停了（stop）卻沒有任何文字、推理或工具呼叫」是 `EMPTY_RESPONSE`——
  這種空回覆照同一份預算重打，預算用盡就是這一輪失敗、`turn/failed.error.code` 是 `EMPTY_RESPONSE`（使用者看到的是失敗訊息，不再是什麼都沒有）。
  **只有推理、沒有答案的回覆不重打**（沒有失敗訊息，網頁上只多一段折起來的思考過程）。
  不在清單裡的不重打，不管預設或自己寫的清單怎麼寫：401／403 `AUTH`、402／配額 `QUOTA`、400／413 `INVALID_REQUEST`、上下文溢出
  `CONTEXT_WINDOW_EXCEEDED`、其他 4xx `HTTP_<狀態>`（404、408、410、418、422、425…，**依 dsh，不是量到的救回率**）、解不開的回應 `UNKNOWN`。
  把 `HTTP_422` 之類加進 `retryableCodes` 就會重打它。標題、摘要器與 eval 的呼叫不經過「空回覆算失敗」那一步（它們沒有「這一步沒有答案就失敗」的語意）。
  供應商給的 `retry-after` 不超過 `maxDelayMs` 就照它等（不加抖動），**超過就直接放棄**、不重打；每次等待是 `initialDelayMs` 倍增、
  封頂 `maxDelayMs`，抖動之後再夾到上限。**`mode: always`（無限重試）拒收**：這是對 dsh 的登記偏離——一輪沒有盡頭、中段失敗每次重付整個回覆，
  撤除條件是需要無限重試的情境（`docs/plugin-contract.md` 偏離表）。
  **舊欄位大聲失敗，不自動轉換**：頂層 `maxRetries`（舊 SDK 層次數，預設 6）與 `streamRetry`（舊串流中段，預設 2）都已拿掉，寫了會讓 `--live` 起不來，
  訊息指名舊欄位與 `retryPolicy`。兩個舊數字沒有無損的合併方式，請自己決定新的次數。**從 `plugin config set live-model --file -` 寫的可以直接改；
  寫在 `--patch` 檔裡的舊值寫入口蓋不掉，要自己改那個檔。**
  **逾時拆兩格**（[#1251](https://github.com/DemianLi/nexus-agent/issues/1251)，同 dsh 的 `timeoutMs`／`streamIdleTimeoutMs`）：
  `timeoutMs`（預設 180000）管連線到第一則事件，逾時會重試；視覺模型要先吃圖才吐第一則事件（`meta/llama-3.2-90b-vision-instruct` 實測 133 秒），所以比閒置那格寬。
  `streamIdleTimeoutMs`（預設 90000）管第一則事件之後每一段之間的閒置，逾時整次重打（吃同一份 `retryPolicy`）；dsh 預設 300 秒，我們維持 90 秒，因為每次重打都重付整個回覆。
  兩格上限都是 2 147 483 647（同 `windowMs` 的理由），**互不連動**：只改 `timeoutMs` 不會動到閒置，舊設定裡寫過 `timeoutMs` 且想保留舊行為的，把同一個值也寫到 `streamIdleTimeoutMs`。
  **最壞情況：端點開了線卻一個位元組都不吐，一輪要二十一分鐘多才失敗。** 每一次都等滿 `timeoutMs`，嘗試數是 `maxRetries`（出廠 6）加第一次共 7 次，
  所以是 180 秒 × 7 = 21 分鐘，再加 6 次退避（0.5、1、2、4、8、10 秒，帶 ±10% 抖動，合計約 25.5 秒），大約 21.5 分鐘。
  要讓它更快失敗，調的是 `timeoutMs`（或 `retryPolicy.maxRetries`）；代價是視覺模型的首事件長尾（`meta/llama-3.2-90b-vision-instruct` 逐一實測最長 133 秒）會被撞到，
  `timeoutMs` 低於 133000 就會砍到它。
- **重打時畫面怎麼走**（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）：決定重打的**當下**，上一次吐了一半的回覆在畫面上被擦掉（`message-discard`），
  畫面收到 `llm-retry`（第幾次、等多久、失敗碼，用來畫「N 秒後重試」）；日誌留一顆 `assistant/attempt`（不進模型）與 `llm/retry`（帶 `delayMs`）、
  `llm/retry-started`，失敗那次的 `model/end` 帶 `outcome: error`、用量照記。退避期間按停止：輪次以中止收尾、不再重打。請求本身有問題的錯誤（例如串流內的 400）不重打。
  第一則事件之前的失敗沒有半段回覆可擦，只有倒數與 `llm/retry`。**子代理的回覆也會重打，但已經畫出去的子代理字
  不會被擦**（畫面上多一則斷尾的回覆）。
- **關推理的寫法在型錄那一筆**（[#650](https://github.com/DemianLi/nexus-agent/issues/650)、原本的 `thinkingOffBody`）：
  `off` 那一級加 `compat.chatTemplateKwargs`（`$var: thinking.enabled` 在 `off` 解成 `false`）。它只有標題呼叫會
  加進請求 body，主請求不帶。出貨那顆模型不關推理的話，標題那 64 個輸出 token 全被推理吃光，一個標題都回不出來
  （實測 0/6；關掉之後 6/6）。換一顆不認得 `chat_template_kwargs` 的模型時，那一筆不要寫 `compat`，或另外量它自己
  的寫法——不認得的參數可能讓標題請求整個 400，也可能靜靜沒效果。
- **key 不在這一列**：從 `NVIDIA_API_KEY` 讀，來源與順序見「金鑰放哪裡」。
- **`eval` 與 `spike` 不跟這一列走**：它們量的是出貨預設那一組設定底下的模型。

**每會話選模型**（[#723](https://github.com/DemianLi/nexus-agent/issues/723)，只有 `serve --live`）：web 的模型座列出型錄（`model.catalog`），
使用者替**這條 thread** 挑一顆模型與推理強度（`model.select`）。幾件要知道的事：

- **從下一步生效，跑著的那一步不換。** 每一步開頭快照選擇；步跑到一半才選的，下一步才用。沒選過的 thread 送出去的請求與以前逐位元組相同
  （2026-10-09 在兩棵樹上各跑兩輪、比整份請求本體，一致）。
- **換了模型，下一個請求多一則 user 角色的通知**（文字逐字照 dsh：`[model changed: assistant turns above this point were generated by X; the session continues with Y]`），
  進對話狀態與會話日誌（`user/message`，來源 `model-selection`）。**只換推理強度不附。**
- **選擇記在會話日誌**（`model/selection`；`model/start` 帶 `route`＝這次請求實際走的模型）。續接時沿用：使用者最後選的 → 最近一次請求走的 → 部署預設。
  **不存成個人預設**（dsh 沒掛設定編輯器時也存不住，PM 2026-10-08 決策）：新開的 thread 一律從部署預設起。
- **推理強度只有 `off` 與 `default`**，而且模型的型錄條目要宣告過；型錄沒有那顆、或帶了沒宣告的強度，`model.select` 回 `model_unavailable`，選擇不變。
  沒有推理資訊的模型，型錄回應不帶強度，web 不畫強度列。
- **跟著選擇走的**：摘要門檻（夾在當步那顆的窗口之內，`min(窗口×0.8, 窗口−輸出上限)`，配置的 `100_000` 仍是上限，所以預設那顆與 131k 級的門檻不變）、
  系統提示詞的 `{{model}}`、token 估算的錨（按模型名字認）、標題（沒有自己的 `modelId` 時沿用觸發它的那次主請求走的）。
- **子代理也跟著選擇走**（#328 第 3 項）：沒設定的子代理沿用主對話此刻的選擇，前景逐次跟隨、背景在委派那一刻定下，定義也可以釘住自己的模型，
  細節與優先序見「子代理定義裡的模型與上限」；模型在委派時自己挑的見「子代理選模型的政策」。
- **選擇變更的即時推送**走會話投影通道（key `model-selection`，view 是 `{ lastUsed, next }`），多個分頁同步。

**`thread-title-llm`**（[#650](https://github.com/DemianLi/nexus-agent/issues/650)）只在 `--live` 時才跑：每條新
thread 的第一句話開跑、主回覆的第一次模型呼叫送出之後，另外打一次標題請求，回來的標題蓋過退回標題
（列表、畫面標頭、歷史都讀最後一顆）。續接回來的舊 thread、第二句以後、子代理都不打。幾件要知道的事：

- **每條新 thread 多一次請求**，走 `live-model` 那一列的端點與 key，輸出上限是這一列的
  `maxOutputTokens`（64，不看型錄）。**模型預設沿用 `live-model` 的預設模型**；選配的 `modelId`（[#657](https://github.com/DemianLi/nexus-agent/issues/657)）
  可以改挑那一列 `models` 型錄裡的另一筆（例如一顆便宜、沒有推理的），關推理的寫法跟著那一筆走。
  挑的 id 不在型錄裡，帶 `--live` 時 CLI 與 serve 都在啟動時起不來，訊息指名這一列與那個 id。換之前照 #650 的量法量一次
  （`maxOutputTokens` 64 下，關推理與不關推理各跑 6 次）。`session/title-llm-request` 的 `route.model` 與標題的來源記的是實際走的那一顆。
  dsh 那一對成對的 `provider`／`model` 我們只有 `modelId`：一個組裝一條連線，沒有第二個端點可挑。這次呼叫**不計進會話統計，也不寫 `model/usage`**（同 dsh），所以用量表上看不到它。
- **重試政策沿用 `live-model` 的 `retryPolicy`**（同一份次數與退避，標題不寫 `llm/retry`），但整段有這一列的 `timeoutMs`（60 秒）封頂，
  退避也聽得到那個時限，所以最壞是等滿 60 秒。
- **失敗只講一聲**：標題請求照同一份 `retryPolicy` 重試，用完仍失敗就只講一聲——serve 記進伺服器日誌、CLI 印在 stderr，前綴都是 `[標題]`，退回標題留著，不另外再排一次標題生成。
  `finish_reason` 不是 `stop`（例如推理吃光上限）、要求呼叫工具、正規化後是空的、輸入超過 `maxInputBytes`，
  都算失敗。
- **CLI 一次性的呼叫多半等不到它**：主回覆收完行程就收尾，還沒回來的標題請求會被中止（不講話），只留退回標題。
- 送出去的系統提示與訊息原文記在日誌的 `session/title-llm-request`，想知道模型看到什麼去讀那一顆。

**`thread-search`**（[#631](https://github.com/DemianLi/nexus-agent/issues/631)）讓側欄按**內容**搜尋以前的會話，
不只比標題。**出廠不開**，同 dsh 的產品組裝：要不要多背一份搜尋索引是部署自己的選擇。多人共用的主機上沒有「整台
一起設」的那一層，想用的人用 `plugin config set thread-search --file -` 寫入下面這段（`plugin enable` 不需要，它本來就是掛著的，
只是 `openAt: never`），或放進自己的 `--patch <檔>`：

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

**`thread-capacity`**（[#1476](https://github.com/DemianLi/nexus-agent/issues/1476)、[#1484](https://github.com/DemianLi/nexus-agent/issues/1484)、[#1619](https://github.com/DemianLi/nexus-agent/issues/1619)）給 serve 行程裡的 thread 數設上限（第 2 級），
並讓閒置的 thread 被撤出記憶體（第 1 級，見下面「閒置逐出」），是逐級降載的「底座保險絲」（量測與背景見 #1464：每條 thread 常駐約 2 MB heap，只讀歷史也有）。
**出廠兩格都開著**：上限 500 條、閒置 2 小時撤出。出貨清單那一列寫的就是這一組，值的家在 schema（`apps/harness/src/settings/thread-capacity.ts`）。
要放寬就把數值調大，放進自己的 `--patch <檔>`（或 `plugin config set thread-capacity --file -`）：

```yaml
- id: thread-capacity
  config:
    maxThreads: 1000
    idleEvictAfterMs: 7200000
```

- **`config` 是整份替換，但只寫一格不會丟掉另一格**：沒寫的那一格由 schema 補上出廠值。上面兩格都寫出來，是為了讀的人一眼看得到現在是多少。
- **500 怎麼來的**（這個數字 dsh 沒有，登記為「產品需求超出 dsh」）：dsh 記憶體量測最小的機型是 4 GB；**假設**留一半給主機上的其他人（這是假設，不是量的），
  serve 約有 2 GB；扣掉閒置的行程樹約 533 MB，剩約 1.5 GB；除以每條短 thread 約 3 MB，約 500 條（數字是 macOS 上量的，Linux 量完會重估）。
  **這是後盾，不是記憶體保證**：長對話每輪還要再加幾 MB，thread 數上限擋得住「thread 很多」，擋不住「thread 很長」。
  定得寬是刻意的：讀歷史也佔名額，定太低的話，一個人在側欄連點很多舊對話就能把其他人擋在外面。
- **數的是行程裡的 thread 數，含還在組裝中的**。到了上限，**新的** thread 一律拒收：送訊息、開下行、讀歷史、續聊磁碟上的舊
  thread 都算（它們都要為那條 thread 組一份 agent）。**已經在行程裡的 thread 不受影響**，列表、停止、回饋這些不新建 thread 的路也不經過這一道。
- **拒收回專用錯誤碼 `thread_at_capacity`**，message 寫出上限與下一步；serve 日誌每次拒收記一行，含目前數量與上限。起動時一律印兩行：
  `thread 上限：N（…）`，以及 `thread 閒置逐出：…`（閒置 T 毫秒後撤出／`idleEvictAfterMs` 是 0，不逐出／沒有落盤，不逐出 三種之一），
  不確定是出廠值還是自己改過的值，看這兩行。
- **名額會自己回來**：閒置的 thread 被撤掉就還名額（下一段）。逐出關掉（`idleEvictAfterMs: 0`）或沒有落盤時，名額要**重啟 serve** 才會清空（建構失敗的那條會當場釋放）。
  沒有排隊、搶占，也不會因為滿了就自動關掉最舊的。**正在撤的 thread 也佔名額**，撤完才還；撤的當中有人要同一條 thread，會等它撤完、重新組一份。
- **起動時讀一次，改了要重啟**。
- **這一列關不掉**：寫 `disabled: true` 啟動當場拋錯。兩格都有出廠值，關掉只會回到同一組值，讀起來卻像拆了保險絲（同 `downlink` 那一列）。
  **要放寬，把數值調大；要關閒置逐出，設 `idleEvictAfterMs: 0`**。`maxThreads` 沒有「不限」，最小是 1；寫 0 會被 schema 擋下：**壞設定回到預設、不拒絕啟動**——這一列照「設定驗不過」掉列、
  啟動警告指名它，值回到出廠的 500，到了 500 照樣拒收。
- **偏離 dsh（登記）**：dsh 沒有 thread 數上限；這是 serve 跑在多人共用主機上才有的產品需求。形狀借的是 dsh 背景工作的准入
  （`jobs-local` 的 `maxConcurrentJobsPerOwner`），逐點見 `apps/harness/src/settings/thread-capacity.ts` 的檔頭。「有上限就出廠打開、給有限的預設值、
  沒有『不限』」照 dsh 各入口的上限（背景工作、終端數、背景子代理都是這樣）。
- web 怎麼顯示這個錯誤碼另開卡給前端，不在這一張。

**升級注意（#1619 之前的部署）**：這一列從「出廠不開」改成「出廠開著」，三種既有部署會碰到變化，各自怎麼回到舊行為：

- 原本沒設上限的：行程裡到了 500 條開始拒收新 thread。要更寬，把 `maxThreads` 調大。
- 原本沒開逐出的：沒人看著的 thread 閒置 2 小時開始被撤出記憶體（代價見下一段的「已知限制」）。要回到不逐出，設 `idleEvictAfterMs: 0`。
- 原本關掉這一列的：升級之後 serve 起不來，錯誤訊息指名這一列，也講是在哪裡關的。
  - **用變更紀錄關的**（`plugin disable thread-capacity`）：跑 `plugin enable thread-capacity`。紀錄還留著那一筆停用時，別的 `plugin` 改動也會被拒，訊息帶同一句修法。
  - **在 patch 檔裡寫 `disabled: true` 的**：把 `disabled` 拿掉。
  - 要舊的「不限、不逐出」，就把 `maxThreads` 調大、`idleEvictAfterMs` 設 0。

**閒置逐出（`idleEvictAfterMs`，[#1484](https://github.com/DemianLi/nexus-agent/issues/1484)，第 1 級）**：同一列的另一格，毫秒數 T，**出廠 7200000（2 小時）**，照 dsh 終端的閒置回收；
**`0` 是不逐出**，同樣照 dsh。只想改這一格：

```yaml
- id: thread-capacity
  config:
    idleEvictAfterMs: 1800000   # 閒置 30 分鐘後撤出記憶體；0 是不逐出
```

- **計時方式**：一條 thread 的「閒置條件」**全部同時成立**才開始算，連續滿 T 才撤；中途任何一條不成立（有人又說話、開了下行、背景子代理又有活…）就歸零重算。
  不是「滿了就撤最舊的」。輪詢間隔是 T 的十分之一，夾在 1 到 30 秒。
  有些條件轉回閒置時不會推「最後活動時間」（標題寫完、背景子代理轉為收完），所以實際閒置到被撤**最短約 T 減一個輪詢間隔**（至多少 T/10），不是剛好 T。
- **閒置條件（全部要成立）**：沒有輪在跑、沒有掛著的核准或提問、輸入佇列與下一步佇列是空的、沒有目標驅動的輪在途、沒有下行訂閱者掛著、
  背景子代理全部收完、目標沒有武裝著、標題沒有在生、沒有斜線指令在途、沒有 prompt 請求在途、沒有 HTTP 請求握著這條 thread。
  最後一條是計數器，**在請求進來的那一刻就同步 +1**，連還沒進記憶體的 thread 都算，所以「訊息送到一半、thread 被撤」不會發生。
- **撤的順序**：關泵 → 收下行、標題、檔案搜尋、附件、落盤、agent → 作廢上傳收據 → 重寫 `plugin-snapshot.json` → 名額放掉。每一步獨立容錯，
  任何一步拋錯只記一行日誌，不會留下撤到一半的 thread；快照重寫失敗同樣只記一行（`PluginSnapshotWriter.publish` 從不拋）。服務關機時會等正在撤的收完。
- **開著頁籤的 thread 不會被撤**：「沒有下行訂閱者」是閒置條件之一，使用者的頁籤只要沒關，那條 thread 就一直佔著記憶體。逐出回收的是**沒人看著**的 thread（關掉頁籤、離開的人），不是所有閒著的 thread。
- **只有開了落盤才生效**：沒有 `session-persistence` 時日誌只在記憶體裡，撤了就沒了，T 不會傳下去；啟動日誌那一行說「沒有落盤，不逐出」。
- **已知限制（決策：接受「等價於重啟」的退化）**：被撤的 thread 再開，就是**重啟 serve 之後再開**——歷史、權限模式、停住的佇列、冷的背景子代理照磁碟上的日誌重組；
  **行程記憶體裡的東西不在了**：上傳收據（舊的收據要重新上傳）、`present` 的等待交付表（見 `docs/plugin-contract.md`）、插件快照裡它那一列；
  **重組時吃當下的設定與插件版本**（見上面「後台改清單」的第三個已知限制）。web 的下行會斷，重連時 thread 重新組裝。
- **起動時讀一次，改了要重啟**。`maxThreads` 與 `idleEvictAfterMs` 可以只設其中一個，另一個留在出廠值。
- **要在整段對話裡釘住組裝它的那一版**（見「後台改清單」的第三個已知限制），設 `idleEvictAfterMs: 0`。
- **偏離 dsh（登記）**：dsh 頂層沒有閒置逐出（程式碼裡是 legacy TODO）；出廠值 2 小時與「0 是不逐出」照 dsh 終端的 `unattendedTimeoutMs`。閒置條件借的是**子代理結算**（沒有輪、沒有佇列、沒有未收完的子工作），
  計時方式借的是 **terminal retention**（條件全成立才開始算、任何一次忙碌就歸零、到 T 才收）。形狀逐點見 `src/wire-handler.ts` 的 `WireHandlerOptions.idleEvictMs`。

**`memory-gauge`（[#1490](https://github.com/DemianLi/nexus-agent/issues/1490)）**讓 serve 把自己的記憶體寫進日誌，給管理者看「serve 多大、容器還剩多少、主機還剩多少」。**預設關閉**：不寫這一列，或寫 `reportIntervalMs: 0`，除了清單多一列（`[對照快照]` 的列數、`plugin-snapshot.json`、`--dump-config`），serve 的行為與日誌和沒有這一列時一樣。

```yaml
# ~/.nexus-agent/cordis.patch.yml
- id: memory-gauge
  config:
    reportIntervalMs: 60000   # 0＝不啟動；開了是 1000 到 2147483647（計時器上限，約 24.8 天）
    warnAtPercent: 75         # 用量警告門檻，1 到 99 的整數；取樣開著才檢查（見下面「用量警告」）
```

- **打開之後**：serve 起動的披露都印完之後立刻寫一行，之後每隔 `reportIntervalMs` 毫秒一行，例如
  `記憶體：行程 RSS 612.3 MiB、heap 已用 301.2 MiB／已提交 388.0 MiB；cgroup v2 / 640.1 MiB／4096.0 MiB；主機可用 8000.0 MiB／16000.0 MiB（MemAvailable）`。
- **三個來源各自讀，讀不到的明說**，不回 0：行程自己（RSS 與 heap，到處讀得到）；容器上限（Linux 的 cgroup：**先解 `/proc/self/cgroup`，讀行程自己所在的那個 cgroup**，不是掛載根——v2 取 `0::` 那一行、讀 `memory.current`／`memory.max`，v1 取 `memory` controller 那一行、讀 `memory.usage_in_bytes`／`memory.limit_in_bytes`，hybrid 先試 v2、v2 沒有 memory controller 再試 v1；日誌上印出那個路徑，systemd 底下會是 `/system.slice/…`、docker 預設是 `/`。沒設上限寫「沒設上限」；沒設上限而 `process.constrainedMemory()` 報了比主機小的限制時另外寫「行程受限 … 上限可能在上層 cgroup」；`/proc/self/cgroup` 不在（macOS）寫「cgroup 讀不到（… 沒有 cgroup …）」，別的失敗點名是哪個檔怎麼了）；主機（Linux 的 `/proc/meminfo` 的 `MemAvailable`，沒有才退到 `os.freemem()`，行尾標出是哪一種——**兩種數字不能直接比**：macOS 的 `os.freemem()` 不含可回收的快取，會比實際少）。
- **只讀、只講**，不拒收、不逐出、不下架；也不寫進 `plugin-snapshot.json`。看了之後要不要做動作（下架插件）等量測的數字出來再決定。
- **用量警告（[#1493](https://github.com/DemianLi/nexus-agent/issues/1493)，「底座保險絲」第 0 級）**：取樣開著時，每次讀數之後再和 `warnAtPercent`（預設 75）比一次。**取樣關著（預設）就整段不檢查**，serve 的日誌與沒有這個功能時一樣。
  - **分母**：容器有 cgroup 上限時是 `memory.current ÷ memory.max`；cgroup 自己沒設、但行程受限（上限在祖先 cgroup）時用受限的值；都沒有就看主機的 `(總量 − 可用) ÷ 總量`，其中「可用」只認 `/proc/meminfo` 的 `MemAvailable`。警告裡寫明用的是哪一個。**主機退到 `os.freemem()`（沒有 `/proc/meminfo`）時當成讀不到**：它不含可回收的快取，用量天生偏高，會一直誤報。所以在 macOS 上 cgroup 和主機都不可用，**整個不警告**，只在起動時講一次原因。
  - **`memory.current` 會高估**：它含 page cache，沒有扣 `inactive_file`（照拍板）。#1490 在 1g 容器實測高於行程 RSS 約 28 MiB、4g 約 170 MiB。長期跑下來 page cache 會把讀數推高後停在高處，警告響一次之後可能一直不恢復；因為只在越過時講一次，代價只有那一行日誌。
  - **講幾次**：**嚴格超過**門檻講一次，之後不重複；降到「門檻 − 5」**以下**（嚴格小於）才講一次「已恢復」。在門檻附近來回不會洗版。
  - **警告長這樣**（固定前綴 `[記憶體]`，只寫 serve 日誌）：`[記憶體] 警告：記憶體用量（cgroup v2 /）80.0%，超過門檻 75%（800.0 MiB／1000.0 MiB）。serve 現在有 37 條 thread（上限 500）。下一步：調低 thread-capacity 的 maxThreads，或縮短 idleEvictAfterMs（改了要重啟 serve）；門檻是 memory-gauge 那一列的 warnAtPercent。`
  - **讀不到就不判斷、不警告，也不當成 0%**：兩個來源都讀不到時，講一次原因，之後不重複；不可讀期間狀態保持不變（讀不到不算恢復），回來時接續。從可讀變成不可讀才再講一次。
  - **只警告，不做任何動作**：不拒收、不逐出、不下架。web 看不到這一行（等管理員身分，[#1428](https://github.com/DemianLi/nexus-agent/issues/1428)）。
  - **偏離 dsh（登記，理由 2：產品需求超出 dsh）**：dsh（`687f282e`）沒有執行期記憶體監看；「讀不到就不警告」借 dsh 終端回收的形狀（`packages/api/terminal-controller/src/retention.ts:119`、`:122`：檢查失敗記成 `state: 'unknown'`、不是 `idle` 就不收）。
- **只量 serve 這一個行程**，不含它起的子行程（MCP 的 stdio 子行程、`rg`）。cgroup 那一格涵蓋同一個容器裡的整棵行程樹，所以在容器裡跑時，`cgroup` 的數字比 `行程 RSS` 大多少，就是子行程與其他行程佔的。
- **起動時讀一次，改了要重啟**。間隔寫小於 1000 的非零數字，這一列在載入期被丟掉（和其他設定驗不過的列一樣，日誌會說「設定驗不過」），量具不啟動。
- **偏離 dsh（登記，理由 2：產品需求超出 dsh）**：dsh（`687f282e`）沒有執行期的記憶體監看，它的記憶體只在 CI 量（無 swap 的 cgroup 模擬 4／8 GB 機器）。這一列是多人共用的內網主機才有的需求。讀 cgroup 的方法照 dsh `scripts/run-memory-pressure-bench.ts:63-66`（`/proc/self/cgroup` 加 `process.constrainedMemory()`）；多出來的只有 v1／hybrid 的讀法（dsh 的 bench 只認 v2）。逐點見 `src/memory-gauge.ts` 的檔頭。

**模型請求並行上限（`live-model` 的 `maxConcurrentRequests` 與 `maxWaitMs`，[#1505](https://github.com/DemianLi/nexus-agent/issues/1505)）**給整台 serve 同時在跑的模型請求數設上限。
多人共用一把供應商 key 時，一條失控的 thread（同一步的 `task`／`subagent` 可以重疊，背景子代理每個主對話最多 8 個）同時開出十幾條模型串流，會把每分鐘配額一次打穿；
供應商回 429，所有人的請求一起退避、一起回來再撞，跟那條 thread 無關的人一起受害。設了上限，名額滿了的**新請求排隊**，不再一起撞牆。
**出廠不限**，行為與沒有這兩格一樣——供應商的配額因端點而異，給數字沒有依據，預設打開的話既有部署會在某一天突然開始排隊。要開的人放進自己的 `--patch <檔>`
（或 `plugin config set live-model --file -`，注意那是整份替換）：

```yaml
- id: live-model
  config:
    maxConcurrentRequests: 8   # 整台 serve 同時最多 8 個模型請求
    maxWaitMs: 60000           # 排隊最多等 60 秒（這是預設值）
```

- **數的是整台 serve 同時在跑的模型請求**：對話、換模型選的別顆、背景子代理指定的模型、標題（含標題跟隨主路由的那一顆）、摘要器生摘要的那一次呼叫都算同一份。
  一次性 CLI、REPL、eval 不建這道閘。
- **排隊是 FIFO，而且排隊的人聽停止鍵**：等待中按了停止，立刻離開隊伍、不送請求、不占名額。**429 之後的退避那段時間不占名額**，重打前重新排隊，
  所以一波一起回來的重試，同時在跑的數量也不超過上限。排隊的時間不算 `retryPolicy` 的重試次數、不寫 `llm/retry`、也不吃 180 秒的首事件逾時。
- **等超過 `maxWaitMs`**（預設 60 秒，沒有量測依據，可改）：這一輪以本機碼 **`LOCAL_CAPACITY`** 失敗，**沒有送請求、不重試**；serve 日誌寫一行，含上限、現在在跑與排隊的數量，以及下一步
  （調高 `maxConcurrentRequests` 或 `maxWaitMs`，或查是哪條 thread 開了大量子代理）。不是每次排隊都寫，只在逾時時寫。web 對這個碼照今天對未知碼的顯示，中文標籤是另一張卡。
- **起動時印一行** `模型請求並行上限：…`（沒設就印「不限」），設了卻不確定有沒有生效看這一行。**起動時讀一次，改了要重啟。**
- **只限同時在跑幾個，不限每分鐘幾次或幾個 token**，也沒有每個使用者一桶：serve 現在沒有使用者身分，等身分上線（[#1428](https://github.com/DemianLi/nexus-agent/issues/1428)／[#1429](https://github.com/DemianLi/nexus-agent/issues/1429)）再另開卡。
- **偏離 dsh（登記）**：dsh 沒有任何跨 session 的模型請求並行閘（它是一個人用自己的 key）；這是多人共用一把 key 才有的產品需求。形狀借的是 dsh 背景工作的准入
  （數量從現況現算、訊息寫上限與下一步、預設不限），排隊是 dsh 沒有的部分，對 dsh 決策紀錄否決過的四種形狀的逐條回答見 `apps/harness/src/request-gate.ts` 的檔頭。

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
`agent-loop` 的 `10` 照 dsh（`maxParallelToolCalls`），最小 1（串行）也同 dsh，**但 1 不是靠 LangGraph 的 `maxConcurrency: 1`**：
它跑完第一顆就靜靜收掉那一步，其餘工具呼叫沒跑也不報錯。上限 1 時 `maxConcurrency` 仍帶 2，串行由獨佔屏障做
（每一顆都當獨佔）；理由與絆索在 `apps/harness/src/settings/agent-loop.ts` 的檔頭。

### 部署方的身分與 persona

系統提示詞最前面那句身分、以及前後各一段，由 `system-prompt` 這一列決定
（[#720](https://github.com/DemianLi/nexus-agent/issues/720)，照 dsh 的 `systemPrompt` 三格）。出貨值是：

```yaml
- id: system-prompt
  config:
    includeHarnessIdentity: true # 最前面那句 "You are an AI agent powered by nexus-agent."
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

### 時間讀數：`time-context`

模型自己沒有時鐘。`time-context` 這一列（[#1625](https://github.com/DemianLi/nexus-agent/issues/1625)，照 dsh 的 `time-context`）在每次 agent
呼叫開頭、`agent-instructions` 的基線之後，追加**一則持久的使用者訊息**，三行：

```text
Time sampled while preparing turn 3, step 1: 2026-10-18T09:15:00+08:00[Asia/Taipei]
Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.
Elapsed since the preceding model-visible message: 15m 0s.
```

- **第二行看這一輪的人話帶不帶時區**（[#1629](https://github.com/DemianLi/nexus-agent/issues/1629)，照 dsh 的 `deriveBrowserTimeZoneContext`）：`run.start` 帶了 `client_time_zone` 的話，唯一的時區寫「Browser time zone for this request: Asia/Taipei. Interpret otherwise-unqualified dates and times in this zone.」，**第一行的時鐘也改用這個時區**；同一輪有不同時區的人話（輪中插話換了時區）寫 `mixed ["America/New_York","Asia/Tokyo"]` 並請模型向使用者確認；都沒帶就是 `unavailable`（舊客戶端、CLI、目標續行）。web 真的送出時區是 [#1630](https://github.com/DemianLi/nexus-agent/issues/1630)，在那之前實際跑出來仍是 `unavailable`。**沒帶時區時**第一行的時區只是顯示用的回退，**不代表使用者在哪個時區**。
- **只進請求尾端，不進系統提示詞**：前綴快取不會因此失效；已經送出的讀數記在日誌上，續接舊會話時原樣回到模型手上，不改寫。
- **同一條 thread 10 分鐘內不重複**（`refreshIntervalMs`，預設 600000）；`0` 是每次呼叫都注入，不是關掉。兩條 thread 各算各的。
- **顯示時區預設是行程的 `TZ`**，載入時解析一次。**容器裡常常是 UTC**，要固定成使用者看得懂的時區，啟動時設 `TZ`，或用 `plugin config set time-context --file <檔>`（檔裡寫 `timeZone: Asia/Taipei`，IANA 名），或在 `--patch` 裡給這一列的 `config`。
- **設定寫錯（不是 IANA 名、間隔不是非負安全整數、多出來的欄位）這一列掉下來**，啟動時印原因，其餘照常；設定只給新的 thread。
- **關掉**：`plugin disable time-context`，或 patch 寫 `- id: time-context` ＋ `disabled: true`。這一列在 `cordis.yml`（CLI 與 serve 共用），所以兩邊一起關：dsh 只有 web-app 掛它、照理只掛 serve，但 serve 專屬層的函式插件上不了樹（`plugin-tree.ts:51-52`），所以我們的 CLI 也掛（偏離登記在套件檔頭第 5 條，撤除條件：serve 層經 Include 上樹後搬到 `cordis.serve.yml`）。
- **每次 invoke 多一個圖節點**（`TimeContextMiddleware.before_agent`），在預設遞迴上限 100 下輪數不變（32 輪，被 floor 吃掉）；**但剛好卡在邊界上**：上限 99 就是 31 輪，再多一個 `beforeAgent` 節點，預設上限也會少一輪。上限壓得很低的部署要自己量。
- **畫面上不會多一則**：讀數是持久訊息、模型看得到，但帶 `source.plugin`，web 的對話畫面不把它當使用者說的話畫出來（同 AGENTS.md 基線）。

### 後台改清單：`plugin` 寫入口與變更紀錄

停用、啟用一列、換一列的設定，不要去編輯檔案，在這台主機上跑：

```bash
pnpm --filter @nexus/harness run plugin -- disable todo
pnpm --filter @nexus/harness run plugin -- enable todo
printf 'maxWords: 3\nmaxBytes: 40\n' | pnpm --filter @nexus/harness run plugin -- config set thread-title --file -
pnpm --filter @nexus/harness run plugin -- config reset thread-title
```

- **新設定只從檔案或標準輸入來**（`--file <路徑|->`），不收命令列參數：命令列會進 shell history 與 `ps`。
  **整份替換，不是深層合併**，跟 patch 檔的 `config` 同一條規則。`config reset` 把那一列的設定恢復成繼承來的值
  （出貨清單或更下面的覆寫給的），**不是**釘在今天的值上：之後出貨清單改了預設值，它會跟著變。
  新值剛好等於繼承值時，照 dsh 的做法把覆寫拿掉，紀錄裡記成 `config-reset`，輸出會講「已記成恢復成繼承值」。
- **寫之前先驗**：id 不存在、設定不合那一列的 schema、關的是必掛的列，一律拒絕，結束碼 1；**什麼都沒有生效**，
  清單不變，但這一次被拒絕會留一筆 `rejected`（見下面「被拒絕與掛不上也進紀錄」）。
  關掉 `sandbox-policy`／`permission-presets` 不會被拒絕（`validateEntries` 沒有這條），但輸出會警告：serve 帶 `--workspace`
  時，之後每條新對話都會建不起來。
- **輸出講的**：紀錄檔的完整路徑、第幾筆、操作者、改了哪些**欄位名**（不印值）、什麼時候生效——`新對話生效`，或
  `待重啟`（啟動時讀一次的那幾列，見上面）。**那份路徑要跟 serve 讀的是同一個 `$NEXUS_AGENT_HOME`**；
  `plugin-snapshot.json` 不在的話輸出會警告（serve 沒開過，或指到別的 home），不擋寫入。
- **要跟 serve 帶同一組 `--patch`**：`plugin` 也收 `--patch <檔>`（可多次）。`--patch` 排在變更紀錄之後，被它蓋住的列，
  寫入口照寫紀錄但回報 `被 --patch 蓋住`（設定的那一類直接拒絕，因為寫了也不會生效）。沒帶同一組，它看不出誰被蓋住。
- **操作者記的是自報**：記的是有效帳號，以及 `sudo` 之前的帳號（讀 `SUDO_USER`，沒有就讀 `LOGNAME`，並標明出處）。
  那是環境變數，不是身分認證；**要能追責，靠主機本身的存取控制**（誰能登入、誰能 `sudo`）。
- **加一列原本不在清單裡的 plugin（`insert`）只能用 `--patch`**，寫入口不做這件事。
- **舊插件一行不改**：清單上的列仍在相容層裡掛，變更紀錄只是清單的來源。
- **函式插件（遷出了哪幾顆見 [`docs/plugin-contract.md`](plugin-contract.md) 的「接進清單」；[#1416](https://github.com/DemianLi/nexus-agent/issues/1416)、[#1458](https://github.com/DemianLi/nexus-agent/issues/1458)）怎麼改都一樣**：停用、啟用、換設定
  照同一個寫入口與同一份變更紀錄，操作者看不出差別。差別只在內部：這一類的列在 Cordis 的樹上，寫入口寫了紀錄之後，
  下一條新對話讀清單時把折出來的 patch 推給樹，樹上那一列卸載或重掛。**不會有任何檔被這條路寫**（`cordis.yml` 與
  home 底下的檔，位元組都不變）；開著的對話手上的工具照舊能叫，只有新對話看到新的。
  三個已知限制：（1）**`cordis.serve.yml` 那一層不經樹**——放在那一層的函式插件掛不上，啟動日誌會指名那一列；今天那一層沒有。
  （2）**插件自己停用自己只在行程裡停著，不改清單**（[#1424](https://github.com/DemianLi/nexus-agent/issues/1424)）：
  不寫檔、不進折出來的清單；紀錄多記一筆只記不折的 `self-disabled`（列 id、模組名，actor 是 `serve`），**同一份宣告**
  在這個行程裡只掛一次、只記一筆，之後的新對話不再重掛。**重啟**，或它的設定／模組名**改了**，才再試一次——
  又自己停用就再記一筆。它在 `plugin-snapshot.json` 裡是 `disabled`，不是「沒掛上」，也不會有 `failed`。
  想讓它回來：改它的設定（`config-set`），或重啟 serve。沒有紀錄檔時行為相同，只是不記那一筆。
  用寫入口 `disable` 之後再 `enable` 回同一份宣告：插件會重掛、再停用一次，但去重鍵相同，所以**不會再記一筆**。
  （3）**閒置逐出（[#1484](https://github.com/DemianLi/nexus-agent/issues/1484)，出廠開著）會讓被撤掉又重建的 thread 拿到「現在」的設定與插件**：
  上面說「開著的對話手上的工具照舊能叫，只有新對話看到新的」，一條 thread 被撤掉之後再開，就是一條新對話——**它重新組裝，吃當下的
  清單、設定與插件版本，不是它上次組出來的那一份**。這等同「重啟 serve 之後再開那條 thread」，語意變了的是：逐出關掉時，一條 thread 在行程
  活著期間一直守著組裝它的那一版；逐出開著（出廠），閒置夠久就會換到新的一版。**要在整段對話裡釘住某一版，設 `idleEvictAfterMs: 0`**（[#1619](https://github.com/DemianLi/nexus-agent/issues/1619) 起出廠開著）。

**紀錄檔的格式**：JSON Lines，一行一筆，`{"v":1,"seq":N,"at":"<ISO>","actor":{…},"op":"disable|enable|config-set|config-reset|patch|rejected|failed|self-disabled",…}`。
`seq` 從 1 連續遞增（`rejected`、`failed`、`self-disabled` 也佔序號）。`config-set` 與 `config-reset` 帶 `before`／`after`（**明文**，連同裡面可能有的秘密，所以檔案是 `0600`、
home 是 `0700`；不要把它貼進 issue 或聊天）。直接 `cat` 就能讀，用 `jq -c .` 更舒服。

**被拒絕、掛不上、自己停用也進紀錄**（`rejected`、`failed`、`self-disabled`）：這三種筆**只記不折**，清單不因它們改變——同一份紀錄有它們與沒有
它們，折出來的清單相同。它們是讓稽核看得到「有人想改什麼、被攔下了」、「哪一列掛不上、歸因到紀錄裡的哪一筆」與「哪一個插件自己停用了自己」，不是讓它們有作用。

| `op` | 誰寫 | 什麼時候 | 帶什麼 |
|---|---|---|---|
| `rejected` | `plugin` 寫入口（`actor` 是主機帳號） | 驗證那一段拒絕了：id 不存在、設定不合 schema、關的是必掛的列、設定被 `--patch` 蓋住 | `requested`（要做的操作：`disable`／`enable`／`config-set`／`config-reset`）、`id`、`reason`（驗證器的原文） |
| `failed` | serve（`actor` 是 `{"kind":"serve","effective":"<帳號>"}`） | 某一列掛不上，**而那一列在紀錄裡有被接受的改動**；或它依賴的列被關掉、它剛掉在 `requires`（見下面「依賴的列被關掉」） | `id`、`triggerSeq`（**歸因**到的那一筆的 `seq`，見下面「`triggerSeq` 是歸因，不是因果」）、`stage`（`module`／`config`／`apply`／`requires`）、`reason` |
| `self-disabled` | serve（`actor` 同 `failed`：沿用 `serve`，「是插件自己停的」由 `op` 承載；#1424） | 樹上的函式插件在 `apply` 裡自己 `ctx.fiber.dispose()`（Loader 處理自我停用的那一格）；同一個行程裡同一列同一份宣告只記一次，重啟或宣告（模組名、設定）改了才會再記 | `id`、`name`（模組名）。**不帶原因**：插件沒有講原因的管道，要查的是那個插件自己的日誌 |

- **`rejected` 不帶要寫入的值**。`reason` 是驗證器原文，可能引到值的一部分；檔案本來就是 `0600`、前後值本來就是明文，
  所以沒有新增暴露面，但**不要把它貼進 issue 或聊天**。CLI 與伺服器日誌只印「記成第幾筆」，不印原因、不印值。
- **不是每一次沒寫都算拒絕**：參數解析錯誤、`--file` 讀不到或不是一張表、「已經是那個狀態」（沒有改變任何東西）都沒有形成一筆
  變更，紀錄不動。清單讀不了、紀錄壞了也不記（那是別的錯，不在驗證那一段）。
- **`failed` 只記紀錄造成的**：那一列在紀錄裡沒有任何改動指到它（出貨設定本身就掛不上、只被 `--patch` 改過），照舊只進伺服器日誌
  與快照——**除了下一條**。歸因到**最後一筆**指到它的、被接受的紀錄，包括遷移進來的 `patch`；一筆 `insert` 讓好幾列掛不上時，每一列各記一筆，
  帶同一個 `triggerSeq`。**同一次歸因只記一次**（鍵是列 id 加 `triggerSeq`，跨重啟、跨多個 serve 都不重複）；那一列又被改一次又掛
  不上，就是新的 `triggerSeq`、再記一筆。
- **依賴的列被關掉**（#1423）：A 依賴 B，用寫入口關掉 B，A 自己在紀錄裡沒有任何改動，掉在 `requires`。這種掉法也記一筆 `failed`，
  `triggerSeq` 歸因到**當時紀錄裡最新一筆被接受的**（`rejected`、`failed`、`self-disabled` 不算）。四件事要同時成立：（1）serve 跑著的期間
  （重讀或 thread 組裝；啟動試組不記）；（2）**新掉**：上一次組裝或重讀時它還掛著、這一次掉了（A 掛回來之後再掉算新的，
  再記一筆）；（3）`stage` 是 `requires`——`apply` 會因為每條 thread 的工作區不同而這一條掛上、那一條掉，不能當成紀錄造成的；
  （4）這一列自己沒有被接受的改動（有的話照上一條歸因到它自己那一筆）。
  已知的邊角：B 自己在某條 thread 因為工作區而 `apply` 失敗、連帶 A 掉在 `requires`，A 會被歸因到當時最新的那一筆，而那一筆跟
  這次掉落無關——同樣是歸因，不是因果。
- **`triggerSeq` 是歸因，不是因果**：它是一條規則——掉的那一刻，紀錄裡最後一筆碰到這一列、被接受的紀錄——**不保證是這次掛不上
  的原因**。讀稽核的人不要把責任算到那一筆的操作者頭上。兩個會指到無關那一筆的例子：（1）A 很久以前被改過設定（seq 2），後來因為
  B 被停用，A 掉在 `requires`，歸因指到 seq 2，真正的原因是停用 B 的那一筆；（2）出貨版本升級之後才掉的列（新版的設定格式不收舊
  的值），歸因指到它最後一次被改的那一筆舊紀錄。欄位名叫 `triggerSeq` 是因為格式只增不改，改名的成本以後只會更高；讀的時候請當歸因讀。
- **三個發現點都算**：啟動試組、每條 thread 組裝、讀清單時新掉的。必掛的列因紀錄掉了、serve 起不來或那條 thread 建不起來之前，
  那一筆已經寫進去。**不擋 thread**：等鎖最多 2 秒（跟寫入口的 30 秒不同，這裡持鎖只是追加一行），home 唯讀或等不到鎖只在日誌
  記一句「沒寫成」（同一件事只講一次），下一次發現時再補。紀錄檔不存在時什麼都不做，也不會建檔。
- **掛不上的原因原文只進紀錄**。伺服器日誌既有的那幾行（`[清單] 這一列沒掛上…`）照舊，不因為這一筆多印原因。

**換回舊版程式**：紀錄的格式是 strict 的，舊版（`rejected`／`failed` 之前，**以及 #1424 之前、還不認得 `self-disabled` 的版本**）讀到不認得的 `op` 會把它當成壞掉的檔、serve 起不來，
訊息指名第幾行。要換回舊版，**先照下面「紀錄壞了怎麼救」的三步處理**，或不換回。換回舊版本來就要排程重啟，寫清楚就好；這一版不讓
讀端略過不認得的筆（略過就是靜靜漏掉稽核）。

**代價要先想清楚**：`rejected`／`failed`／`self-disabled` 跟被接受的改動是**交錯排**的，而 `seq` 必須連續，所以「搬出去」不是只搬那幾行——
**第一筆 `rejected`／`failed`／`self-disabled` 之後的所有行都要搬走**，其中被接受的改動也一起丟掉，清單會回到那一刻。要保留那些改動，換回舊版之後
用舊版的 `plugin` 重做一遍（它們不會自己回來）。動手前先備份整個檔，並用 `jq -c '[.seq,.op,.id]' plugin-journal.jsonl` 看第一筆
`rejected`／`failed`／`self-disabled` 在哪一行、後面有哪些被接受的改動會被丟掉。

**怎麼寫的**：拿跨行程鎖（`plugin-journal.jsonl.lock`）→ 在鎖裡驗證 → 整行 append → `fsync` → 回報。讀的一方不拿鎖，
最後一行沒寫完就略過；寫的一方拿到鎖後發現尾巴不完整，會截掉並在 stderr 講一聲。**中間某一行壞了、或 `seq` 斷號**：
serve 起不來，訊息指名壞在第幾行；已經在跑的 serve 只有重讀的那條對話失敗，其他不受影響。

**第一次啟動的遷移**：serve 起動時（或你第一次跑 `plugin`），如果 home 有舊的 `cordis.patch.yml` 而紀錄檔還沒有，
它的每條 patch 變成一筆 `patch` 紀錄（操作者記「遷移」，帶來源路徑與全文的 SHA-256；`insert` 的相對模組路徑換成絕對路徑），
舊檔改名成 `cordis.patch.yml.migrated-<時間>`（`0600`）。這是遷移的界線：**紀錄檔存在之後**，舊檔再出現一律警告一次、不讀、
不再遷（誰都能放一個檔進 home，自動遷移會讓「誰改的」全記成「遷移」）。要保留那個檔的內容，用 `plugin` 重做，或改放進 `--patch`。
**搬 home 會讓遷移進來的絕對 `insert` 路徑指到舊位置**，搬完要核對。一次性的 CLI（`pnpm … run cli`）沒有舊檔要遷時什麼都不寫；
紀錄檔由 serve 或 `plugin` 第一次建。

**紀錄壞了怎麼救**（沒有救援指令，三步手動，**這一步本身不進紀錄**）：

1. 先備份整個檔：`cp plugin-journal.jsonl plugin-journal.jsonl.bak-$(date +%s)`。
2. 看啟動失敗訊息指的第幾行，把**那一行之後**的內容挪到別的檔（或確認那幾行可以丟）。
3. 剩下的前半段 `seq` 本來就連續，起得來；之後要補回挪走的改動，用 `plugin` 重做，讓它們重新進紀錄。

**沒走變更紀錄的改動看得到**：`--patch` 蓋住的列，在 `plugin-snapshot.json` 裡標 `unaudited: true`，serve 日誌第一次看到時記一行
`[清單] 有未稽核的覆蓋層在作用`（只有檔名與列，不印值）。`--dump-config` 照舊印疊完的樣子，**不遷移、不寫任何檔**。

### 看這台機器上疊出來的是什麼

```bash
pnpm --filter @nexus/harness run cli -- --dump-config
```

`serve` 也收同一個旗標。它印出**啟動會掛的那份清單**（不含上面說的那顆由程式碼掛的；`serve` 的包含專屬那一層），而且一個 plugin 都不載、不開
server、不綁 port：

```yaml
# == /path/to/apps/harness/cordis.yml
- id: echo
  name: '@nexus/plugin-echo'
# == /path/to/apps/harness/cordis.yml, patched by /home/you/.nexus-agent/plugin-journal.jsonl
- id: todo
  name: '@nexus/plugin-todo'
  disabled: true
```

每一段前面的 `# ==` 註解標明那幾列來自哪個檔、被哪幾層改過，而整份輸出仍然是合法的 YAML
（讀得回來）。指到不存在 `id` 的 patch 會連同它那一層的標籤報到 stderr——**那是「我的 patch
為什麼沒生效」最快的答案**。

輸出的位元組不是約定，不要拿它去做程式化的比對：dsh 對自己那份 dump 也明講了同一件事。

**覆寫檔壞了的時候**（權限被開到別人也寫得動、YAML 寫壞、變更紀錄某一行壞了），`--dump-config` 自己也印不出來——它一定會去讀
變更紀錄與 `--patch` 的檔，讀不過就拋，訊息指名壞的是哪個檔、哪一行。這時候用：

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
覆寫（變更紀錄裡的 `config-set`、`patch` 紀錄，與 `--patch` 檔）的格式。編輯器與 agent 拿它就能事先知道某一列收哪些欄位、預設值是多少，
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

### 每晚真模型冒煙回歸（#436）

`eval:compare` 要人手動跑；端點改了、模型下架了，沒有人跑就看不到。`.github/workflows/smoke.yml` 補這個洞：

- **觸發**：手動（Actions 頁面 → Smoke（真模型））、每晚 18:17 UTC、push 到 `main`。**不在合併請求上跑**（額度；照 dsh 文件的收斂退法）。**不設成必過**，不在 `gate` 的路徑上。
- **跑什麼**：真 `runServe --live` 打真的 NVIDIA 端點，三個案例——讀檔再寫檔（含逐字串流）、多輪、串流中途取消。驗證從外面重讀檔案、哨兵檔逐位元組比對，不看 agent 自己怎麼說。
- **請求上限 20**：`live-model` 的 `baseUrl` 換成本機計數代理，在出口數；第 21 個不轉出去、整組判失敗。代理的計數會跟會話日誌對帳（`model/start`＋標題請求＋重試），對不上就是量具壞了。
- **金鑰**：repo secret `NVIDIA_API_KEY`（只有 repo 管理者能放）。流程檔的預檢步驟沒設就 `exit 1`；冒煙缺金鑰時**直接拋、不跳過**，免得「全部跳過」被當成通過。
- **過程違反量測**（藍圖規則 5／T7-08）：外部檢查判成功的案例，另拿會話日誌對 `src/smoke/violations.ts` 事先寫好的清單。**只報數、不判失敗**：摘要裡寫「判成功 N 件，其中過程違反 M 件」。
- **本機跑**：`NVIDIA_API_KEY=… pnpm --filter @nexus/harness run smoke`（不要把金鑰寫進指令列歷史；從 `.env` 讀進環境變數）。
- **失敗通知**：GitHub 預設通知最後改過這份 cron 的人，沒有另外接。排程只在預設分支跑，六十天沒有動靜會被 GitHub 自動停掉。

`eval:compare` 與 `eval:survey` 每次執行都會逐筆寫進一份結果檔，預設在
`apps/harness/eval-results/`（不進版控），`--out <目錄>` 可以改。檔案是 JSON Lines：第一行記
這一輪的條件（commit 與工作樹有沒有未提交的改動、題庫版本、評分程式版本、取樣溫度與 topP、
迴圈與時鐘上限），之後每次執行一行（含評分器看到的原始觀測），最後一行是 footer；
**沒有 footer 的檔是沒跑完的**。比較兩次跑的數字之前，先看兩份檔的題庫版本與評分程式版本是不是同一個。
格式與讀檔重算在 [`apps/harness/src/eval/result-file.ts`](../apps/harness/src/eval/result-file.ts)。

報表上每個模型都有一行**「這題成功」**，它不是「工具成功率」那一欄：有可判的三欄（工具成功率、
參數正確性、回覆提到）全是 1.00，而且多叫次數沒超過那一題在資料集裡宣告的容許值
（`maxExtraToolCalls`，沒宣告就是 0）才算。它底下一行是**地板**：三個不需要模型的平凡 agent
（什麼都不做、固定亂吐、隨機合法動作，`src/eval/floor.ts`）在同一份題目上的成功題數，正常是全
`0/題數`。不是 0 就代表評分器放寬了，這一輪的「這題成功」不可信。只想看地板（零憑證、不連外）：

```bash
pnpm --filter @nexus/harness run eval:compare --floor-only
```

`eval:compare` 與 `eval:survey` 的報表上，「這題成功」「工具成功率」「參數正確性」「回覆提到」四欄底下各有一行**區間**
（survey 全部與難題各一行），方法與 n 都印在行裡，並配著它自己的中心值（題均）：以題目為單位重抽的百分位 bootstrap（每題先把自己的執行取平均，再把題當獨立單位抽 2000
次，取 2.5% 與 97.5%；種子固定，同一份資料永遠同一個區間）。同題重跑的變異在「每題先取平均」那
一步收掉，不會單獨撐大區間；七題的區間很寬，這是對的。同一行也印**一題 = X 個百分點**（按該欄
判得動的題數算，取樣不止一次時另印一次執行等於幾個百分點）。括號裡的「範圍」是最小到最大，**不是
誤差棒**。少於兩題抽不出區間，所有題目同值時區間會塌成一點（報表會明說，那不代表沒有不確定度）。
最後一行 **token 合計**把評到分的與失敗的執行分開列：失敗的（被上限切掉、被端點拒絕）也花了 token，
但失敗那次被中止的最後一次呼叫沒有結束事件、量不到，所以失敗那一欄是下限。

CI 那條（`pnpm --filter @nexus/harness exec vitest run src/eval`）同時擋兩個方向：平凡 agent 不准
被判成功（`floor.test.ts`），每題的標準解必須被判成功（`eval.test.ts`）。

這七題上的分數**當上限、不當實力**（設定與題目是同一批挑的），要拿它挑改動就得在新題上驗過；
LLM 評審與使用者模擬器的準入規則、暫緩項與重開條件見
[`apps/harness/docs/eval-measurement.md`](../apps/harness/docs/eval-measurement.md)。

## 點名子代理

使用者可以在一句話裡點名派哪一個子代理（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項，**dsh 沒有**：dsh 派子代理的只有模型，沒有使用者派工的入口；Claude Code 允許使用者 `@` 子代理，這是 demian 2026-10-08 的指示）。

- **清單**：`subagent.list` 回 `task` 實際收的那份——`general-purpose` 在前，其餘依註冊順序，各帶說明。手搭的組裝沒有清單時回 `not_supported`，web 據此藏起 `@` 的入口。
- **送出**：`run.start` 的選填 `params.mention: { kind: 'subagent', name }`。形狀不對、名字不在清單上都回 `invalid_argument`，那句話不進佇列（排在收下附件之前，不會用掉收據）。
- **對模型的作用**：點名**沒有新的執行路徑**，只是在使用者那句話之後多接一個文字區塊（「使用者點名要你把這句話交給子代理 "名字" 處理：請用委派工具…」，字在 `@nexus/core` 的 `subagent-mention.ts`），派不派、怎麼派仍走 `task`／`subagent` 工具與它們的所有規則（核准、模型選擇、深度）。模型可以不聽，所以這是「請求」不是「保證」；真模型的對照見該 PR 內文。
- **日誌**：`turn/start`（`kind: 'message'`）與佇列項各多一格選填 `mention`，輪中插話則留在 `user/message` 的內容區塊裡。**格式 42，不標 `ignorable`**——舊 runtime 略過它，排著的項目被折回來重跑時點名就悄悄不見了。
- **線上**：排著的件（`WireQueuedInput.mention`）、領走時的 `claimed`／`claimedNextStep`、歷史重播的人話（`HumanEntry.mention`）都帶它；`text` 不含點名也不含提示區塊（歷史把提示區塊剝掉，從它讀回點名）。
- **會被看到提示區塊的地方**：送進模型的訊息、摘要器的輸入（摘要裡可能帶到點名的字，沒有處理）。泡泡、佇列、標題（讀的是 `turn/start.text`）、`thread.search` 的全文（跟歷史同一個判準剝掉提示區塊）不受影響：搜提示裡的字（「子代理」「委派工具」）不會命中被點名的話，搜使用者自己打的字照常命中。

## 瀏覽器時區（`client_time_zone`）

`run.start` 可以帶一格選填的 `client_time_zone`（[#1629](https://github.com/DemianLi/nexus-agent/issues/1629)，**照 dsh**：`session.prompt` 的 `clientTimeZone`，`packages/api/session-controller/src/index.ts:467-482`）。模型要把「明天下午三點」這種沒指名時區的時間按使用者的時區解讀，得知道使用者在哪個時區；瀏覽器自己知道（`Intl.DateTimeFormat().resolvedOptions().timeZone`），伺服器不知道（容器常常是 UTC）。

- **協定**：`params.client_time_zone`，`UTC` 或 IANA 的 `Area/Location` 時區名（例如 `Asia/Taipei`、`America/Argentina/Buenos_Aires`），前後不能有空白。不合格式、這個執行期的 `Intl` 不認得、或不是字串，回 `invalid_argument`，訊息點名 `client_time_zone`，**這一句不進佇列**（驗證排在查重送之前，壞的時區不會被「重送」吞掉）。**省略＝維持現狀**，舊客戶端不受影響；舊 server 會略過這一格。wire client 的 `runStart(thread, text, { clientTimeZone })` 已接上。
- **正規化**：伺服器記下的是 `Intl` 回報的正規名，別名會收成同一個值。**讀日誌時照 dsh 逐字要求記著的名字等於這個執行期的正規名**，否則那一輪的 pre-step 拋錯。不同 Node／ICU 版本的正規名不盡相同（Node 25.9 把 `Asia/Kolkata` 收成 `Asia/Calcutta`），這個風險另開 [#1733](https://github.com/DemianLi/nexus-agent/issues/1733) 等 demian 決定；發版產物升 Node 之前要先有結論。
- **記在哪**：人話的來源上，不進 thread 設定（那會是整條 thread 共用的一個值，同一條 thread 換了時區就說謊）。三個位置同 `request_id`：排著時 `inbox/spliced` 裡那一件的 `source.clientTimeZone`、開了一輪之後的 `turn/start`（`kind: 'message'`）、輪中插話被領走時 `user/message` 的 `source.clientTimeZone`。**格式 49，不標 `ignorable`**（既有事件上多的選填欄位，沒有 `ignorable` 可標）。**一台 48 的 runtime 讀不了 49 的檔**（`SessionFormatUnsupportedError`），而且續接時 header 會被改寫成 49：發版後退回前一版，被新版碰過的 thread 會打不開。沒帶 `client_time_zone` 的送出，日誌與以前位元組相同；48 以前的檔沒有這一格，等於沒帶，不補寫。
- **誰讀**：`@nexus/plugin-time-context`，見上面「時間讀數」。**子代理不繼承**：子代理的日誌沒有 `turn/start`，它那一則讀數的第二行是 `unavailable`。dsh 派子代理時同樣沒帶時區（`packages/subagent/subagent/src/manager.ts:464` 給的是 `{ kind: 'user' }`）；dsh 有的是人直接對子代理說話時 `subagent.prompt` 帶 `clientTimeZone`。`subagent.send` 帶時區另開 [#1734](https://github.com/DemianLi/nexus-agent/issues/1734)，不在這張。
- **不在這裡**：使用者在設定裡指定時區（覆蓋瀏覽器回報的）不在這張卡；web 送出時區是 [#1630](https://github.com/DemianLi/nexus-agent/issues/1630)。

## 重送同一句話（請求編號）

`run.start` 可以帶一格選填的 `request_id`（[#1335](https://github.com/DemianLi/nexus-agent/issues/1335)，**照 dsh**：`session.prompt` 的 `requestId`，`packages/api/session-controller/src/commands.ts:330`）。請求到了伺服器、回應卻斷在半路時，客戶端分不出「沒送到」還是「送到了、沒收到回條」，使用者會再按一次送出；沒有編號的話伺服器分不出是同一句，模型就看到兩次同樣的話。

- **協定**：`params.request_id`，非空字串、至多 200 個字元（`REQUEST_ID_MAX_LENGTH`），其餘回 `invalid_argument`。**省略＝維持現狀**（每次都排一次），舊客戶端不受影響；舊 server 會略過這一格。客戶端每句話送出時產生一個新編號（UUID 即可），**同一句話重送沿用同一個編號**。wire client 的 `runStart(thread, text, { requestId })` 已接上。
- **回應**：第一次與重送都是 `{ run_id }`。**重送回的是原本那一件的 `run_id`**，客戶端據它對上自己已經畫出來的那一句，不必多畫一則。**偏離 dsh**（登記）：dsh 回 `{ accepted: true }`；我們的 `run_id` 兼作送出佇列的項目 id，畫面靠它對人，`{ accepted: true }` 表達不出來。
- **認得的範圍**：這條 thread 上三個階段都認得——還排著（收件匣那一件的 `source.requestId`）、已經領走開了一輪（`turn/start` 的 `requestId`＋`runId`）、輪中插話被領走（`user/message` 的 `source.requestId`），重啟之後從日誌折回來照樣認得。**排著的那一句被使用者刪掉之後**，同一個編號再送就是新的一句（dsh 同）。
- **只比編號、不比內容**（同 dsh）：同編號不同文字的第二次也回原本那一件，新的字不進佇列。要把內容也綁進去（同編號不同內容回錯）是 OpenBitFun 的做法、不是 dsh 的；除非能說出「同編號不同內容」實際怎麼發生，否則不加。
- **查編號排在一切會用掉東西的檢查之前**：重送帶的是同一批附件收據，第一次就用掉了，晚一步查的話重送會先撞上「收據已用過」而不是被認出來。同一個編號同時到兩次（收第一次在等附件）時，第二個等第一個落定再判。
- **日誌**：`inbox/spliced` 的那一件、`turn/start`（`kind: 'message'`）、`user/message` 的 `source` 各多選填的 `requestId`（`turn/start` 另有 `runId`）。**格式 48，不標 `ignorable`**——舊 runtime 略過它，重啟之後重送同一個編號就會排第二次，沒有任何東西報錯。沒帶 `request_id` 的送出，日誌與以前位元組相同。
- **`slash.run` 沒有同批**：dsh 也只有 `session.prompt` 帶 `requestId`，命令沒有；而且命令的回應是執行結果（`command/done` 的文字），不是一個可以原樣回的 `run_id`，要認重送就得另外把結果存下來。命令有自己的擋法（一次只跑一個、`run` 跑著或停在核准點就拒），重送若撞上這些會得到明確的錯誤；**但命令已經跑完、thread 閒著時重送，命令會再執行一次**——這是已知缺口，今天沒有編號可認。
- **不在這裡**：`input.respond` 重送「已成功但回應丟了」的核准，客戶端分不出是「已經答過」還是「根本沒有這顆」，這是另一個問題（卡 [#1335](https://github.com/DemianLi/nexus-agent/issues/1335) 的「不在這張卡」）。

