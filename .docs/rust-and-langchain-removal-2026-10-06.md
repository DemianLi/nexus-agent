# 拿掉 LangChain 家族、用 Rust 取代 Cordis？—— 先量，再拆成三個決定

這份筆記回答一個問題：「我們的理念跟 dsh 一樣是萬物皆可插件，所以想把 langchain／deepagents／langgraph／langfuse 移除，再用 Rust 取代 Cordis 取得更好的資源管控與效能」——這個方向值不值得走。它是 [`openbitfun-plugin-architecture-2026-10-06.md`](openbitfun-plugin-architecture-2026-10-06.md) 的後續：那份回答「Rust 專案是不是萬物皆可插件」，本篇回答「我們該不該換成 Rust」。我方現況見 [`plugin-architecture-gap-survey.md`](plugin-architecture-gap-survey.md)。

**調研日期**：2026-10-06。對讀版本：nexus `0e759edd`（develop）；dsh `5badb15009ae1756c3afe0ae0cef1faafc290ccc`（`references/deepseek-harness`，HEAD 日期 2026-10-03，這次**沒有**重新 fetch）；OpenBitFun `18aa5441d89f5e24cfb4d8ff54d4b53d92c68896`。

## 結論

**這個問題其實是三個決定，不能一起答。** 它們的證據、成本與可逆性都不同：

| 決定 | 建議 | 一句話理由 |
| --- | --- | --- |
| ① 用 Rust 重寫編排層（取代 Cordis 那一側） | **現在不做** | 量到的框架開銷是每輪約 70 ms CPU、約 2.7% 的單核；模型一輪要 2.6 秒以上（假端點給的下限，真模型更長）。Rust 能動的是那 70 ms 的一部分，而且我們還不知道那 70 ms 花在哪 |
| ② 移除 LangChain／deepagents／langgraph | **可以做，但那是另一個問題**，理由是「標準那一側根本沒有它」，不是效能；要沿縫逐段換，不是一次拿掉 | dsh 的 agent loop 是 2,425 行自己的 TypeScript，零 LangChain 相依；我方正式碼有 71 個檔案碰它 |
| ③ langfuse | **不適用** | nexus 的程式碼與 `package.json` 裡一個 `langfuse` 都沒有（`grep` 掃 `apps/`、`packages/` 的 `.ts`／`.tsx`／`.json`，零命中） |

**要先更正一句我先前的說法**：我曾說「nexus 沒有 Cordis」。精確版本是：**nexus 沒有 import Cordis 這個套件**（`from 'cordis'` 零命中），但它**有一個 Cordis 形狀的設定面**——`apps/harness/cordis.yml`（45 條插件條目（`grep -c "- id:"`））、`cordis.patch.yml` 疊層、`--dump-config`，組裝在 `apps/harness/src/assembly-root.ts`；插件容器是我們自己寫的 `PluginRegistry`（`packages/nexus-core/src/fold.ts` 一帶）。所以「用 Rust 取代 Cordis」在我方的實際意思是**重寫我們自己的容器、折疊器與所有插件**，不是換掉一個相依。

## 這份筆記的來源與可信度

| 區塊 | 誰做的 | 核對狀況 |
| --- | --- | --- |
| §一 量測 | 主代理跑 | 第一手；原始資料在 session 暫存區（`results.jsonl`，13 次執行），**不進 repo**。數字是這次量到的，不是推論 |
| §二 相依足跡 | 主代理 `grep` | 第一手；數法寫在表下，可重跑 |
| §三 dsh 與 OpenBitFun 的證據 | 主代理讀 | 第一手；dsh 的 `llm-pi-ai` 說明已讀原文（見 §三的更正） |
| §四 已知的 LangChain 基座陷阱 | 記憶筆記彙整 | **沒有逐條重核**；每條都曾在實跑中遇到並修過，但本篇只列名，不重新驗證 |
| §五 建議 | 判斷 | 不是事實，不是決議 |

**這份筆記沒有子代理的產出。**

## 一、量測：框架自己吃多少

**量什麼**：真的 `apps/harness/src/serve.ts --live`（產品入口，走產品的 wire 協定），模型端指向一個假的 OpenAI 相容串流端點。每一輪是「模型先呼叫一個工具、收到結果後再串流一段回覆」（兩次模型呼叫、約 106～149 個 wire 事件）。CPU 取 `ps -o time` 對 serve 行程樹求和，RSS 同法取樣。**假端點是獨立行程，它的 CPU 沒算進去。**

| 場景 | 結果（取重複次數的範圍） |
| --- | --- |
| 開機（啟動到可服務） | 約 0.64～0.79 秒、啟動 CPU 約 0.9～1.1 秒；閒置 RSS **286 MB** |
| A. 假端點零延遲、同一會話連跑 40 輪 | 每輪 CPU 中位數 **40 ms**（p95 110 ms）、牆鐘 48～52 ms；3 次重複一致 |
| B. 30 個新會話各一輪 | 每輪 CPU 中位數 20～30 ms（p95 120～130 ms） |
| C. 10 條並行 × 3 輪 | 30 輪共 0.88～1.0 秒牆鐘、總 CPU 620～830 ms（約 21～28 ms／輪） |
| D. 模擬真模型延遲（首字 400 ms、每 chunk 15 ms，約 2.6 秒／輪）、單會話 8 輪 | 每輪 CPU 中位數 **70 ms**（約 2.7% 的單核）；2 次重複一致 |
| E. 同上延遲、10 條並行 × 2 輪 | 20 輪共 6.0 秒牆鐘、總 CPU 1,050～1,140 ms（約 52～57 ms／輪，**約 18% 的單核**）；峰值 RSS 438 MB |

**怎麼讀**：

- 框架本身的成本是**每輪幾十毫秒的 CPU**。拿模型延遲（秒級，真模型在 2.6 秒以上）去比，框架佔的是個位數百分比。這是量到的，不是估的。
- 常駐的 286 MB 是比較可能「資源管控」有感的那一格。**我另外量了拆解**：裸 Node 進程 46 MB；載入 `@langchain/core`、`@langchain/openai`、`@langchain/langgraph`、`deepagents` 四個套件後 **147 MB**（3 次一致，約 +100 MB）。也就是閒置 RSS 的約 240 MB 超出量裡，**約 100 MB 是這四個套件的載入成本，其餘約 140 MB 沒有歸屬**（可能是 tsx 即時轉譯、其他插件、QuickJS、web 靜態資源，**我沒有逐項量**）。`@langchain/mcp-adapters` 解析不到（它只裝在 `nexus-plugin-mcp` 底下），沒算進去。
- A 場景連跑 43 輪後 RSS 從 286 升到約 510 MB；但 D 場景（8 輪）峰值 401～416 MB 之後**回到 291 MB**，所以這個成長至少部分是尚未回收的垃圾。**它是洩漏還是 GC 延遲，我沒有分開**（沒做強制 GC 的對照）。

**這個量測沒有回答的**（誠實列出，因為每一條都可能讓數字變壞）：

1. **模型是假的、歷史極短。** 每輪只有一句話加一個工具結果。長上下文才會有的成本（token 估算、壓縮、事件日誌放大）完全沒進來；那些成本在真實使用裡才大（例如 [#1094](https://github.com/DemianLi/nexus-agent/pull/1094) 修的就是長文估算的熱點）。
2. **跑在 `tsx` 下，不是建置產物。** 即時轉譯會多吃啟動時間與 RSS，所以閒置 286 MB 偏高、開機時間偏長。
3. **`ps` 的 CPU 解析度是 10 ms**，單輪數字有量化誤差，所以我只引中位數與重複一致的範圍，不引單輪差異。
4. **跑的時候機器有負載**（1 分鐘平均 1.9～8.3）。D 的兩次重複分別在 2.6 與 8.3 負載下跑，中位數都是 70 ms，所以負載沒有主導中位數；p95 沒有這個保證。
5. **沒量事件迴圈延遲**（並行時某一條會不會卡到另一條）。E 場景的牆鐘是 2.69 秒對 2.58 秒的單條，沒看到明顯排擠，但那不是延遲分佈。
6. **沒有分解那 70 ms**。它是 SSE 解析、LangChain 訊息轉換、事件折疊、日誌寫入還是別的，**沒做 profile，不能說是 LangChain 的成本**。
7. Node 是 25.9.0；專案 `engines` 寫 `>=22.19`。

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
- **更正我先前的說法**：我曾說 dsh 的模型層「走 pi-ai」。原文是：`llm-pi-ai` 的描述寫的是「pi-ai-backed DeepSeek adapter … (**design-verification twin** of dsh-llm-deepseek)」，也就是它是**驗證設計用的孿生**，主要的轉接器是 `packages/llm/llm-deepseek`（「DeepSeek Messages adapter」，掛在 Cordis 之下）。我沒有讀 `llm-deepseek` 底層用什麼 HTTP 客戶端。
- `native/` 底下是 C（`flock.c`、`main.c`、`link-entry.c`）與 landlock 相關程式，**沒有 Rust**（`find` 掃 `.rs`、`Cargo.toml` 零命中）。所以「dsh 為了資源管控而用 Rust」沒有證據；它在需要原生程式碼的地方（沙箱、檔案鎖）用的是 C。
- 這個對照要小心讀：`AGENTS.md` 的標準是「技術實現方法以 dsh 的實際做法為準，只有 deepagents／LangChain JS／LangGraph JS 表達不出來才退到最接近的實作」。**dsh 沒有 LangChain 家族**是事實，但本專案的基座本來就是在 [`development-plan.md`](development-plan.md) 裡選定的（全 TypeScript、LangChain JS＋LangGraph JS＋deepagentsjs）。所以拿掉它不是「補一條偏離標註」，而是**改動一個已寫進開發計劃的基座決定**，要走決議流程。

**OpenBitFun（Rust 專案）**：

- 它的核心迴圈是固定的具體型別，擴展點只能「提交貢獻」（見前一份調研）。**第三方插件（OpenCode 相容）是走外部 Bun 行程**，不在 Rust 核心裡。
- 這**提醒**一個張力：核心換成 Rust 之後，「萬物皆可插件」要靠行程邊界與固定的擴展點來換，而不是像 Cordis 那樣在同一個行程內掛一棵插件樹。**我沒有證據證明這是 Rust 造成的**（也可能是他們的產品選擇），只能說它同時出現。
- 所以若理念是 dsh 式的「連 agent loop 本身都是插件」，Rust 核心**不是**更近，而是更遠一步；要保留這個性質，得把 Rust 當成插件**內的實作語言**（例如 N-API 模組、sidecar 行程），而不是容器。

## 四、LangChain 基座已知的陷阱（要拿掉的理由，不是效能）

下列都是我們實跑時遇過、已經修掉或繞過的，每條在記憶筆記有細節；**本篇沒有逐條重核**，只列名供「拿掉」的成本效益參考：

- 送回模型時丟掉推理區塊，只有部分模型回 400（已在 fetch 層照 dsh 改寫，[#592](https://github.com/DemianLi/nexus-agent/issues/592)）。
- `ChatOpenAI.withConfig` 會吃掉 `signal`；把 `signal` 交給 LangGraph 會丟下進行中的工具（本體在背景跑完、日誌缺結果）。
- v3 串流的工具拋錯會留下沒人接的 promise 殺行程；逐字片段不走 token 回呼，模型層收不到半段。
- `deepagents` 的「已內建」要 grep 驗；自長的 agent 不經折疊；`general-purpose` 子代理會丟 middleware。
- `@langchain/mcp-adapters` 2.0.0 的 `isError` 不再拋（已補回，[PR #1093](https://github.com/DemianLi/nexus-agent/pull/1093)）。

這些陷阱加起來說明：**基座的行為與我們的產品語意之間有一層一直在被我們補的縫**。這是拿掉它的真理由。它跟效能無關。

## 五、建議（判斷，不是決議）

1. **不要為了效能換 Rust。** 先把那 70 ms 分解（profile 一次：CPU profile 看 SSE 解析、訊息轉換、折疊、日誌各佔多少）。若前三名都落在 LangChain 的轉換層，那是「拿掉 LangChain」的效益，與 Rust 無關；若落在我們自己的折疊或日誌，那是我們自己的 TypeScript 可以先最佳化的。**不管哪一種，都不需要 Rust 才能動到。**
2. **若要拿掉 LangChain，沿縫逐段，並且從最小的縫開始**：模型轉接器（正式碼只有 1 個檔案碰 `ChatOpenAI`，dsh 自己也有一個自寫的轉接器可抄形狀）→ MCP 轉接器（1 個檔案）→ 訊息型別與 middleware（最重，31＋28 個檔案）。**每一段動工前先決定新契約是什麼**（訊息型別與 middleware 的行為現在由 LangChain 的型別隱含定義，測試夾具也建在它上面，見 §二）。
3. **若在意常駐記憶體**，下一步量的是那沒有歸屬的約 140 MB（先用建置產物而不是 `tsx` 重量一次），再決定要不要動。這一格比 CPU 更可能有東西，但現在**還不知道**。
4. **Rust 的合理位置**是插件內的實作語言：只在 profile 指出某個具體的熱點、且 TypeScript 最佳化不動它的時候，才用 N-API 或 sidecar 換掉那一塊。不是換掉容器。
5. **langfuse 不用處理**——零相依。若是想要「把追溯／觀測做起來」，那是 [#1015](https://github.com/DemianLi/nexus-agent/issues/1015) 那張地圖在做的事，與這個決定無關。

## 六、查清楚了什麼、還沒查清楚什麼

**查清楚了**：框架每輪 CPU 與記憶體的量級（§一）；相依足跡的數字與數法（§二）；dsh 的 loop 規模、零 LangChain、零 Rust（§三）；nexus 有 Cordis 形狀的設定面但不 import Cordis。

**沒查清楚**（都可能改變 §五）：

- 那 70 ms 花在哪；閒置 286 MB 裡約 140 MB 的歸屬。
- 長上下文、壓縮、真工具 I/O 下的框架成本（這次量的是最輕的情況）。
- A 場景的記憶體成長是洩漏還是 GC 延遲。
- 建置產物（非 `tsx`）下的數字。
- dsh 的 `llm-deepseek` 底層的 HTTP 與串流處理方式。
- 若拿掉 LangChain，`deepagents` 的檔案後端與子代理那一整層（我們多處依賴它的行為）要自己補多少——**這一項沒有估價**，是 §五第 2 點的最大風險。
