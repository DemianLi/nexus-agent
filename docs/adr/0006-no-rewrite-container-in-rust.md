# 不為熱插拔而以 Rust 重寫容器

2026-10-08 的決定（類別：項目），取代 [`decisions-2026-10-08.md`](https://github.com/DemianLi/nexus-agent/blob/archive/docs-2026-11/.docs/decisions-2026-10-08.md)，並限縮成它真正回答的那一題：**不為了熱插拔而用 Rust 重寫 Cordis 或 plugin 載入與註冊那一層**。理由：Rust 化容器帶不來熱插拔（dsh 的熱重載靠 Node 內部的模組快取，Rust 沒有對應物）；新舊並存（新版放版本目錄、絕對路徑 `import()`、新 thread 載入新版）已驗證可行；量到的效能熱點都是 JS 層的演算法與資料保留問題，而且已用 TypeScript 修掉。

## 與 Rust 宿主行程（#2568）的分界

這份決定管的是每條 thread 的**容器**，也就是 plugin 的載入、註冊與熱換；今天它仍是 TypeScript：出貨清單 `harness/apps/harness/cordis.yml`，由 `loadPluginConfig`（`harness/apps/harness/src/plugin-config.ts:1688`）載入。[#2568](https://github.com/DemianLi/nexus-agent/issues/2568) 設計的是 Rust 宿主行程（誰起宿主、死了帶走什麼），而這個宿主今天已經有自己的主機級插件樹：內核在 `harness/native/sandbox-spawner/host/src/kernel/mod.rs:1`（#2569），照 `--plugins` 掛編進執行檔的插件（`host/src/host/mod.rs:2`；出貨建置只有 `mcp`，`host/src/host/plugins.rs:28-35`）；每條對話一個的 Rust 組合行程與它共用內核，目前只有骨架、harness 與出貨都還沒接（`host/src/composition/mod.rs:1-3`，#2583）。這份決定**不**授權 Rust 這一側接手每條 thread 容器的載入與註冊；若 #2568 或 [#3024](https://github.com/DemianLi/nexus-agent/issues/3024) 的設計走到那一步，要回到這份決定的重開條件重新決定，並更新這份 ADR。

## 沒有回答的

- 要不要拿掉 LangChain：今天由 [#2336](https://github.com/DemianLi/nexus-agent/issues/2336) 與 #3024 承接。
- Rust 當 plugin 內的實作語言：不排除，只在 profile 指出具體熱點、TypeScript 最佳化動不了時才用。
- 隔離不信任的插件：另議，與容器語言無關。

## Consequences

- 重開條件：出現量測證明的瓶頸、根因在容器本身，且 TypeScript 層修不掉；客戶要求單一原生二進位，且 Node SEA 與 bun compile 都滿足不了；要隔離不信任的插件，且子行程與 WASM 都不夠。
- 全文與相關調研在 tag `archive/docs-2026-11`。
