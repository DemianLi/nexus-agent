# 請求基準檔

把「線上實際送給模型的請求」存成進版控的檔，比對的基準（#2362）。

- 一個案例一個檔：`<測試檔>/<案例名>.json`，格式見 `src/request-baseline-format.ts`（無損：共用前綴與共用工具表，讀回與錄到的逐位元組相同）。
- 狀態：`identical`（`state` 與 `log` 兩邊相同）、`summary-shape`（只差生摘要的那幾次請求：`log` 是重播、`state` 是模板，#2826）、`known-difference`（差異登記在 `known-differences.json`，原因記在檔裡的 `note`）、`self-compared`（測試自己並排並斷言相同，只比兩次 `log`）、`unstable`（併發時請求到達的先後會變，只記狀態、不存內容）。
- 存的是 `log` 那一側。**不要手改**，重錄：`cd apps/harness && node_modules/.bin/tsx --tsconfig ../../tsconfig.runtime.json src/request-baseline-refresh.ts`（約 5 分鐘）。
- 重錄時 `state` 與 `log` 有不明差異、或只有一邊錄到的案例，就整個失敗、不寫檔；已查清楚的差異登記在 `known-differences.json`。故意改了請求形狀時，PR 內文要貼 `git diff --stat` 與每一份差異的原因。
