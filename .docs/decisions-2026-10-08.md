# 不以 Rust 重寫容器：決議（2026-10-08）

**來源**：2026-10-07 至 10-08 的一場討論。起點是「把 dsh 那種時空可組合性的 Cordis 翻寫成 Rust，替換成 nexus-agent 的核心，能不能保持熱插拔」。事實調研見 [`rust-and-langchain-removal-2026-10-06.md`](rust-and-langchain-removal-2026-10-06.md) 與 [`admin-plugin-swap-decision-draft-2026-10-07.md`](admin-plugin-swap-decision-draft-2026-10-07.md)，新舊並存的量測見 [`plugin-coexist-measurement-2026-10-07.md`](plugin-coexist-measurement-2026-10-07.md)。

**拍板**：demian 2026-10-08 要求正式登記。

## 決議

**不以 Rust 重寫 Cordis，也不以 Rust 取代 nexus 的容器（plugin 載入與註冊那一層）。容器維持 TypeScript。**

## 理由

1. **Rust 化容器不會帶來熱插拔。** dsh 熱重載的那一層（`plugin-hmr`）靠 Node 內部的模組快取（`--expose-internals`、`loadCache`、`Module._cache`），Rust 沒有對應物。
2. **nexus 要的熱插拔另有解，且已驗證。** 走「新舊並存」：新版放版本目錄，用絕對路徑 `import()`，新 thread 載入新版（#1139，PR #1146）。載入器不用改。
3. **量到的效能熱點都是 JS 層的演算法與資料保留問題**，沒有一處是「JS 做不到的事」，且兩個熱點（存檔點 #1106、token 估算 #1107）已用 TypeScript 層的改動修掉（PR #1109、#1110）。
4. **核心是 TypeScript 生態**：22 個 plugin、web、LangChain 家族的型別，換容器等於重寫整個 agent，與熱插拔需求無關。
5. 企業級需求的重點（管理員角色、稽核、簽章）在治理層，不在容器的實作語言。

## 範圍：這份決議**沒有**回答的

- **要不要拿掉 LangChain／deepagents／langgraph**：不在這份決議內，仍在討論。見 [`rust-and-langchain-removal-2026-10-06.md`](rust-and-langchain-removal-2026-10-06.md) §五、§七。
- **Rust 作為 plugin 內的實作語言**：不被這份決議排除。只在 profile 指出具體熱點、且 TypeScript 最佳化動不了時，用 N-API 或 sidecar 換那一塊。
- **隔離不信任的插件**（WASM、子行程）：另議，與容器語言無關。

## 重開條件

- 出現量測證明的瓶頸，且根因在容器本身而不在演算法或資料保留，TypeScript 層的改動修不掉。
- 客戶或部署要求單一原生二進位，且 Node SEA 或 bun compile 滿足不了。
- 要隔離不信任的插件，且子行程或 WASM 都不夠。
