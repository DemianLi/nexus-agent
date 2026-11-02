# 配套入口（運行時不變量）要保留還是對齊 dsh：決策紀錄（2026-10-03）

**狀態**：第一刀**已拍板**（demian，2026-10-03，對話中）：**拿掉 12 個沒有任何檢查的空配套入口，其餘 8 個真的在檢查的先留著、再觀察。** 第二刀（那 8 個要不要留）**尚未決定**，觀察的條件見第七節（那一節是提議，沒有拍板）。

**事由**：dsh 在 2026-09-30 的提交 `f028f25667d`（`refactor: remove runtime invariant plugins`）把整套運行時不變量機制拿掉。nexus 的對應機制（`registry.invariants`、20 個配套入口、`package-invariants` 閘門）當初的唯一理由是「移植 dsh 的註冊表」（[#101](https://github.com/DemianLi/nexus-agent/issues/101)），這個依據在 dsh 那側已經不存在。來龍去脈見 [`dsh-citation-drift-2026-10-03.md`](dsh-citation-drift-2026-10-03.md) 第七節 (1)。

## 一、dsh 這一側的事實

- **移除了什麼**（`f028f25667d` 的提交訊息與升級指南 `docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md`）：`@deepseek-ai/dsh-invariants`、`ctx.invariants`、`InvariantRegistry`／`InvariantInstaller`／`InvariantFailure`／`InvariantError`、每個套件的 `./invariant` 子路徑、invariant 閘門與 Vitest 設定、scoped-event resolver 產生器，以及四個發射器上帶 `code: 'INVARIANT'` 的「聽者失敗就重拋」路徑（改成包住並記錄）。
- **理由沒有被明講。** 升級指南只寫怎麼遷移；唯一的行為指引是「依賴重拋的外掛要改走自己的通道」。被封存的兩份筆記留下**拿掉之前**的痛點：(a) 一度有 **209 個「有解釋的空殼」** 配套入口，每個都帶一個檔案、一個公開匯出、一條發布設定；(b) `dsh-host-webserver` 的配套入口註冊再撤銷合成路由、再重做一次同樣的操作來偵測殘留，探針沒有獨立的觀察。這些是前因，不是官方給的理由。
- **dsh 本來就沒把它放在產品路徑上。** 9/26 盤點（[`seven-layer-inventory-2026-09-26.md`](seven-layer-inventory-2026-09-26.md) O-09）：dsh 只在 `sdk-minimal` 出廠 `invariants` ＋四顆 `*/invariant`，`base` 與其他 profile 都不掛。
- **移除之後 dsh 怎麼處理跨筆關係**：HEAD 上其餘談到 invariant 的文件沒有任何註冊表的殘留；`docs/persistence-changes/historical-formats/v3.md` 寫的是「外部外掛酬載、實體範圍編碼與執行期關係**需要各自 owner 的驗證器**」，拒絕類用 `ctx.tools.guard()`。也就是歸各自的 owner，不是一張中央表。

## 二、nexus 這一側的事實

### 規模

| 項目 | 檔案 | 行數 |
|---|---|---|
| 20 個配套入口（`packages/*/src/invariant.ts`） | 20 | 1,655 |
| 機制與閘門：`invariants.ts`、`package-invariants.ts`、`verify-package-invariants.ts` | 3 | 829 |
| 測試（檔名含 `invariant`） | 12 | 2,708 |
| 夾具（`cli-invariant-violation.*`） | 2 | 51 |

**其中 12 個配套入口（共 666 行）一處 `fail(` 都沒有**：`@nexus/wire`、`plugin-telemetry-otel`、`plugin-system-prompt`、`plugin-submit-record`、`plugin-skills`、`plugin-quickjs`、`plugin-memory`、`plugin-mcp`、`plugin-feedback`、`plugin-echo`、`plugin-ask-user`、`plugin-agent-instructions`。這 12 個在程式碼裡只被兩處引用：`apps/harness/cordis.yml` 的條目，與 `apps/harness/src/invariant-companions.test.ts` 的手寫表。它們現在是「帶說明的空殼」（閘門要求空 installer 帶 `NO_RUNTIME_INVARIANT_MARKER` 說明），正是 dsh 筆記裡那種東西，[#107](https://github.com/DemianLi/nexus-agent/issues/107) 當時也承認八個是空 installer、「買到的只有包名歸屬」。

### 真的在檢查的 8 個（共 34 處 `fail(`）

| 套件 | `fail(` | 檢的是什麼 | 類型 |
|---|---|---|---|
| `@nexus/core` | 6 | `turn/start` 來時上一輪還開著、關了沒開著的輪、`interrupt/raised` 落在輪外、`model/end` 沒有開著的 `model/start`、`tool/result` 沒有未配對的 `tool/call`、`inbox/spliced` 不合規 | 跨筆關係 |
| `plugin-present` | 8 | `deliverables/presented` 的 `files` 形狀（4 條），以及它對應的 `tool/call` 是否存在、有無 `tool/result`、結果是否錯誤、是否已交付過（4 條） | 4 單筆形狀＋4 跨筆關係 |
| `plugin-todo` | 6 | `todo/write` 的欄位形狀（5 條）、落在輪外（1 條） | 5 單筆形狀＋1 跨筆關係 |
| `plugin-goal` | 5 | 耐久 goal 串是否被破壞、輪次沒有可重建的目標、續行文字不是這個套件算出來的 | 跨筆關係 |
| `plugin-workspace-changes` | 3 | 前面沒有 `turn/start`、那一輪沒有任何 `tool/result`、資料是空的 | 2 跨筆關係＋1 單筆形狀 |
| `plugin-commands` | 3 | `command/run` 重複用 `commandId`、來時還有未落定的、`command/done` 對不上 | 跨筆關係 |
| `plugin-plan-mode` | 2 | `plan/mode` 的 `active` 值、與 `/plan` 命令的對應 | 單筆形狀為主 |
| `plugin-sandbox-policy` | 1 | `sandbox/mode` 帶了不認得的 mode（[#699](https://github.com/DemianLi/nexus-agent/issues/699)） | 單筆形狀 |

分類是依 `fail(` 的訊息判的，沒有逐條讀實作；goal 的 5 處裡有 2 處訊息是多行樣板，沒有逐字抽出。

### 違規往哪裡去

- CLI：`[不變量] <訊息>` 印到終端（`apps/harness/src/cli.ts:996`）。
- serve／web：走 runner 預設的 `console.error`，進伺服器日誌（[#107](https://github.com/DemianLi/nexus-agent/issues/107) 的結論）。
- 兩條都是**事後觀察，不能否決**（日誌先寫入才發布給觀察者，[#101](https://github.com/DemianLi/nexus-agent/issues/101) 第 2 點）；也**沒有任何計數**，違規出現過幾次、沒有地方可查。

### 閘門怎麼進 CI

`verify-package-invariants` 只在 `package.json` 的 scripts 裡，`.github/workflows/ci.yml` 與 `plan_ci.py` 都沒有 `invariant` 這個字。但 CI 跑 harness 測試，`apps/harness/src/package-invariants.test.ts` 的「對著真的 repo」那組會對真實的樹跑閘門，而且**把 owner 的名單與數目寫死成二十個**（第 25、129、137 行）。所以閘門是**透過測試**進 CI 的。

閘門目前有兩條與這次決定直接衝突的規則：(a) `packages/*` 底下每一個有 `package.json` 的套件都是 owner，沒有 `src/invariant.ts` 就是違規、不是被跳過（`package-invariants.ts` 的 `packageInvariantOwners` 刻意不看檔案在不在）；(b) 空 installer 必須帶說明標記，否則違規。

### 歷史上的證據

- **沒有找到「不變量在實跑中抓到真問題」的紀錄。** 搜尋範圍：issue 的標題、內文與留言（四組關鍵字）、`.docs/`、記憶檔。這是否定性結論，不能當作「沒抓到過」的證明。
- **[#668](https://github.com/DemianLi/nexus-agent/issues/668)（真實事故，但是機制自己的）：** serve 漏接 `attachInvariants`，web 每一條 thread 的不變量檢查整個消失，CLI 看起來照常，沒有任何東西變紅；後來靠加測試收回。代價是這套機制需要自己的接線測試。
- **[#721](https://github.com/DemianLi/nexus-agent/issues/721)（機制反過來綁住功能）：** 續接時照 dsh 補寫當掉那一輪的收尾，會撞上 core 配對不變量在 `session/end-seed` 的重設；卡上寫明「還沒開始」那條偏離的理由就是我們的配對不變量（dsh 對合成那顆明文放行）。
- **[#699](https://github.com/DemianLi/nexus-agent/issues/699)：** 起因是 jsonl store 讀回時只驗 `type`／`time`／`seq`、酬載原樣轉型，認不得的 `sandbox/mode` 一路流進控制器。後來用 `sandbox-policy` 的配套入口去報它。

## 三、選項

| | A. 全部對齊（整套拿掉） | B. 全部保留（登記為偏離） | **C. 兩刀（採用）** |
|---|---|---|---|
| 做法 | 移除機制、20 個配套入口、閘門、接線與測試 | 只更新檔頭「照 dsh」的說法 | 先拿掉 12 個空殼並翻面閘門，再決定那 8 個 |
| 規模 | 約 5,200 行，外加 9 個把 `registry.invariants` 當探針的測試／夾具與接線 | 幾處註解 | 第一刀約 666 行配套入口加閘門翻面與 5 個寫死數字的測試 |
| 損失 | 8 個真檢查全沒了，#668 那條接線防線要換一個載體 | 沒有，但留著 dsh 已丟掉的東西 | 第一刀沒有偵測能力的損失 |
| 對照規則 | 最貼近「以 dsh 為標準」 | 要自己立理由：AGENTS.md 的偏離條款是為「表達不出來」寫的，這裡是「dsh 已不做」 | 第一刀同時符合 dsh 的簡化筆記（2026-08-28）與它最後的移除 |

## 四、決定與理由

**採用 C 的第一刀：拿掉 12 個空殼配套入口，閘門的兩條規則翻面。**

- 這 12 個沒有任何檢查，拿掉不損失任何偵測能力；它們存在只為了滿足「每個套件都要有」那條規則。
- dsh 在移除整套之前就已經判定這類東西不該存在（`2026-08-28-omit-unneeded-invariant-companions`：沒有獨立觀察就不要發布配套入口），nexus 自己在 #107 也承認過。
- 這一刀是**對齊**，不是偏離，不需要登記偏離條目。
- 第二刀不在這次決定內：那 8 個真檢查有具體的偵測內容，而 dsh 沒有公開取代它們的做法，貿然拿掉就是在沒有替代品的情況下失去偵測。

**第一刀完成後，剩下的 8 個要在 PR 內文與 `packages/nexus-core/src/invariants.ts` 檔頭寫明：** dsh 已於 `f028f25667d` 整套移除，這 8 個是**暫時保留、觀察中**，見本文第七節。這不是「基礎建設表達不出來」的偏離，是刻意暫留，要照實寫，不要套用偏離條款的措辭。

## 五、第一刀範圍

### 要刪

- 12 個 `packages/<名>/src/invariant.ts`（清單見第二節），以及各自 `package.json` 的 `exports["./invariant"]`。
- `apps/harness/cordis.yml` 的 12 列（20 列的區間在第 569–607 行）。

### 要改

- **閘門（`apps/harness/src/package-invariants.ts`）兩條規則翻面：**
  1. 沒有 `src/invariant.ts` 的套件**不再是違規**；owner 改成「有 `src/invariant.ts` 或有 `exports["./invariant"]` 的套件」，且兩者要同時有或同時沒有。
  2. **空 installer 本身變成違規**（原本是「空 installer 沒說明才違規」）。
  
  這條翻面是第一刀的驗收句，不能只刪規則：翻面後，新增一個空殼的 `invariant.ts` 要讓閘門變紅。
- **寫死「二十」的地方：**
  - `apps/harness/src/package-invariants.test.ts`：第 25 行的名單、第 129 與 137 行；以及 143–146 行「沒有 `src/invariant.ts` 的 package 是違規」、254–272 行「空 installer 沒說明」那幾條測試。
  - `apps/harness/src/invariant-companions.test.ts`：手寫表、第 179、195 行，以及第 210 行「十二個空 installer 一個檢查都不裝」那條（拿掉後不再成立）。
  - `apps/harness/src/invariant-paths.test.ts:140`。
  - `apps/harness/src/cli.test.ts:149`（預設清單的組成，標題寫死「二十個配套入口」）與 `:256`。
  - `apps/harness/src/plugin-config.test.ts:116`、`:132`、`:178`，以及 `apps/harness/src/plugin-config.ts:654` 的註解。
- **決策散文：** `apps/harness/cordis.yml` 第 16 行與第 542–562 行（#107 拍板「二十個全進」與「十二個是空 installer」那一整段）；`packages/nexus-core/src/invariants.ts:13`（「沒有可觀察的事件……配套入口就是一個空 installer 加一句說明」，這個設計前提要改成「不必發布配套入口」）；`apps/harness/src/package-invariants.ts` 檔頭第 8–9 行（「加第十個 package 的人會被擋下來」這個存在理由不再成立，要重寫）。

### 不動

- `@nexus/core` 與另外 7 個真檢查的配套入口。
- `registry.invariants` 服務、`createInvariantRunner`、`attachInvariants` 與 CLI／serve／wire-handler 的接線，以及 #668 那組接線測試。
- `.docs/package-coupling-audit-2026-09-26.md` 等已註明日期的歷史稽核檔（它們記錄的是當時的樹）。

### 風險與副作用

- **新增套件的人不再被閘門擋下來**，也就是原本「加第十個 package 的人會被擋下來」那個目的消失。這是接受的代價，dsh 做了同樣的取捨。
- 預設清單少 12 個條目、啟動時少 12 次 `apply`。
- 動工時要**全文掃舊說法**（`二十個`、`十二個空`、`空 installer`、`九個配套入口`），不要只改上面列的行。已知有一處預先存在的過期散文：`apps/harness/src/agent-factory.test.ts:655` 還寫「九個配套入口」，實際是 20 個。

### 歸屬與慣例

這是 `apps/harness` 加上 `packages/*` 的改動，歸 dev-harness。分支名與 PR 標題可以用：`refactor/drop-empty-invariant-companions`、`refactor: 拿掉十二個沒有檢查的空配套入口`。

### 驗收

- `pnpm --filter @nexus/harness exec vitest run` 與 `pnpm run verify-package-invariants` 通過。
- `packages/*/src/invariant.ts` 的數量是 8，`cordis.yml` 裡 `name: '@nexus/.*/invariant'` 的列是 8。
- 新增一個沒有任何 `fail(` 的 `invariant.ts`，閘門變紅（絆索翻面的那一條）。
- 上述舊說法全文 grep 零殘留（歷史稽核檔除外）。

## 六、為什麼不是一次做完

兩個理由，都不是「怕麻煩」：

1. 那 8 個真檢查各有具體內容（第二節的表），其中跨筆關係的那幾條（turn 配對、`tool/call`↔`tool/result`、`command/run`↔`done`）目前**沒有別的地方在擋**。
2. 單筆形狀那幾條（`todo/write`、`plan/mode`、`sandbox/mode`、`present` 的 `files`）更像「讀入時驗證」，dsh 的路線是各自 owner 的驗證器。這一類可以搬，但搬去哪裡（jsonl store 讀回、續接、還是各外掛自己）是另一個設計問題，不該夾在這一刀裡。

## 七、再觀察：條件（提議，尚未拍板）

「再觀察」目前沒有定義觀察什麼、看多久。下面是提議，等 demian 確認或改寫：

- **要先能回答的問題：過去一段時間，這 8 個有沒有報過違規？** 現在違規只進 `console.error`／終端，沒有計數，所以這個問題**今天答不了**。這是觀察的前提，不是額外的功能。
  - **2026-10-03 更新**：[#976](https://github.com/DemianLi/nexus-agent/issues/976) 補上量測記錄（`$NEXUS_AGENT_HOME/invariant-log.jsonl`，讀法見 `docs/operations.md` 的「不變量量測記錄」）。**這個問題從那一天起才有資料**，之前的歷史答不了。
- **重審的觸發條件（任一個成立就開第二刀的決定）：**
  - dsh 公布取代做法，或 nexus 對 dsh 的對讀看到它如何處理 turn 配對這類跨筆關係。
  - #721 一類的功能再次需要改 core 的配對不變量（它已經綁住過一次續接補結）。
  - 再發生一次「檢查整個消失而沒有任何東西變紅」（#668 那一類）。
  - 8 個裡任何一個在實跑中第一次報出真違規（那會是它值得留的第一份證據）。
- **提議的重審時間：2026-11-03**（一個月後）。這是提議，不是承諾。
- **第二刀的可能走向**（現在不選）：全部拿掉；只留 `@nexus/core` 的跨筆關係；單筆形狀搬到讀入時驗證、跨筆關係留著。

## 八、沒涵蓋／未驗證

- **沒有量運行時成本**：每個會話事件要派發給 8 個（現在是 20 個）檢查，耗時沒有量。
- **沒有逐條讀 34 處 `fail(` 的實作與測試覆蓋**；第二節表格的分類只依訊息。
- **沒有驗證 serve 的 `console.error` 實際出現在哪一份日誌**，只依 [#107](https://github.com/DemianLi/nexus-agent/issues/107) 與 `seven-layer-inventory-2026-09-26.md` 的敘述。
- **dsh 為什麼移除沒有官方陳述**，第一節的前因是從筆記推出來的。
- **「沒找到抓到過真問題的紀錄」是否定性結論**，搜尋範圍見第二節。
- **dsh 的 `sdk-minimal` 出廠與「base 不掛」** 引自 9/26 盤點對 `477b4f4` 的敘述，沒有在最新 HEAD 重驗；`sdk-minimal` 在新 HEAD 已不含那五列（升級指南明寫）。

## 九、來源

- dsh：`f028f25667d`（2026-09-30）；`docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md`；`.agents/notes/archived/architecture/2026-07-19-package-invariant-runtime-contracts.md`；`.agents/notes/archived/simplification/2026-08-28-omit-unneeded-invariant-companions.md`；`docs/persistence-changes/historical-formats/v3.md`。對讀版本為 `references/deepseek-harness` 的 `5badb15009a`（2026-10-03）。
- nexus：[#101](https://github.com/DemianLi/nexus-agent/issues/101)、[#107](https://github.com/DemianLi/nexus-agent/issues/107)、[#108](https://github.com/DemianLi/nexus-agent/issues/108)、[#454](https://github.com/DemianLi/nexus-agent/issues/454)、[#668](https://github.com/DemianLi/nexus-agent/issues/668)、[#699](https://github.com/DemianLi/nexus-agent/issues/699)、[#721](https://github.com/DemianLi/nexus-agent/issues/721)；`develop` 於 `320c0ec`。
