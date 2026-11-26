# 核心底座 vendor Cordis，agent loop 成為插件，插件遵守同一份規範

2026-10-11 的決議（類別：項目）。核心底座不重寫，把上游 `cordiverse/cordis` 的 main vendor 進 monorepo（`harness/vendor/`），只補需要的本地修改並逐條登記；agent loop 是容器底下的一顆插件；所有插件照 `docs/plugin-contract.md` 的規範寫、被驗、被換。遷移採絞殺式：Cordis 當根，現有 `PluginRegistry` 與組裝流程包成相容層插件，舊插件原樣跑在裡面，再逐顆遷出。

**過渡狀態：vendor Cordis 這個底座，以及 [#1948](https://github.com/DemianLi/nexus-agent/issues/1948) 的 Q21「對話行程裡的插件樹照舊是 TS Cordis、插件寫法不變」，都只是過渡，終點是出貨物裡不留 Cordis**。地圖 [#3024](https://github.com/DemianLi/nexus-agent/issues/3024)（2026-11-19 定）要拿掉它：[#3026](https://github.com/DemianLi/nexus-agent/issues/3026) 設計不靠 Cordis 的插件契約（推翻 Q21），[#3030](https://github.com/DemianLi/nexus-agent/issues/3030) 刪掉 vendor 的 Cordis。下面「插件規範」「後台插拔」「偏離理由」這幾條與底座是誰無關，仍有效；「vendor 上游 main」「絞殺式遷移」「容器擁有執行」是過渡期的做法，等 #3024 完成就被取代。

決議的要點，現行文件各自記著現況：

- **底座與更新**：vendor 清單與分歧登記在 [`harness/vendor/README.md`](../../harness/vendor/README.md)。插件更新只給新對話（新版開新的 entry id 與 isolate realm，舊版引用計數排水後才撤）；核心更新排程重啟、事先公告。
- **插件規範**：manifest 必填、生命週期的副作用走 `ctx.effect`／`ctx.on`、服務用帶型別的 token、契約走 semver、定義／提供者／消費者三角色。現行規範與落實範圍見 [`docs/plugin-contract.md`](../plugin-contract.md)。
- **後台插拔**：真相來源是 append-only 的稽核變更紀錄，插件與 Loader 都不寫回 YAML。
- **第二種合法偏離理由**：產品需求超出 dsh 的射程。決議當時寫進 `AGENTS.md`〈技術實現標準〉；今天只有 [`docs/plugin-contract.md`](../plugin-contract.md) 的偏離表還用它（「理由 2」），`AGENTS.md` 已沒有這條。

## 現況與沒回答的

- agent loop 第二段（照 dsh 的 agent-loop 自寫 loop、取代 LangGraph 那顆插件）由 [#2336](https://github.com/DemianLi/nexus-agent/issues/2336) 承接；底座遷移的地圖是 [#1385](https://github.com/DemianLi/nexus-agent/issues/1385)。
- 插件更新今天只做到設定版本：同一列的宣告改了才分出兩版，程式碼版本（每一版一個 entry id）還沒做（`harness/apps/harness/src/plugin-live-versions.ts` 檔頭）。
- 這份決議的終點已由 [#3024](https://github.com/DemianLi/nexus-agent/issues/3024) 改成「出貨物裡不留 Cordis」（見上方〈過渡狀態〉）；核心底座轉 Rust 宿主行程另由 [#2568](https://github.com/DemianLi/nexus-agent/issues/2568) 設計，這份決議沒有回答它。
- 沒有逐條核對 23 條 Cordis 缺點的處置表（原文第四節）今天各落在哪；要查原表看 tag 裡的原文。

## Considered Options

- **重寫自己的核心底座**：不受別人底座限制，但要自己補熱換、卸載順序、錯誤隔離，且吃掉迭代時間。
- **直接相依 npm 上的 Cordis RC 版，或用 dsh 的 `@deepseek-ai/cordis` 快照**：拿不到上游 main 的修正，也沒法在上游不收時登記本地修改。
- **vendor 上游 main（採用）**：能疊在 core 上面的疊在上面，必須動 core 的先提上游，不收才進本地修改清單。

## Consequences

- vendor 的每一條本地修改都要登記，上游升級時逐條核對。
- 插件規範由 SDK 型別、lint、載入期驗證與一致性測試四層強制，缺一層就是規範沒執行。
- 全文與 Q1–Q30 的逐題紀錄在 tag [`archive/docs-2026-11`](https://github.com/DemianLi/nexus-agent/blob/archive/docs-2026-11/.docs/decisions-2026-10-11.md)。
