# 待拍板 12 題與拍板結果（2026-09-19）

**來源**：這 12 題來自三處：
- 七層盤點（[`seven-layer-inventory-2026-09-19.md`](seven-layer-inventory-2026-09-19.md)）列出、還沒判過的 9 題；
- #180 的前提重核，以及 `document`；
- 單一職責盤點（[`srp-audit-2026-09-19.md`](srp-audit-2026-09-19.md)）帶出來的第 12 題。

對照版本是 dsh `ddefc45` 與 develop `8fb2e51`。

**拍板**：demian 2026-09-19 回覆「照建議」，12 題全部照下表的建議。後續的卡號列在表的最後一欄。

**產生方式**：每題先由一位 agent 起草，再由出處與範圍兩位審查者查核，最後由主線重新核對關鍵事實、寫成定稿。第 5、7 兩題的建議與起草素材不同，理由寫在題內。

## 總表

| # | 題目 | 建議＝拍板 | 歸屬 | 後續 |
| --- | --- | --- | --- | --- |
| 1 | web_search／web_fetch 要不要掛 | **A 不掛**（dsh 自己寫了這條覆寫路） | — | 調研筆記第 48 列 |
| 2 | skills 要不要進預設清單 | **A 進預設**（沒有 backend 就什麼都不加） | harness | #440 |
| 3 | `present`（宣告交付檔案） | **A 後端照 dsh 做並進預設，卡片交 dev-ui** | harness＋web | #441 |
| 4 | 工具 schema 目錄與新鮮度 gate | **A 從產品路徑自動產出目錄＋gate** | harness | #442（範圍照 dsh 更正，見題內） |
| 5 | 跨會話引用（session-reference） | **A 等 web 要做 @ 提及時再一起做** ⚠ 與素材不同 | web 先 | 調研筆記第 9 列 |
| 6 | `@file` 引用（file-reference） | **A 等 web 要做 @file 補全時再一起做** | web 先 | 調研筆記第 9 列 |
| 7 | 耐久檢查點（checkpoint-policy） | **A 照 dsh 三個存檔點全做** ⚠ 與素材不同 | harness | #447 |
| 8 | 每輪改動檔案（workspace-changes） | **A 後端照 dsh 做，卡片交 dev-ui** | harness＋web | #443 |
| 9 | 會話日誌要不要預設落盤 | **A 照 dsh 預設落盤到 `~/.nexus-agent/sessions`** | harness | #444 |
| 10 | goal 自動續行的預設（#180 前提重核） | **A serve 預設開、CLI 維持預設關** | harness | #445 |
| 11 | `document`（Office 轉 PDF） | **A 不做，登記「需求未出現」** | — | 調研筆記第 55 列 |
| 12 | core 的能力要不要拆成 plugin（連同 #46） | **C 啟動 #46，第一步先拆摘要器** | harness | #46 ＋ #446 |

---

### 1. web_search／web_fetch 要不要掛

- **dsh**：
  - base 出廠就掛 `web`、`web-search-deepseek`、`web-fetch-http`、`tool-web`（`packages/bundle/base/cordis.patch.yml:458-476`）。headless 疊在 base 上，所以也有。
  - web-app 把 host 那一列關掉，改由 standard／ptc／cordis 三個 preset 各自掛；minimal 不掛。
  - base 的註解（`:446-449`）明寫：網路政策比較嚴的產品，可以覆寫掉 `tool-web`。
  - 內建的 fetch 只接受公網 HTTP(S)，不會連到 loopback；搜尋用的是 DeepSeek 的服務。
- **我們**：完全沒有這類工具（產品路徑上 grep 為 0）。部署是完全內網、連不到外網。
- **選項**：
  - **A 不掛**：走 dsh 自己寫的覆寫路，不必另外登記偏離。
  - **B 自己寫內網用的 provider**：要新寫 fetch 與搜尋。在多人共用主機上，fetch 碰得到 loopback，會有 SSRF 風險。
  - **C 用 MCP server 接內網搜尋**：已經做得到，要用時由部署方自己設定。
- **建議 A**：這是 dsh 為「網路政策更嚴的產品」預留的路。之後真有內網搜尋的需求，走 C 就好，不必改核心。
- **下一步**：在調研筆記第 48 列寫下「照 dsh 的覆寫路，不掛」。不用開卡。

### 2. skills 要不要進預設清單

- **dsh**：
  - base 出廠就掛 `skill`、`skill-filesystem`、`tool-skill`（`:280-290`）。
  - web-app 關掉 host 那兩列，改由 standard／ptc／cordis 三個 preset 各自掛。
- **我們**：
  - `@nexus/plugin-skills` 預設讀 `/skills/`（`packages/nexus-plugin-skills/src/index.ts:38`），但不在 `DEFAULT_PLUGINS` 裡。除了測試，沒有任何地方掛它。
  - 有現成的前例：agent-instructions 已經放在預設清單裡，而且只有在有 backend 時才真的建 middleware（`apps/harness/src/cli.ts:544-546`）。
- **選項**：
  - **A 照 dsh 進預設**：用 agent-instructions 的形狀，沒有 `--workspace` 時什麼都不加。
  - **B 維持選配**：這算偏離。dsh 出廠就開，我們寫不出「表達不出來」的理由。
- **建議 A**：成本很小，而且已有前例。要先確認一件事：這個 plugin 在「目錄是空的」時，不會往提示詞塞一段空的 skills 清單。
- **下一步**：開一張卡（harness），補一條「零設定也掛得上」的端到端測試。

### 3. `present`（宣告交付檔案）

- **dsh**：
  - `packages/deliverables/tool-present`：讓模型宣告交付了哪些檔案，只記路徑與說明，不複製內容。
  - standard／ptc／cordis 三個 preset 都掛（例如 `packages/preset/agent-presets/presets/standard/agent.cordis.yml:261`）；minimal 不掛。
  - web 端由 `ui-deliverables` 呈現交付卡片。
- **我們**：沒有。
- **選項**：
  - **A 後端照 dsh 做並進預設，web 卡片交 dev-ui**。
  - **B 先不做**：這算偏離，理由寫不出來。
- **建議 A**：這是模型看得到的工具，執行語意照 dsh；卡片長什麼樣屬於 UI/UX，由 dev-ui 決定。
- **下一步**：開兩張卡：後端歸 harness；web 卡片經你轉給 dev-ui。

### 4. 工具 schema 目錄與新鮮度 gate

- **dsh**：
  - `scripts/gen-tool-catalog.ts` 把每一個工具的名稱、描述、參數產成 `docs/tool-catalog.md`。
  - `scripts/run-gates.ts:751` 有一道 `verify-tool-catalog` gate，確保這份檔案沒有過期。
  - 它不檢查描述寫得好不好，但描述一改，就一定會出現在 diff 裡。
- **我們**：沒有目錄，也沒有 gate。工具散在各個 plugin 裡，扣掉測試共有 22 處註冊點。
- **選項**：
  - **A 從產品路徑自動產出目錄**：折疊零設定的組裝、把 schema 轉成 JSON Schema、寫成 markdown，再加一道 CI gate 比對新鮮度。
  - **B 只在測試層做 snapshot**：成本比較低，但人與模型都看不到那份目錄。
  - **C 不做**。
- **建議 A**：這是 dsh「機械可檢查的不變量要進 gate」的做法，也是唯一能在 review 時看到「模型實際收到哪些工具描述」的選項。選配的 plugin 不列進去，並在檔頭寫明。
- **下一步**：開一張卡（harness／CI）。如果第 12 題選了 C，之後可以依 profile 各產一份。

> **開卡前查核更正（2026-09-19）**：上面「選配的 plugin 不列」讀錯了 dsh。dsh 的 `docs/tool-catalog.md` 收錄 `packages/*/tool-*` 底下每一個出廠的工具套件，連 base 出廠關掉的 `dsh-experimental-tool-agent-team` 也收，只排除 `examples/`。每個套件用預設 Config 單獨啟動來讀 schema，另有完整性檢查（`scripts/gen-tool-catalog.ts` 的 `assertManifestComplete`）。所以目錄按套件分、不按組合分，「依 profile 各產一份」也不需要。#442 照 dsh 做；拍板的 A（自動產出＋gate）不變。

### 5. 跨會話引用（session-reference）⚠ 建議與素材不同

- **dsh**：
  - 只有 web-app 掛（`packages/bundle/web-app/cordis.patch.yml:75`）。
  - 使用者在輸入裡用 `@label` 提到別的會話時，會附上那個會話的唯讀快照當背景，並帶一段固定的警告。
  - 硬性依賴 `sessionQuery` 服務。
- **我們**：
  - 沒有這個功能，也沒有 `sessionQuery`（調研筆記把它判成「需求未出現」）。
  - 我們的 web 沒有 @ 提及的語法。
- **選項**：
  - **A 等 web 要做 @ 提及時一起做**：到時後端的 `sessionQuery` 與快照一併做。
  - **B 後端先做**：包含 `sessionQuery`。
  - **C 不做**。
- **建議 A**：
  - 這個能力只有在使用者用 @ 提到別的會話時才會被用到。web 沒有這個語法，後端做了也不會有任何東西呼叫它。
  - dsh 房規要求「每個抽象都要有當下的擁有者與需求」。
  - 素材建議 B，但 B 會先蓋起一整套 `sessionQuery`，卻沒有任何使用它的地方。
- **下一步**：在調研筆記登記「等 web 的 @ 提及」。dev-ui 要做時，後端開卡。在多人共用主機上，列出候選會話時要注意權限。

### 6. `@file` 引用（file-reference）

- **dsh**：只有 web-app 掛 `file-reference-local`（`:78-79`）。輸入 `@` 時列出工作目錄裡的檔案當候選，模型會被指示用 read 工具去讀。
- **我們**：沒有。
- **選項**：
  - **A 等 web 要做 @file 補全時一起做**：後端的候選清單歸 harness。
  - **B 後端先做**。
- **建議 A**：理由同第 5 題，這個能力由 web 的輸入語法驅動。
- **下一步**：同第 5 題。

### 7. 耐久檢查點（session-checkpoint-policy）⚠ 建議與素材不同

- **dsh**：
  - base 出廠就掛（`:399`）。在三個時點各 flush 一次會話日誌：每次模型請求之前、頂層工具可能產生外部副作用之前、下一步之前。
  - 它的 README 說：不掛也行，但保證比較弱。
- **我們**：
  - 日誌是背景批次寫入。唯一的顯式 flush 在 goal 那一輪開始之前（`apps/harness/src/goal-driver.ts:282`）。
  - 落盤本身是選配，要加 `--session-log`（見第 9 題）。
- **選項**：
  - **A 照 dsh 三個點全做**：掛在 `wrapModelCall` 與 `wrapToolCall` 上。這兩個鉤子**不是圖裡的節點**，不會多占一輪；代價只是每次模型呼叫與工具呼叫前，多等一次寫檔。
  - **B 只在工具呼叫前 flush**。
  - **C 不做**：寫不出合格的偏離理由。
- **建議 A**：素材建議 B，理由是 A 的時點得用 `beforeModel`，每輪會多一格。改用 `wrapModelCall` 就沒有這個代價，所以照 dsh 全做並不貴。
- **下一步**：開一張卡（harness）。只有開了落盤時才有作用，所以跟第 9 題一起看。

### 8. 每輪改動檔案（workspace-changes）

- **dsh**：
  - 只有 web-app 掛（`:300`）。
  - 每一輪開始時先做一次 git 工作樹快照，檔案工具改檔前後各保留一份，最後算出這一輪改了哪些檔，發出 `workspace/changes` 事件。
  - web 端有「改了哪些檔」的卡片。有逾時、檔案數與檔案大小的上限可以設定。
- **我們**：沒有。
- **選項**：
  - **A 後端照 dsh 做，卡片交 dev-ui**。
  - **B 不做**：寫不出合格的偏離理由。
- **建議 A**：
  - 這也回答了七層裡「交付物審查」的缺口。
  - 要注意兩件事：在多人共用主機上，暫存的檔案副本要是 `0700`／`0600`；沒有 `--workspace` 時沒有工作樹，這個功能直接不作用。
- **下一步**：後端開一張卡（harness），web 卡片經你轉給 dev-ui。

> **開卡前查核更正（2026-09-19）**：「沒有 `--workspace` 就不作用」在 dsh 的判準是 `eligible`：沒有 cwd，或是子代理的會話，就不記（`packages/deliverables/workspace-changes/src/index.ts:58-61`）。我們的「沒有 cwd」就是沒給 `--workspace`。暫存目錄照 dsh 用 `mkdtemp` 建，本身就是 `0700`。#443 照這個寫。

### 9. 會話日誌要不要預設落盤

- **dsh**：
  - base 與 sdk-minimal 出廠就開著 `session-persistence-jsonl`，寫到 `$DSH_HOME/sessions`（base 約第 117-120 行）。
  - 目錄 `0700`、檔案 `0600`。
- **我們**：
  - 要加 `--session-log <dir>` 才寫。理由寫在 README 與 `cli.ts:126-127`：「日誌裡有使用者打的每一句話，要不要往家目錄寫，該由人決定」。
  - 這是政策上的理由，不是偏離規則要求的「表達不出來」。
- **變化**：#424 建好了 harness home `~/.nexus-agent`，也就是 dsh 放日誌的同一個位置。檔案權限我們本來就是 `0700`／`0600`（`jsonl-session-store.ts:74-75`）；在多人共用主機上，每個人的 home 各自獨立。
- **選項**：
  - **A 照 dsh 預設落盤到 `~/.nexus-agent/sessions`**：`--session-log` 改成指定其他位置。「日誌不落在 `--workspace` 底下」與「`--resume` 跟 `--session-log` 不能同時用」這兩條約束照舊。
  - **B 維持預設不落盤**：要補偏離登記，但理由寫不出來。
- **建議 A**。等 #424 合併之後再做。
- **下一步**：
  - 開一張卡（harness），同一個 PR 改 README 與原始碼的說明；
  - 若第 7 題也選 A，兩張卡可以一起排。

### 10. goal 自動續行的預設（#180 前提重核）

- **dsh**：
  - base 出廠就掛 goal-round-driver（`:302`）。
  - 續行的開關是行程內的狀態，不會存檔，每次 agent 建立時重設為關閉（`packages/goal/goal/README.zh.md:99`）；resume 之後要使用者明確授權才會續行。
- **我們**：
  - CLI 與 serve 都要加 `--goal-driver` 才會自動續行，預設關（#180）。
  - **CLI 的理由到今天仍成立**：CLI 用 `HEADLESS_APPROVALS`，需要核准的工具會被確定性地拒絕。續行之後會一再撞上同一個拒絕、空轉燒輪數，而且這種失敗在日誌上跟工具自己出錯長得一樣，分辨不出來（`apps/harness/src/goal-driver.ts:36-58`）。
  - **serve 的情況不同**：需要核准時會停下來等人，不會被確定性拒絕，所以沒有空轉的問題。
- **選項**：
  - **A serve 預設開、CLI 維持預設關**。
  - **B 兩邊都維持預設關**：跟 dsh 出廠不同，serve 那一側寫不出理由。
  - **C 兩邊都預設開**：CLI 會空轉。
- **建議 A**。素材把理由寫成「#424 認證之後，serve 就有人在」，這個說法不對：認證只保證來的人是擁有者，不保證有人在場。真正的理由是上面講的核准語意差別。
- **下一步**：
  - 開一張卡（harness），把 serve 的預設改成開、仍保留 `--no-goal-driver` 可以關；
  - 同一個 PR 更新 README 與調研筆記第 18 列的「前提待重核」。

### 11. `document`（Office 轉 PDF）

- **dsh**：只有 web-app 掛 `office-to-pdf`，跟右側欄、文件預覽是一組（`packages/bundle/web-app/cordis.patch.yml:224-233`）。它是 web 預覽面板的後端，要搭配 LibreOffice kit。
- **我們**：沒有右側欄，也沒有文件預覽面板。
- **選項**：
  - **A 不做，登記「需求未出現」**：等 dev-ui 要做文件預覽時再開卡。
  - **B 照 dsh 整套做**。
- **建議 A**：它沒有任何使用者（我們的 web 沒有預覽面板），而且會帶進 LibreOffice 這個很重的依賴。
- **下一步**：把調研筆記裡 `document` 那一列從「沒有結論」改成「需求未出現」，寫明重開條件。

### 12. core 的能力要不要拆成 plugin（連同設定機制 #46）

- **要決定的**：
  - core 的 fold 固定掛上的 12 顆 middleware，要不要照 dsh 做成部署時可以個別關掉或換掉的條目；
  - 承載這件事的設定機制（#46，現在標「需要時再啟動」）要不要現在就啟動。
- **dsh**：
  - 大多數能力是 base 裡的獨立條目，每一列都能依 id 停用或覆寫，並帶有經過驗證的 Config：`approval`（`:231`）、`fs-observation-policy`（`:264`）、`token-meter`（`:324`）、`compaction-basic`（`:327`）、`tool-result-pruner`（`:404`）、`repeat-tool-reminder`（`:441`）。
  - 每個 preset 自己決定要掛哪些：minimal 兩個都不掛，standard 會給修剪設定門檻（`packages/preset/agent-presets/presets/standard/agent.cordis.yml:151-156`）。
  - 圍堵、中止、參數與輸出校驗在工具管線或迴圈本體裡，本來就關不掉。
  - 房規 No hardcoded tunables：可調的值要是 Config 欄位。
- **我們**：
  - 12 顆由 `packages/nexus-core/src/fold.ts:669-712` 固定掛上。逐顆對照 dsh 的結果見單一職責報告：
    - 8 顆只是形狀不同，不算落差；
    - **summarizer 是真的落差**：摘要與修剪綁在一起，而且傳 `false` 的意思是把控制權交還給基座，不是關掉；
    - observationPolicy 與 repeatReminder 在 API 層關得掉，但 CLI／serve 沒有入口；
    - modelUsage 在形式上算落差。
  - 組合本身寫死在 `DEFAULT_PLUGINS`（`apps/harness/src/cli.ts:542`），`--plugins` 一給就整份換掉。
  - 部署時會想改的可調值約 28 個，全部寫死。
- **選項**：
  - **A 維持現狀，只登記偏離**：偏離規則要求「表達不出來」才能這樣做，但這裡表達得出來，理由站不住。
  - **B 只補真正的落差**：把摘要與修剪拆成兩顆、可以各自關（M）。形狀對齊 dsh，但產品路徑上仍然沒有入口可以關。
  - **C 啟動 #46**：先做部署設定這一層，照 dsh `cordis.yml` 的形狀：
    - 條目有 id、可以停用；
    - Config 經過驗證，設定寫錯就讓載入失敗；
    - plugin 清單與各 plugin、core 的 Config 欄位都住在這一層。
    
    接著把 B 的拆分與那 28 個值逐步搬進去（L，分幾張卡）。
- **建議 C，第一步先做 B**：你要的「萬物皆插件」，核心就是「組合是資料」。那 8 顆不算落差的繼續留在 core，不為了形狀一致硬拆；房規說只有角色各自變化時才拆開。
- **下一步**：
  - B 開一張卡（harness）；
  - C 把 #46 改成地圖，先釐清兩件事：設定檔用什麼格式、放在哪裡（`~/.nexus-agent` 或 repo 裡的 profile 檔）；
  - 單一職責工項 SRP-1 併進這張地圖。
- **跟其他題的關係**：第 2、9、10 題的「預設開」，在有了設定層之後，就從改程式碼變成改一行設定。

---

**這一批以外還開著的**：
- 8 張缺口卡已經開好（#430–#437），都是 `needs-triage`；
- 單一職責的工項（SRP-1 到 SRP-4）見單一職責報告：SRP-1 就是 #46（第 12 題拍板啟動，[issuecomment-5739661472](https://github.com/DemianLi/nexus-agent/issues/46#issuecomment-5739661472)），SRP-3 是 #446，SRP-4 歸 dev-ui。
