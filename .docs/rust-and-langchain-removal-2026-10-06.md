# 拿掉 LangChain 家族、用 Rust 取代 Cordis？—— 先量，再拆成三個決定

這份筆記回答一個問題：「我們的理念跟 dsh 一樣是萬物皆可插件，所以想把 langchain／deepagents／langgraph／langfuse 移除，再用 Rust 取代 Cordis 取得更好的資源管控與效能」——這個方向值不值得走。它是 [`openbitfun-plugin-architecture-2026-10-06.md`](openbitfun-plugin-architecture-2026-10-06.md) 的後續：那份回答「Rust 專案是不是萬物皆可插件」，本篇回答「我們該不該換成 Rust」。我方現況見 [`plugin-architecture-gap-survey.md`](plugin-architecture-gap-survey.md)。

**調研日期**：2026-10-06。對讀版本：nexus `0e759edd`（develop）；dsh `5badb15009ae1756c3afe0ae0cef1faafc290ccc`（`references/deepseek-harness`，HEAD 日期 2026-10-03，這次**沒有**重新 fetch）；OpenBitFun `18aa5441d89f5e24cfb4d8ff54d4b53d92c68896`。**§一前七節的量測跑在 `@langchain/langgraph` 1.4.12 上**（作者 checkout 的 `node_modules` 落後 lockfile；develop 解析的是 1.4.19），1.4.19 的重跑見 §1-8。 **2026-10-06 晚對齊至 develop `50966c1c`**：兩個熱點已被 [#1109](https://github.com/DemianLi/nexus-agent/pull/1109) 與 [#1110](https://github.com/DemianLi/nexus-agent/pull/1110) 修掉，見結論後的「更新」；§一的數字是**修前**的基準。

## 結論

**這個問題其實是三個決定，不能一起答。** 它們的證據、成本與可逆性都不同：

| 決定 | 建議 | 一句話理由 |
| --- | --- | --- |
| ① 用 Rust 重寫編排層（取代 Cordis 那一側） | **現在不做**；存檔點那件事已由 [#1109](https://github.com/DemianLi/nexus-agent/pull/1109) 處理（見下方「更新」） | （修前的量測）量到的成本**不是常數**：每輪 CPU 隨歷史線性變長（短訊息 150 輪：43→177 ms；每輪寫 100 KB 的 60 輪：249→1,300 ms），記憶體隨輪數平方成長（100 輪保留 600 MB）。主因是 LangGraph 的 `MemorySaver`——每個步驟存一份完整狀態的序列化、不修剪（100 輪 1,300 份），其次是我們自己的 `token-estimate.ts`。這兩處都是 JS 層的演算法問題，不需要 Rust 才動得到 |
| ② 移除 LangChain／deepagents／langgraph | **可以做，但理由要換**：「標準那一側沒有它」加上「存檔點是它帶來的實際成本」；要沿縫逐段換，不是一次拿掉 | dsh 的 agent loop 是 2,425 行自己的 TypeScript，零 LangChain 相依；我方正式碼有 71 個檔案碰它。**只換存檔點是否夠用沒驗證**（核准中斷、背景子代理、resume 都依賴它） |
| ③ langfuse | **不適用** | nexus 的程式碼與 `package.json` 裡一個 `langfuse` 都沒有（`grep` 掃 `apps/`、`packages/` 的 `.ts`／`.tsx`／`.json`，零命中） |

**更新（2026-10-06 晚）：兩個熱點都已修掉，而且都沒有用到 Rust，也沒有拿掉 LangChain。**

- **存檔點**：[#1106](https://github.com/DemianLi/nexus-agent/issues/1106) 由 [PR #1109](https://github.com/DemianLi/nexus-agent/pull/1109) 修掉：新增 `PrunedMemorySaver`（每個 thread 只留最新 1 份存檔點與它的 writes），並讓每輪只存一次（`durability: 'exit'`，中斷與出錯照樣存，所以核准與 `resume` 不受影響）。**兩件要一起做**：只修剪，記憶體平了但 CPU 照樣變長（44→228 ms）；只開 exit，CPU 好大半（35→88 ms）但記憶體仍成長。兩者並用後，150 輪短訊息的 `arrayBuffers` 從修前的 1.4～10 GB 降到 3～25 MB 且持平；最重那組（每輪寫 100 KB）RSS 約 1.29 GB（修前 7～12 GB）。**每輪 CPU 沒有完全持平**，從 4～5 倍降到約 2 倍，PR 內文推測殘餘是每輪仍要反序列化最新那份含全歷史的存檔點，該推測沒有單獨量證。這些數字取自 PR 內文，我沒有重量。
- **token 估算**：[#1107](https://github.com/DemianLi/nexus-agent/issues/1107) 由 [PR #1110](https://github.com/DemianLi/nexus-agent/pull/1110) 修掉。**它推翻了我開卡時的框架**：我把成本歸給抽樣（準確度對成本的取捨），PR 作者重量後發現成本在編碼器——`js-tiktoken` 在中文上比 `gpt-tokenizer` 慢 40～200 倍，token 數逐位相同——所以直接換編碼器，沒有準確度代價。
- **偏離登記**（`AGENTS.md`「技術實現標準」）：#1109 的內文登記了這條偏離——dsh 沒有逐步存檔點，狀態以 append-only 會話日誌為準；LangGraph 的 `MemorySaver` 表達不出「沒有狀態歷史」，退到最接近的實作（只留最新的即時狀態）。

**要先更正一句我先前的說法**：我曾說「nexus 沒有 Cordis」。精確版本是：**nexus 沒有 import Cordis 這個套件**（`from 'cordis'` 零命中），但它**有一個 Cordis 形狀的設定面**——`apps/harness/cordis.yml`（45 條插件條目（`grep -c "- id:"`））、`cordis.patch.yml` 疊層、`--dump-config`，組裝在 `apps/harness/src/assembly-root.ts`；插件容器是我們自己寫的 `PluginRegistry`（`packages/nexus-core/src/fold.ts` 一帶）。所以「用 Rust 取代 Cordis」在我方的實際意思是**重寫我們自己的容器、折疊器與所有插件**，不是換掉一個相依。

## 這份筆記的來源與可信度

| 區塊 | 誰做的 | 核對狀況 |
| --- | --- | --- |
| §一 量測 | 主代理跑 | 第一手；原始資料在 session 暫存區（兩輪共 31 次執行加 5 份 CPU profile），**不進 repo**。第一輪（A～E）先寫進本篇初版，第二輪（G、L、W、P、E1～E3、記憶體歸屬）補在這一版，**第二輪推翻了初版的「每輪約 70 ms 常數」說法**（見 §一的更正） |
| §二 相依足跡 | 主代理 `grep` | 第一手；數法寫在表下，可重跑 |
| §三 dsh 與 OpenBitFun 的證據 | 主代理讀 | 第一手；dsh 的 `llm-pi-ai` 說明已讀原文（見 §三的更正） |
| §四 已知的 LangChain 基座陷阱 | 記憶筆記彙整 | **沒有逐條重核**；每條都曾在實跑中遇到並修過，但本篇只列名，不重新驗證 |
| §五 建議 | 判斷 | 不是事實，不是決議 |

**這份筆記沒有子代理的產出。**

## 一、量測：框架自己吃多少

**量什麼**：真的 `apps/harness/src/serve.ts --live`（產品入口，走產品的 wire 協定），模型端指向一個假的 OpenAI 相容串流端點。每一輪是「模型先呼叫一個工具、收到結果後再串流一段回覆」（兩次模型呼叫、約 106～156 個 wire 事件）。CPU 取 `ps -o time` 對 serve 行程樹求和；第二輪另外用 `--inspect` 接 CDP 取 CPU profile、強制 GC 後的堆、事件迴圈利用率與延遲，並用 `Runtime.queryObjects` 找記憶體裡留著什麼。**假端點是獨立行程，它的 CPU 沒算進去。**

**更正初版**：初版（只跑了第一輪）寫「框架每輪約 70 ms CPU、約 2.7% 單核」。那個數字只對**前 40 輪、極短歷史**成立。第二輪量到成本隨歷史變長，所以初版的結論「框架開銷是個位數百分比」要改成「早期是，之後取決於歷史多長與每輪寫多少」。

### 1-1 短歷史（初版的量測，結果仍成立）

| 場景 | 結果（取重複次數的範圍） |
| --- | --- |
| 開機 | 約 0.64～0.79 秒、啟動 CPU 約 0.9～1.1 秒；閒置 RSS 286 MB（接上 inspector 後 300～323 MB） |
| A. 零延遲、同一會話前 40 輪 | 每輪 CPU 中位數 40 ms（p95 110 ms）、牆鐘 48～52 ms；3 次一致 |
| C. 10 條並行 × 3 輪、零延遲 | 30 輪共 0.88～1.0 秒牆鐘、總 CPU 620～830 ms |
| D. 模擬真模型延遲（約 2.6 秒／輪）、單會話 8 輪 | 每輪 CPU 中位數 70 ms（約 2.7% 單核）；2 次一致 |
| E. 同上延遲、10 條並行 × 2 輪 | 總 CPU 1,050～1,140 ms／6.0 秒牆鐘（約 18% 單核）；峰值 RSS 438 MB |

### 1-2 成本隨歷史成長（第二輪新增）

每格是「那一段輪數內的每輪 CPU 平均」，兩次重複取平均（兩次相差在 7% 內）：

| 場景 | 輪數分段 → 每輪 CPU（ms） | 結束時 |
| --- | --- | --- |
| G. 短訊息、零延遲，150 輪 | 每 25 輪一段：43 → 72 → 99 → 123 → 144 → 177 | 牆鐘中位數 80 ms；RSS 1.74 GB；堆 154 MB |
| L. 每輪 8 KB 使用者訊息＋約 4 KB 回覆，60 輪 | 每 10 輪一段：63 → 123 → 164 → 182 → 196 → 220 | RSS 1.87 GB；堆 154 MB |
| W. 每輪模型呼叫 `write_file` 寫 100 KB，60 輪 | 每 10 輪一段：249 → 450 → 655 → 819 → 1,041 → 1,300 | 牆鐘 540～568 ms；RSS **峰值 8.2／11.3 GB**（兩次）；堆 189 MB |

**怎麼讀**：每輪成本大致隨輪數**線性**增加（G 約每輪多 1.1 ms；W 約每輪多 20 ms），所以總成本是輪數的平方。W 是極端情境（每輪 100 KB 的工具參數），L 是中等情境。**這兩個情境用的是假模型的固定腳本，歷史怎麼長、有沒有觸發壓縮，我沒有逐輪確認**——L、W 的事件數只量到中位數。

### 1-3 記憶體：留在哪、為什麼

| 項目 | 量到的 |
| --- | --- |
| 閒置 | V8 堆（強制 GC 後）**70 MB**；`footprint` 341 MB，其中 VM tag 16（V8 配置的頁）224 MB、malloc 約 87 MB；13 條執行緒。**224 MB 裡主堆只佔 75 MB，其餘（程式碼空間、其他 isolate 含 tsx 的載入緒）我沒有再拆** |
| 100 輪後（短訊息） | 堆只有 152 MB（強制 GC 後），**但 `ArrayBuffer` 留著 598 MB**，RSS 約 1.0～1.1 GB；閒置 20 秒後 RSS 只從 1,081 降到 936 MB |
| 那 598 MB 是誰的 | 用 `queryObjects` 找到：這條會話的 `MemorySaver` 裡有 **1,300 個存檔點（約每輪 13 個）**，`storage` 545 MB、`writes` 49 MB，合計 594 MB，**佔 `ArrayBuffer` 的 99%** |
| 150 輪、短訊息 | 堆 149→154.5 MB（每輪約 +45 KB，是正常的狀態成長）；RSS 316→1,737 MB |

**這是初版問的「洩漏還是 GC 延遲」的答案**：兩者都不是。**是 `MemorySaver` 保留每個步驟的完整序列化狀態、不修剪舊的**，每份都含整段歷史，所以記憶體隨輪數平方成長。強制 GC 收不掉它，因為它們都還被 `storage` 參照著。`MemorySaver` 是專案自己的註解裡寫明的存檔點（`serve.ts` 每個 thread 一個 agent、各自一個 checkpointer；`packages/nexus-core/src/session-log.ts:7` 的檔頭也這樣寫）。

### 1-4 CPU 花在哪（profile）

兩次 60 輪零延遲 profile 結果一致（只引比例，因為接 profiler 後每輪 CPU 約變 1.5～2.4 倍：零延遲 40→60 ms、模擬延遲 70→170 ms）：

- **堆疊上有 `@langchain/langgraph-checkpoint` 的時間佔 40～42%**；有 `@langchain/langgraph` 的佔 50～51%；有 `@langchain/core` 的佔 36%；我們自己的 `nexus-core` 佔 11%、`apps/harness` 佔 11～12%。
- 自身時間第一名是 `fast-safe-stringify`（佔 14～15%），**幾乎全部（490／490 ms）由 `MemorySaver.put → dumpsTyped` 呼叫**；`@langchain/core` 的序列化函式（`snakeCase`、`toJSON`、`escapeIfNeeded`、`reviver` 等）合計約 14%，也在同一條讀寫存檔點的路上。GC 約 5～7%。
- **歷史短的時候不是這樣**：模擬延遲的 12 輪 profile 裡存檔點只佔 4～9%，`node:internal`（計時器、串流、HTTP）佔 25～29%、GC 9～11%。這與 1-2 的成長一致。
- 每輪寫 100 KB 的 profile：存檔點**自身**佔 52%（`fast-safe-stringify` 單一函式 47%）；`js-tiktoken` 佔 19%，**3,055 ms 全部由我們自己的 `packages/nexus-core/src/token-estimate.ts` 呼叫**；`encodeUtf8` 7%。

### 1-5 事件迴圈

| 場景 | 利用率 | 延遲 |
| --- | --- | --- |
| 模擬延遲、單會話 | 2.3～3.1% | p99 7.0～7.5 ms |
| 模擬延遲、10 條並行 | 10.3～10.8% | p99 9.3～11.0 ms、最大 25～37 ms |
| 零延遲、10 條並行 | 46.5～56.3% | p99 13.9～34.3 ms、最大 17～41 ms |

（取樣解析度 5 ms，所以 p50 的 6.3 ms 是量具底噪。）這只對**短歷史**成立；歷史長了之後每輪 CPU 變多，同一個並行度下的利用率會跟著升，**我沒有量那一格**。

### 1-6 常駐記憶體拆解

裸 Node 46 MB；載入 `@langchain/core`、`@langchain/openai`、`@langchain/langgraph`、`deepagents` 四個套件後 147 MB（3 次一致，約 +100 MB）。V8 堆在閒置時只有 70 MB，所以那 +100 MB 與 70 MB 堆之間的關係（程式碼空間、編譯快取、堆）**沒有再拆**。`@langchain/mcp-adapters` 解析不到（只裝在 `nexus-plugin-mcp` 底下），沒算進去。

### 1-7 這個量測仍然沒有回答的

1. **模型是假的。** 沒有真實延遲分佈、沒有真的串流中斷；壓縮有沒有在 L、W 裡觸發我沒有確認（事件數沒有按輪對）。
2. **跑在 `tsx` 下，而且這就是產品路徑**：`apps/harness` 的 `build` 只是 `tsc --noEmit`，`serve`／`cli` 都是 `tsx src/…`，沒有打包流程（初版把它當成「偏高的折扣」是錯的）。所以閒置記憶體與開機時間就是這個數字；tsx 的載入緒佔多少沒單獨量。
3. **`ps` 的 CPU 解析度是 10 ms**；每格都引中位數或多輪平均。
4. **機器有負載**（1 分鐘平均 1.0～10.5）。profile 那幾次跑在 10.5→2.7 的負載下，所以只引比例；G／L／W／E 跑在 1～2.5 的負載下，兩次重複相差在 7% 內。
5. **只量了一種工具 I/O**：`ls` 與寫進虛擬檔案系統的 `write_file`；真的檔案系統後端、`grep`、子代理沒進來。
6. **Node 只有 25.9.0**（專案 `engines` 寫 `>=22.19`；機器上另一個只有 20，低於下限，所以沒有跨版本對照）。
7. 第二輪的每次執行都接著 inspector，閒置 RSS 比第一輪多 15～35 MB。
8. 「去掉 `MemorySaver` 的修剪問題後，每輪 CPU 會不會回到常數」**沒有驗證**：profile 顯示它佔 40% 以上，不代表拿掉就剩 60%。**（後續：#1109 量過，不會完全持平，兩件事並用後每輪 CPU 約 2 倍成長；見結論後的更新。）**

### 1-8 在 `@langchain/langgraph` 1.4.19 上重跑（2026-10-06 晚）

§1-1～1-7 的數字都是在 1.4.12 上量的：作者 checkout 的 `node_modules` 比 lockfile 舊（lockfile 與 develop 實際解析的是 1.4.19，`langgraph-checkpoint` 兩邊都是 1.1.5）。事後用乾淨工作樹（develop `20601874`、`pnpm install --frozen-lockfile`，確認解析到 1.4.19）重跑 G、L、W、記憶體歸屬與 profile：

| 項目 | 1.4.19 | 1.4.12 |
| --- | --- | --- |
| 100 輪後存檔點與位元組 | 1,300 個；`storage` 545.2 MB、`writes` 49 MB；`ArrayBuffer` 598.2 MB | 同（逐位元組相同） |
| 堆疊上有 `langgraph-checkpoint` 的時間 | 38.4% | 40～42% |
| `fast-safe-stringify` 自身時間 | 13.0%（`MemorySaver.put` 呼叫 803／866 ms） | 14～15% |
| G 每 25 輪一段的每輪 CPU（ms，兩次） | 52→89→122→145→177→202；54→112→160→186→170→200 | 43→72→99→123→144→177 |
| L 每 10 輪一段（ms，兩次） | 65→…→280；90→…→324 | 63→…→220 |
| W 每 10 輪一段（ms，兩次） | 287→…→1,450；302→…→1,366 | 249→…→1,300 |
| G 150 輪後 RSS | 1.75／1.77 GB | 1.74 GB |

**結論不變**：保留量與版本無關（存檔點數與位元組一致），CPU 成長形狀同為線性，profile 歸屬一致。

**絕對 CPU 比 1.4.12 那次高 10～35%，這個差不能歸給版本**：跑完當下機器 1 分鐘平均負載是 15.8（有別的 session 在量）、兩次重複最多差 30%（L），而且 develop 也往前走了（閒置堆從 70 MB 升到 76 MB）。要隔離版本對 CPU 的影響，得在同一棵樹上連續換版本重跑，**這輪沒做**。所以：**拿這份文件的絕對 CPU 當基準線要小心，比較各格要看斜率與保留量，並在同一時段、同一棵樹上連續跑。**

## 二、相依足跡：「拿掉」要碰多少

數法：`grep -rlE "from '<套件>(/…)?'"` 掃 `apps/`、`packages/` 的 `.ts`／`.tsx`，排除 `node_modules`、`dist`；「測試」指路徑含 `.test.` 或 `fixtures` 的檔案。

| 套件 | 檔案數 | 其中測試／夾具 | 正式碼 |
| --- | --- | --- | --- |
| `@langchain/core` | 226 | 164 | 62 |
| `@langchain/langgraph` | 128 | 113 | 15 |
| `deepagents` | 47 | 29 | 18 |
| `@langchain/openai` | 13 | 12 | 1 |
| `@langchain/mcp-adapters` | 1 | 0 | 1 |
| **聯集** | **257** | 186 | **71**（約 428 個非測試 `.ts`／`.tsx` 檔中的 17%） |

正式碼的 71 個檔案裡，`packages/nexus-core` 31、`apps/harness` 28、其餘 12 個 `nexus-plugin-*` 各 1。

**這張表要這樣讀**：

- **測試佔大頭**（186／257），而且測試用 LangChain 的型別建構訊息與假模型——拿掉相依，測試夾具要整批改寫。這是真正的工作量，不是 71。
- **符號層面，最重的不是模型，是 middleware 與訊息型別**：我先前的符號統計裡 `createMiddleware` 約 27 處、`ToolMessage` 22、`tool` 19、`BaseMessage` 18、`AnyBackendProtocol` 11；`ChatOpenAI` 只有 1 處、`MultiServerMCPClient` 1 處、`createDeepAgent` 2 處。那份統計是 session 內的一次 `grep`，沒有存檔，要引用請重跑。
- `@langchain/langgraph-checkpoint` 與 `@langchain/langgraph-sdk` 雖然列在 `apps/harness/package.json`，**原始碼零 import**——它們是傳遞相依的顯式宣告，不是用到的東西。

## 三、標準那一側（dsh）與 Rust 專案（OpenBitFun）給了什麼證據

**dsh**：

- agent loop 本體是 `packages/core/agent-loop/src/*.ts`，合計 **2,425 行**；它的 `dependencies` 只有 `dsh-brand`、`dsh-util-values`、`schemastery`、`zod`——**沒有任何 LangChain 家族**。
- **更正我先前的說法**：我曾說 dsh 的模型層「走 pi-ai」。原文是：`llm-pi-ai` 的描述寫的是「pi-ai-backed DeepSeek adapter … (**design-verification twin** of dsh-llm-deepseek)」，也就是它是**驗證設計用的孿生**，主要的轉接器是 `packages/llm/llm-deepseek`（「DeepSeek Messages adapter」，掛在 Cordis 之下）。它直接用全域 `fetch` 打 `/messages`（`adapter.ts:120`），串流用 `eventsource-parser`（`sse.ts:3`、`:14`），**沒有任何廠商 SDK**；`src/` 合計 2,806 行。
- `native/` 底下是 C（`flock.c`、`main.c`、`link-entry.c`）與 landlock 相關程式，**沒有 Rust**（`find` 掃 `.rs`、`Cargo.toml` 零命中）。所以「dsh 為了資源管控而用 Rust」沒有證據；它在需要原生程式碼的地方（沙箱、檔案鎖）用的是 C。
- 這個對照要小心讀：`AGENTS.md` 的標準是「技術實現方法以 dsh 的實際做法為準，只有 deepagents／LangChain JS／LangGraph JS 表達不出來才退到最接近的實作」。**dsh 沒有 LangChain 家族**是事實，但本專案的基座本來就是在 [`development-plan.md`](development-plan.md) 裡選定的（全 TypeScript、LangChain JS＋LangGraph JS＋deepagentsjs）。所以拿掉它不是「補一條偏離標註」，而是**改動一個已寫進開發計劃的基座決定**，要走決議流程。

**OpenBitFun（Rust 專案）**：

- 它的核心迴圈是固定的具體型別，擴展點只能「提交貢獻」（見前一份調研）。**第三方插件（OpenCode 相容）是走外部 Bun 行程**，不在 Rust 核心裡。
- 這**提醒**一個張力：核心換成 Rust 之後，「萬物皆可插件」要靠行程邊界與固定的擴展點來換，而不是像 Cordis 那樣在同一個行程內掛一棵插件樹。**我沒有證據證明這是 Rust 造成的**（也可能是他們的產品選擇），只能說它同時出現。
- 所以若理念是 dsh 式的「連 agent loop 本身都是插件」，Rust 核心**不是**更近，而是更遠一步；要保留這個性質，得把 Rust 當成插件**內的實作語言**（例如 N-API 模組、sidecar 行程），而不是容器。

## 四、LangChain 基座已知的陷阱（要拿掉的理由，多半與效能無關）

下列都是我們實跑時遇過、已經修掉或繞過的，每條在記憶筆記有細節；**本篇沒有逐條重核**，只列名供「拿掉」的成本效益參考：

- 送回模型時丟掉推理區塊，只有部分模型回 400（已在 fetch 層照 dsh 改寫，[#592](https://github.com/DemianLi/nexus-agent/issues/592)）。
- `ChatOpenAI.withConfig` 會吃掉 `signal`；把 `signal` 交給 LangGraph 會丟下進行中的工具（本體在背景跑完、日誌缺結果）。
- v3 串流的工具拋錯會留下沒人接的 promise 殺行程；逐字片段不走 token 回呼，模型層收不到半段。
- `deepagents` 的「已內建」要 grep 驗；自長的 agent 不經折疊；`general-purpose` 子代理會丟 middleware。
- `@langchain/mcp-adapters` 2.0.0 的 `isError` 不再拋（已補回，[PR #1093](https://github.com/DemianLi/nexus-agent/pull/1093)）。

這些陷阱加起來說明：**基座的行為與我們的產品語意之間有一層一直在被我們補的縫**。這是拿掉它的真理由；這一節列的陷阱與效能無關，唯一與成本有關的是存檔點的保留與序列化，見 §一。

## 五、建議（判斷，不是決議）

1. **（已完成，[#1109](https://github.com/DemianLi/nexus-agent/pull/1109)）存檔點。** 當時的判斷是：`MemorySaver` 每步保留一份完整序列化狀態、不修剪，是記憶體平方成長與每輪 CPU 線性變長的主因（§1-2、1-3、1-4），而且與 LangChain 去留、與 Rust 都無關。結果證實了這個判斷，也證實「兩件要一起做」（見結論後的更新）。**當時列為「沒驗證」的前提——只留最新一份會不會破壞核准中斷、`resume`、背景子代理——PR #1109 用測試驗了**：核准與拒絕的來回、只留 1 份仍能續行都有測試，並用四項變異各弄壞一處確認測試會紅；它另外記了兩件副作用：每個結束的子代理命名空間會殘留一份小狀態，`getStateHistory` 與帶 `checkpoint_id` 的重放在這顆 saver 上不再可用（nexus 沒有任何地方使用，已 grep）。
2. **（已完成，[#1110](https://github.com/DemianLi/nexus-agent/pull/1110)）我們自己的 `token-estimate.ts`**：每輪寫 100 KB 的 profile 裡 `js-tiktoken` 佔 19%，全從這個檔案進來（§1-4）。我當時問「為什麼 #1094 的抽樣之後仍佔這麼多」沒有追到；答案是成本在編碼器而不在抽樣，換成 `gpt-tokenizer` 即解（見更新）。
3. **不要為了效能換 Rust。** 量到的熱點全是 JS 層的演算法與資料保留問題（存檔點、序列化、估算），沒有一處是「JS 做不到的事」。Rust 的合理位置仍是插件內的實作語言：只在 profile 指出某個具體熱點、且 TypeScript 最佳化動不了它時，才用 N-API 或 sidecar 換那一塊，不是換掉容器。 **兩個熱點最後都是用 TypeScript 層的改動修掉的**（換存檔點實作與存檔時機、換編碼器），這是對這一點最直接的事後證據。
4. **若要拿掉 LangChain，沿縫逐段，從最小的縫開始**：模型轉接器（1 個檔案碰 `ChatOpenAI`；dsh 自己是 `fetch`＋`eventsource-parser` 的自寫轉接器）→ MCP 轉接器（1 個檔案）→ **存檔點**（已由 #1109 處理，不再是拿掉 LangChain 的前置）→ 訊息型別與 middleware（最重，31＋28 個檔案）。每一段動工前先決定新契約是什麼，因為訊息型別與 middleware 的行為現在由 LangChain 的型別隱含定義，測試夾具也建在它上面（§二）。
5. **常駐記憶體**：閒置堆 70 MB、`footprint` 341 MB，224 MB 在 V8 的頁裡（§1-3）。要再動它之前，先拆開那 224 MB（主堆、程式碼空間、tsx 載入緒各多少）。現在**不知道**哪一塊最大。
6. **langfuse 不用處理**——零相依。若是想把追溯／觀測做起來，那是 [#1015](https://github.com/DemianLi/nexus-agent/issues/1015) 那張地圖在做的事，與這個決定無關。

## 六、查清楚了什麼、還沒查清楚什麼

**查清楚了**：框架成本隨歷史變長，以及它在哪（存檔點的序列化與保留，§一）；記憶體留在 `MemorySaver`（1,300 個存檔點，99%）；事件迴圈在短歷史下不吃緊；相依足跡的數字與數法（§二）；dsh 的 loop 規模、零 LangChain、零 Rust、自寫的 `fetch` 轉接器（§三）；nexus 有 Cordis 形狀的設定面但不 import Cordis。 **後續（2026-10-06 晚）**：只留最新存檔點不破壞核准中斷與 `resume`（#1109 的測試）；token 估算的熱點在編碼器，不在抽樣（#1110）。

**沒查清楚**（都可能改變 §五）：

- ~~只留最新存檔點會不會破壞核准中斷、`resume`、背景子代理~~：#1109 用測試驗了核准與 `resume`；**背景子代理**的覆蓋我沒有逐項核對 PR 的測試清單。
- `@langchain/langgraph` 版本對每輪 CPU 的影響（1.4.12 對 1.4.19，§1-8 沒隔離，只知道保留量不受版本影響）。
- ~~修掉存檔點後每輪 CPU 會不會回到常數~~：**不會完全持平**，約 2 倍成長（#1109，推測來源是反序列化最新那份，未單獨量證）；這個殘餘成長是新的待查項。
- 長歷史下並行的事件迴圈利用率；壓縮在長會話裡實際何時觸發。
- 閒置 224 MB 的 V8 頁怎麼分。
- 真模型、真檔案系統後端、子代理下的數字；Node 22 上的數字。
- ~~`token-estimate.ts` 在 100 KB 工具參數下仍佔 19% 的原因~~：編碼器（#1110）。
- #1109 自己記的未驗項：沒用真模型實跑；每個結束的子代理命名空間殘留一份小狀態；`projection-children.test.ts`、`trajectory-subagents-wire.test.ts` 偶爾 30 秒逾時（PR 內文說修前就會，建議另開卡）。
- 若拿掉 LangChain，`deepagents` 的檔案後端與子代理那一整層（我們多處依賴它的行為；用到的是 `CompositeBackend`／`StateBackend`／`FilesystemBackend`、四個 middleware、`createDeepAgent`，其餘多是型別）要自己補多少——**這一項沒有估價**。
