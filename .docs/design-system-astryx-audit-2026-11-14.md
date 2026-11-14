# nexus web 設計系統成熟度檢驗：對照 Meta Astryx

2026-11-14。nexus 以 `origin/develop` `1ef6ca6c` 為準；Astryx 以當天讀到的 wiki 與文件站為準（它是 0.x Beta，內容會改）。

## 結論

**還不是成熟的設計系統，但差的不是規則，是規則在哪一刻生效。**

- nexus 的規則數量與精細度不輸 Astryx：顏色全走語意 token、對比度由產生器解出再用測試驗、無障礙目標同為 WCAG 2.2 AA、護欄的例外清單只會變少。
- 最大的單一缺口：**這些護欄幾乎都不擋 feature → develop 的合併**。照本次判準（只有擋合併的機械強制算及格），token 紀律、無障礙、vendor 完整性三軸都因此不及格。
- 第二類缺口是 Astryx 有、nexus 完全沒有的：視覺回歸、高對比模式（forced-colors）、棄用流程、嵌入版對外契約的版本保護、遮罩色的語意 token。
- 抽樣五個元件，只有兩個達到 B 且 0 個 BLOCK（`Surface`、`<nexus-chat>` 主題契約），都是 nexus 自己寫的。三個來自 SG 的都沒過，其中 `AlertDialog` 有 2 個 BLOCK。**分數的落差幾乎全部來自 vendor 不受護欄管。**

## 尺與判準

**尺**（Astryx，Meta 開源，MIT，React 19＋StyleX）：

| 來源 | 用在哪 | 讀法 |
| --- | --- | --- |
| [All Tokens](https://astryx.atmeta.com/docs/tokens) | token 類別與尺度 | 原文全讀 |
| [Component Audit Rubric](https://github.com/meta/astryx/wiki/Component-Audit-Rubric) v1.16.6 | 評分規則、11 節檢查項、等第 | 評分規則與檢查項清單讀原文；各節 5／3／1 錨點只讀到 1／5 與部分 3／5 |
| [Accessibility Checklist](https://github.com/meta/astryx/wiki/Accessibility-Checklist) | 無障礙門檻、CI 強制範圍 | 抽查原文 |
| [Component Lifecycle](https://github.com/meta/astryx/wiki/Component-Lifecycle)、[Contributing](https://github.com/meta/astryx/wiki/Contributing) | lab／core、貢獻流程 | 抽查原文 |
| [Design Conventions](https://github.com/meta/astryx/wiki/Design-Conventions)、[API Conventions](https://github.com/meta/astryx/wiki/API-Conventions) | 設計與 API 慣例 | 抽查原文 |
| [Release Process](https://github.com/meta/astryx/wiki/Release-Process)、[Vibe Evaluation](https://github.com/meta/astryx/wiki/Vibe-Evaluation) | 發版、AI 生成品質評測 | 抽查原文 |

**判準**（demian 2026-11-14 拍板）：

- 對象：`apps/web` 的 token、元件、規則，加上嵌入版 `<nexus-chat>` 的主題契約。
- 每條規則記四級：**A** 擋合併的機械強制／**B** 有機械檢查但合併後才跑／**C** 成文、靠自律／**D** 只存在於程式碼慣例或沒有。**只有 A 算及格。**
- 綁 React／StyleX 的條目只量意圖；產品用不到的標「不適用」。
- vendor（solid-glass，以下稱 SG）的缺口與 nexus 自己的缺口分開列。
- 已拍板的差異另列一節，不算缺口。
- 系統層不打總分；元件抽樣照 Astryx 的門檻：B（80 分）以上且 0 個 BLOCK。

**這把尺的限制**：

- Rubric 是 Astryx 自訂自評，而且寫明「No pull request is gated on a score」：分數本身在 Astryx 也不擋 PR，擋的是 lint、測試、build、axe 這些快檢查。
- Astryx 自己也有未解的系統性缺口：Rubric 記載全系統的 WCAG AA 對比度不合格（它的 #4652）正在處理中。它不是滿分的標準答案。
- 來源沒寫的：棄用時程、內部採用率的量法、輔助科技與瀏覽器的測試矩陣。這三項不當作 Astryx 標準。

## 系統層對照

### 1. token 類別覆蓋

Astryx 只有一層語意 token，不對外開 primitive 色票；nexus 也是（`.docs/web-ui-spec.md:155`「語意 token 直接寫值，不另建色板層」）。這點一致。

| 類別 | Astryx | nexus | 級 |
| --- | --- | --- | --- |
| 顏色 | 角色命名，`light-dark()` 切換 | 語意 token，`.dark` class 切換；11 色由產生器輸出亮暗成對（`apps/web/src/styles/tokens.generated.css`） | B |
| 狀態色 | 每種狀態六個（底、muted、on-、text-、icon-、border-） | SG 有 `--status-*` 6 個、`--success`；沒有按表面分的成套規則 | D |
| 語法高亮 | 19 個，預設值引用語意色 | `styles/shiki.css` 11 個 `--shiki-*`，SG 另有 `--syn-*` 8 個 | 沒核對是否引用語意色 |
| 資料視覺化 | 56 個 | SG 帶了 `--chart-*` 10 個 | 不適用 |
| 間距 | `--spacing-0`…`12`，4px 一階，有半階 | 用 Tailwind 預設級距；沒有成文規則，護欄不管間距 | D |
| 控制項高度 | `--size-element-sm/md/lg` 28／32／36 | 寫在 SG 元件的 cva 裡（`h-6`…`h-9`），沒有 token | D |
| 焦點環 | 4 個 token，全系統共用 | 成文（`web-ui-spec.md:189`）；`focus-outline`、`focus-ring-suppression`、`focus-line-suppression` 三支測試 | B |
| 圓角 | 按角色命名，隨主題倍率縮放 | `--radius` 階梯與 `--radius-row`；護欄擋任意值圓角 | B |
| 陰影 | 三階高度＋輸入框狀態環 | 沒有具名階梯；`border-shadow`、`shadow-alpha` 兩支測試管畫法 | B（部分） |
| 動效 | duration 三檔各有 min／max、easing 四條、主題兩個旋鈕 | 刻意不設 token，見〈已拍板的差異〉 | — |
| 字體排印 | 12 階字級＋角色層（H1–H6、Body、Label…） | 四階（`--text-ui`、`body`、`tip`、`micro`，各帶行高）與兩個字重（`apps/web/src/index.css:44-101`）；`type-hierarchy` 測試 | B，vendor 不受管 |

### 2. token 紀律

| 項目 | Astryx | nexus | 級 |
| --- | --- | --- | --- |
| 不寫原始色 | lint `@astryx/no-raw-color`，core 裡是 error | `design-system.test.ts:75-129` 擋色板、色碼、色彩函式；產品碼實測 0 處 | B |
| 字級、圓角、時長、字重 | lint＋Night Watch | 同一支測試擋 | B |
| 間距在級距上 | Design Conventions 🟢 自動 | 沒有 | D |
| 例外管理 | — | 允許清單只列積木自己；列了卻不再命中會報錯 | B |
| vendor 受不受管 | 不適用（沒有 vendor） | **不受管**：SG 元件裡 `text-sm`×41、`text-xs`×17、`text-base`×8，任意字級 20 處共 7 種（12.5px×6、12px×4、13px×3、11.5px×3、11px×2、0.8rem、0.625rem） | D |
| token 命名規則 | `--[_]<component>[-<part>]-<property>`，`--_` 為私有 | 沒有成文，名字照 shadcn 與 SG | D |

**B 而不是 A 的原因**：feature → develop 走輕的模式，只跑改到的測試檔與改到的原始檔的同名測試（`.github/scripts/plan_ci.py:150-165`），`apps/web/guard/` 直接排除（`:108`）。`test-web` 與 `static`（含 build 後的 CSS 檢查、`guard`）只在全跑時跑（`.github/workflows/ci.yml:265`、`:447`）。所以在某個元件裡寫 `bg-red-500` 的 PR 過得了 gate，要到合併後那一輪才紅。這是 #2088（gate 60 秒）的刻意取捨，但照本次判準不算及格。

### 3. 元件 API 慣例

| 項目 | Astryx | nexus | 級 |
| --- | --- | --- | --- |
| 成文的 props 命名規範 | 有（`is`／`has`、`on{Verb}`、`start`／`end`、`default*`），多條由 lint 強制 | 沒有通用規範；沿用 shadcn／Base UI 的命名。`apps/web/COMPONENTS.md:82-112` 只規定浮層、工具卡、狀態列的寫法 | C（部分） |
| variant／size 型別由來源導出 | 要求 | cva 的 `VariantProps`，已做到 | D（慣例） |
| 其餘 props 轉給主元素、`className` 合併 | 要求，BLOCK 級 | `{...props}` 與 `cn` 合併，已做到 | D（慣例） |
| `ref` 當一般 prop | lint 禁 `forwardRef` | React 19；`Surface` 已照做 | D（慣例） |
| 匯出的 prop 有 JSDoc | 要求 | 自製積木有（中文）；SG 元件沒有 | D |

### 4. 無障礙

| 項目 | Astryx | nexus | 級 |
| --- | --- | --- | --- |
| 目標 | WCAG 2.2 AA，不要求 AAA | 同（`.docs/web-ui-spec.md:261`） | C |
| axe | 每個 PR 跑（`pr-a11y`），另每週全量 | 29 個測試檔用 `apps/web/src/test/axe.ts`；jsdom 沒有版面，`color-contrast` 關掉；真瀏覽器裡沒有 axe | B |
| 對比度 | 每個有意義的前景／背景配對都要量 | `tokens-contrast.test.ts` 加 `guard/` 在真 Chrome 逐字量 | B |
| live region | lint 禁手寫 `aria-live` | `live-region.test.ts`：只准狀態列用 `role="status"`，vendor 不放行 | B |
| reduced-motion | 進出場動畫要守 | `reduced-motion.test.ts` 加 build 後的 CSS 檢查 | B |
| 高對比模式（forced-colors） | 新元件 BLOCK 級（A14） | **沒有**：`apps/web/src` 的 css 與 tsx 搜 `forced-colors` 命中 0 | D |
| 觸控目標 24×24 | AA，有五個例外 | 沒核對有沒有成文或測試 | 沒核對 |
| 真機輔助科技 | 宣稱了相關行為才要求 | VoiceOver 沒走過（盤點報告引 `web-ui-spec.md:371`，沒核對原文） | D |

### 5. 測試與視覺證據

| 項目 | Astryx | nexus | 級 |
| --- | --- | --- | --- |
| 元件旁有測試檔 | 要求，BLOCK 級 | `components/ui/` 有 32 個元件、18 個測試檔，不是一對一（例如 `alert-dialog` 沒有自己的測試檔，由使用它的畫面測） | 部分 |
| 測公開契約、ARIA、鍵盤、焦點 | 要求 | 有做，深度不一 | B |
| 真瀏覽器量測 | Storybook＋Playwright | `apps/web/guard/` 4 個檔 93 條 | B |
| 視覺變更附前後截圖 | 要求（V15）；穩定版要 `pr-visual` 證據 | 沒有基準比對；e2e 截圖只當 artifact 上傳 | D |
| 元件展示 fixture | Storybook，每個狀態都要到得了 | 沒有給人瀏覽的展示站。`guard/main.tsx` 是給測試量的渲染頁，用網址參數切畫面與亮暗，功能上算「瀏覽器證據面」，但狀態覆蓋不全：Button 只渲染 default 尺寸，hover 只量 destructive；Surface 的 `raised`／`stage` 沒有直接斷言 | B（部分） |

### 6. 生命週期與治理

| 項目 | Astryx | nexus | 級 |
| --- | --- | --- | --- |
| 元件分級 | `lab`（只發 canary）／`core` | 沒有分級 | D |
| 新元件的入口 | RFC → 規格 → design brief → lab → 畢業 | 「什麼時候抽」寫在 `COMPONENTS.md:74-80`；新增一階 token 要先改規格（`:31`） | C |
| 擁有者 | team 有最終決定權；CODEOWNER 清 review-required | 沒有 CODEOWNERS；實際由 dev-ui 擁有，寫在卡上不在 repo 裡 | D |
| 棄用 | `@deprecated` 指名替代、至少留一版 | 沒有：web 的五份文件搜「棄用／deprecat／淘汰」命中 0 | D |
| vendor 上游管理 | 不適用 | commit 固定、逐條登記本地修改、有同步流程（`apps/web/src/vendor/solid-glass/README.md`）。這一項 nexus 比 Astryx 多做 | B |

### 7. 版本與不相容變更

| 項目 | Astryx | nexus | 級 |
| --- | --- | --- | --- |
| 不相容變更的標記 | `[breaking]` changeset＋jscodeshift codemod | 升級指南（`docs/release.md:25-41`），gate 驗格式 | A（格式） |
| 涵蓋設計系統的對外介面 | theme target、catalog key 都算公開面 | **不涵蓋**：升級指南的範圍沒有列 `<nexus-chat>` 的屬性、事件與 `--nexus-*`；`docs/upgrade-guide/` 四個版本目錄裡沒有任何一份提到 `nexus-chat` | D |

### 8. 文件

| 項目 | Astryx | nexus | 級 |
| --- | --- | --- | --- |
| 設計規則成文 | wiki 多頁 | `.docs/web-ui-spec.md`、`apps/web/COMPONENTS.md`、`.docs/web-design-style.md`、vendor README | C |
| 逐元件文件 | 每個元件一份 `.doc.mjs`，要能過型別檢查；文件寫了元件沒有的 prop 算 BLOCK | 沒有一元件一份的檔，內容散在 JSDoc 與 `COMPONENTS.md`，完整度不一：`Surface`、`TurnStatus` 看文件就知道怎麼用；`Button` 的 8 種尺寸與 destructive／glass／link 三種 variant 何時用，原始碼以外沒寫。沒有任何檢查保證文件與 props 一致 | C（部分） |
| 文件跟現況一致 | docs 與程式同一個 diff 改，有檢查 | **多處過期**，見缺口 G4 | D |

### 9. AI 生成品質評測

Astryx 每晚跑 Vibe Evaluation：讓沒有背景知識的 agent 用它的元件生成畫面，六個維度打分，並和 shadcn／Tailwind、純 HTML 對照，看趨勢。nexus 的 web 程式碼幾乎全由 agent 寫，卻沒有任何對應的量測。級：D。

## 已拍板的差異（不算缺口）

| 項目 | Astryx | nexus | 出處 |
| --- | --- | --- | --- |
| 動效 token | duration、easing 都是 token，主題可調 `tempo` 與 `character` | 不設 token；模式清單封閉，元件只准用 Tailwind 的 `duration-*` 級距，曲線寫在 `motion.css` | `.docs/web-ui-spec.md:216`；決策單 D21（沒核對原文） |
| 元件來源 | 自己寫 | 原樣 vendor SG，修改寫在覆寫檔 | #1468 |
| CI 兩種模式 | 每個 PR 跑 lint、測試、build、axe | 輕的模式只跑相關檢查，完整一輪在合併後 | #2088 |

D21 有一個前提會變的情況：嵌入版若要讓宿主調動效，就需要動效 token。目前只開放四個屬性，不受影響。

CI 兩種模式是拍板過的取捨，但它正是本次最大缺口的成因，所以同時列在缺口 G1；要不要重新衡量由 demian 決定。

## 抽樣元件

照 Rubric 的算法：每節 0–5 分乘權重，滿分 100；A 90 以上、B 80–89、C 70–79、D 60–69；有未解的 BLOCK 最高 C。

**先讀這幾點再看分數**：

- 分數是我一個人照「意圖」打的一輪判斷，誤差至少正負 5 分。Rubric 約 200 條檢查裡很多綁 StyleX 與 Astryx 自己的 hook，對不上的不計。
- 三節沒有計分、權重按比例分給其他節：§5b 畫面判斷（沒有截圖，Rubric 規定寫「沒量」不寫 0）、§7 程式健康（這幾個元件幾乎沒有 effect 與 state，照 Rubric 算「limited」）、§9 i18n 與 RTL（產品單一語系，不適用）。
- BLOCK 另派一支子代理獨立複核。複核推翻了我一條初判，另一條我與複核意見不同，都寫在下面。

| 元件 | 來源 | §1 無障礙 | §2 主題化 | §3 API | §4 行為 | §5a 設計 | §6 測試 | §8 文件 | §10 響應式 | 總分 | BLOCK | 等第 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Surface` | 自製 | 4.5 | 4.5 | 4.5 | 4.5 | 4.5 | 4 | 3.5 | 4.5 | 87 | 0 | B |
| `<nexus-chat>` 主題契約 | 自製 | 4.5 | 3.5 | 3.5 | 4 | 不計 | 4.5 | 4 | 4.5 | 80 | 0 | B（壓線） |
| `TurnStatus` | SG＋薄包裝 | 4.5 | 3.5 | 4 | 4 | 3 | 3.5 | 3.5 | 4 | 77 | 0 | C |
| `Button` | SG 原樣轉出 | 4 | 3.5 | 3.5 | 4 | 3.5 | 3.5 | 2 | 4 | 71 | 0 | C |
| `AlertDialog` | SG＋薄包裝 | 4 | 3 | 3.5 | 4 | 3.5 | 2.5 | 2.5 | 3.5 | 68 | 2 | D |

**BLOCK 兩條，都在 `AlertDialog`**：

1. **遮罩寫了原始色**（Rubric T1、D8）。`apps/web/src/vendor/solid-glass/components/ui/alert-dialog.tsx:31` 的遮罩是 `bg-black/10`，覆寫檔與 patch 都沒有改它的顏色，出貨畫面上生效。`dialog` 與 `sheet` 的遮罩寫法相同。專案沒有遮罩用的語意 token，而 `apps/web/COMPONENTS.md:19` 自己就把 `bg-black/50` 列為禁止的寫法；`design-system.test.ts` 因為放行 vendor 而沒擋到。
   - 複核子代理認為不該算 BLOCK：功能沒壞，只是暗色加上不透明模式下遮罩幾乎看不出來（它手算亮度比約 1.01:1，沒在瀏覽器裡量）。
   - 我仍記為 BLOCK：Rubric 把原始色列為 bright-line，原文寫「沒有合適的 token 不是例外」。兩種看法並列，由讀者判斷。
2. **浮層的焦點管理沒有測試**（Rubric V7，對浮層是 BLOCK）。會開啟這個框的測試有五條，只有 `apps/web/src/App.seats.test.tsx:571` 一條斷言焦點落在「取消」；「焦點困在框內」與「關閉後焦點回到觸發元素」都沒有測試。這一條的事實出自複核子代理，沒有第二輪複核。

**被複核推翻的初判**：我原本把「沒有逐元件文件、沒有展示 fixture」判為全部元件共有的 BLOCK。Rubric X9 的原文是「元件沒有瀏覽器證據面時才 BLOCK」，而四個元件在 `guard/main.tsx` 都有真瀏覽器渲染，所以降為一般缺口（G2）。

**敏感度**：`AlertDialog` 兩條 BLOCK 都修掉、其他不動，估計約 72 分，仍是 C。`Button` 若補齊尺寸與 variant 的文件與 fixture，估計約 75 分，仍是 C。要到 B，兩者都還得處理 SG 帶進來的任意字級與原始值。

**扣分集中在哪**：

- SG 元件的任意值：`Button` 的 `sm` 尺寸寫 `text-[0.8rem]`，`TurnStatus` 寫 `text-[12.5px]`，都不在四階字級內。
- SG 元件沒有 JSDoc，`Button` 的尺寸與三種 variant 沒有任何使用說明。
- `<nexus-chat>` 的主題契約：亮暗不能分開給值、`--nexus-font` 繞過 token、對外介面不在升級指南範圍內。它做得好的是對比不足就不套並警告，這點比 Astryx 嚴（Astryx 的主題 key 對不到目標時是靜默失敗）。

## 缺口清單

大小：S 約一張 PR；M 兩三張；L 需要先設計。排序依「對結論的影響」。

| # | 缺口 | 來源 | 建議修法 | 大小 | 擁有者 |
| --- | --- | --- | --- | --- | --- |
| G1 | 設計護欄不擋合併 | 自己 | 輕的模式在 PR 動到 `apps/web/src/**` 的 tsx／css 時，加跑 `src/styles/*.test.ts` 與 `ui/registry-edits.test.ts`（都是 jsdom）；真瀏覽器的 `guard/` 留在合併後。先量加跑的秒數，對照 #2088 的 60 秒預算 | S–M | CI 腳本的擁有者＋dev-ui |
| G2 | vendor 元件不受設計護欄管，遮罩寫原始色 | 上游 | 加一個遮罩用的語意 token，用覆寫檔套到 `dialog`、`alert-dialog`、`sheet` 三處；`guard/` 加量遮罩在暗色不透明模式下看不看得出來 | S–M | dev-ui |
| G2b | 浮層的焦點困住與歸還沒有測試 | 自己 | 補 `AlertDialog` 的兩條測試；`guard/` 的頁面一載入就是開啟狀態，測不到歸還，要在 jsdom 測 | S | dev-ui |
| G2c | 元件文件不齊、展示 fixture 狀態覆蓋不全 | 自己 | `COMPONENTS.md` 補 `Button` 的尺寸與 variant 用法；`guard/main.tsx` 補各尺寸與 disabled、hover | S–M | dev-ui |
| G3 | 嵌入版主題契約沒有版本保護 | 自己 | `docs/release.md` 升級指南的範圍加上 `<nexus-chat>` 的屬性、事件、`--nexus-*` | S | 文件擁有者＋dev-ui |
| G4 | 文件過期 | 自己 | 改 `apps/web/AGENTS.md:7` 與 `.docs/web-ui-spec.md:50`（仍寫「元件目前仍是 Radix 版」，實際 `@radix-ui` import 為 0）、`apps/web/GLOSSARY.md:8`、`:24`（仍以 shadcn registry 與 Libraries.dev 為準） | S | dev-ui |
| G5 | vendor 字級超出四階 | 上游 | 二選一：把規格的字級階梯擴到涵蓋 SG 實際用的，或用覆寫檔收斂。先決定哪一個才是真相 | M | dev-ui |
| G6 | disabled 透明度規格寫 `.6`、實作是 50 | 上游＋自己 | 改規格或加覆寫，擇一；SG 元件 17 處 `disabled:opacity-50`，產品碼 `transcript.tsx:118` 是 50、`goal-bar.tsx:86` 是 60 | S | dev-ui |
| G7 | 高對比模式沒有支援 | 上游＋自己 | 先量：Windows 高對比下焦點、選取、狀態色還看不看得出來，再決定補哪些。目標客戶是公務機關，這項的權重比一般產品高 | M | dev-ui |
| G8 | 間距沒有規則也沒有護欄 | 自己 | 成文一條「只用級距」，`design-system.test.ts` 加擋任意值間距 | S | dev-ui |
| G9 | 沒有 token 命名規則與 props 命名規範 | 自己 | 各寫一節進 `COMPONENTS.md`，把現有慣例寫下來即可，不必改名 | S | dev-ui |
| G10 | 沒有棄用流程，擁有者不在 repo 裡 | 自己 | `COMPONENTS.md` 加一節；要不要 CODEOWNERS 由 PM 定 | S | dev-pm |
| G11 | 沒有視覺回歸 | 自己 | 現有 e2e 截圖已有，缺的是基準與比對。先挑少數穩定畫面試，量偶發率 | M–L | dev-ui |
| G12 | 真瀏覽器裡沒有 axe | 自己 | 在 `guard/` 的頁面上加跑 axe（含 `color-contrast`） | S–M | dev-ui |
| G13 | 沒有 AI 生成品質評測 | 自己 | 先不做；等 G1–G4 補完再評估 | L | — |

## 沒核對的

下列出自子代理的盤點，本報告引用了但沒有回原檔逐條核對：

- SG 的 vendor 檢查細節：commit `6e8903e`、sha256 比對、本地修改 82 條、`patches/` 26 個。
- `tokens-contrast.test.ts` 的門檻數字（文字 4.5、狀態色 5.2）。
- `guard/` 是用真的 Chrome 量。
- 嵌入版的建置期改寫（`:root` 換 `.nexus-root`、`@media` 換 `@container`）。
- 決策單 #1827 的 D21 與 D254 原文。
- 相關開放 issue 的搜尋只比對了標題。

Astryx 方面：各節 5／3／1 錨點沒有逐節讀完；`pr-visual` 實際檢查什麼沒有查。
