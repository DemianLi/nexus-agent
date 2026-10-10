# 程式碼規範

程式碼該怎麼寫。協作流程（PR 標題、分支命名、PR 內文）見 [AGENTS.md](../AGENTS.md)。

這份文件只寫已經定案的條文。沒遇過的問題不先寫規範 — 憑空發明的條文與實際長出來的程式碼對不上，最後會變成沒人遵守、卻被 code review 拿來挑錯的死條文。

## 測試

**不設覆蓋率門檻。** 這個專案的風險在「plugin 契約有沒有被正確呼叫」，那是覆蓋率量不出來的東西；此刻設門檻只會逼出為了數字而寫的測試。

要測的是行為，不是行數：

- **plugin 契約的每個擴充點** — 註冊、呼叫時機、回傳值處理，各要有測試。
- **修 bug 先寫測試** — 測試要能在修好之前重現該 bug，否則無從證明它修好了。
- **沒有測試的套件不得通過 gate** — CI 對 `packages/*` 跑 `pnpm --filter ./packages/* run test`（功能分支 → `develop` 的 PR 只跑異動到的 plugin 套件，`develop → main` 全跑），vitest 找不到測試檔就是紅燈。不要用 `passWithNoTests`，也不要改成 `--if-present` 把它繞過去。這個 gate 的價值就在於它會因為缺測試而失敗。

測試與護欄也會說謊：宣稱的比實際觀察的多、或期望值跟被測物是同一個來源，綠燈就什麼都沒證明。三條（照 dsh `docs/testing.md`「Verify the world, not the self-report」與「A guard only guards if the regression fails it」）：

- **期望值不取自被測物。** 驗證器或測試的「期望」要來自另一個來源 — 獨立重算、固定字面值、從外面重讀 — 不是被測函式自己吐出來再拿來比。沒動過的東西，斷言位元組相同。例：`attachment-store.test.ts` 的參照期望值用測試自己的 `createHash` 算，不拿 `save()` 回的 `attachmentId` 去比 `save()`。
- **護欄要證明會紅。** 新加或改動護欄（防回歸的測試、型別絆索、驗證器）時，PR 內文寫明「引入了什麼回歸、哪幾條測試紅、已還原」，而且真的做過，不是推論。紅的數量是 0 不算：那通常是指令沒跑起來，或測的不是那條路。例：[#214](https://github.com/DemianLi/nexus-agent/pull/214) 對兩條絆索各做突變，四個突變四個都紅，不然一條 `@ts-expect-error` 綠著，分不出「擋住了」與「那行根本沒被檢查」。
- **斷言要看得到被宣稱的東西。** 測試名或註解宣稱「攔下 X」時，斷言要能分辨「攔下了」與「X 本來就沒發生」；分不出，就是這條測試對那件事什麼都沒說。例：[#117](https://github.com/DemianLi/nexus-agent/pull/117) 的「記憶與指引共存」那條抓不到取代式的實作 — 計劃模式的 middleware 站在記憶外面，整個換掉 `systemMessage` 它照樣綠 — 量到之後把這個限制寫進註解，另外釘真正擋得住的那條。

等 Phase 1 有真正的 plugin 實作之後，再回頭評估要不要加量化門檻。

## 秘密與環境變數

GitHub 端已啟用 secret scanning 與 push protection，但它們只擋得住已知格式的憑證被 push，擋不住自己造的洞。三條規範：

1. **所有 secret 一律走環境變數。** 不寫進程式碼、不寫進設定檔、不寫進測試 fixture。**唯一的例外是使用者自己的受管憑證檔**（[#730](https://github.com/DemianLi/nexus-agent/issues/730)）：harness home 的 `.credentials.yaml`（預設 `~/.nexus-agent/`，`chmod 600`），它住在使用者家目錄、不在程式碼資料夾裡，也不進版控；值只在請求當下讀，不寫進行程的環境變數。環境變數仍然優先於它。
2. **`.env.example` 列出每個必要的 key，但不放值。** 值填進 harness home 的 `.env`、受管憑證檔，或目前資料夾的 `.env`（見 [`operations.md`](operations.md) 的「金鑰放哪裡」）。`.gitignore` 已經預留 `!.env.example` 例外。
3. **不得有預設 key 或 fallback。** `process.env.API_KEY ?? 'sk-...'` 這種寫法一律不接受。缺少必要的環境變數時要直接失敗並說明缺哪一個，不要靜默降級。
