# nexus web 設計風格總覽

> 2026-10-12，dev-ui，對 `develop` 的 `1cb74509` 寫。demian 直接交辦，沒有卡。
>
> 這份給**人**看：nexus 的介面整體長什麼樣、每一條從哪裡來、參考過的元件庫各拿了什麼。它**不是規則的家**：
>
> - 值與現行規則在 [`web-ui-spec.md`](web-ui-spec.md)（下稱「規格」）。
> - 新增元件該放哪、用什麼、什麼會被擋，在 [`apps/web/COMPONENTS.md`](../apps/web/COMPONENTS.md)。
> - 用詞在 [`apps/web/GLOSSARY.md`](../apps/web/GLOSSARY.md)。
> - 色碼與對比度在 token 產生器的產物 [`apps/web/tokengen/token-table.md`](../apps/web/tokengen/token-table.md)。
>
> 下文舉的數字只是讓人有感覺，**以上面那幾份為準**。跟它們衝突時，改這份，不改那幾份。
>
> 每一條都附出處（規格或 `COMPONENTS.md` 的段落、已關的卡或 PR）。找不到出處的理由標「待確認」，不自己補。

## 0. 一段話

nexus 是企業內部查資料、接內部系統的聊天機器人（[#949](https://github.com/DemianLi/nexus-agent/issues/949)）。它的介面以中性灰為主，顏色只出現在狀態、焦點和需要人注意的地方；層次靠幾層深淺不同的表面和很淡的陰影，幾乎不畫框線；字只有兩種粗細，次要的資訊靠顏色退後；動效短、開關一樣快、數值照 SG，而且只有封閉清單裡的那幾種。**AI 專屬的部分**（狀態、思考、工具、核准、提問）的做法是：狀態集中在一處、收著也看得到重點、需要人決定時換掉輸入框。亮色與暗色的鑑別度一樣，對比度由產生器解出來並有測試守著；所有資源都打包在本地。

## 1. 八個特徵

每一條寫：長什麼樣、從哪裡來（為什麼）、規則在哪。

### 1.1 顏色只當點綴

- **長什麼樣**：整個畫面是無彩的灰階，主按鈕也是無彩的（亮色近黑、暗色白）。帶色相的只有幾個語意 token：`brand`（連結、info、核准與提問面板的邊框光）、`success`、`warning`、`info`、`destructive`，以及 SG 的狀態色 `status-done`／`status-interrupted`／`status-running`。
- **從哪裡來**：
  - `--primary` 無彩，因為 shadcn 與 Libraries.dev 的主按鈕都是黑白；`--brand` 用的是 SG 自己的 `--brand`，色相與彩度照 SG、明度由產生器對 SG 的底色解出來（[#1468 拍板](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573) Q10，[#1512](https://github.com/DemianLi/nexus-agent/issues/1512)），只用在上面那幾處（用途出自 [#377 定稿](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498)）。
  - 「顏色只當點綴」這句原則來自 beautiful-ui，比對時發現我們本來就這樣做，寫成原則（[比對文件](beautiful-ui-comparison.md) §3，[#1307](https://github.com/DemianLi/nexus-agent/issues/1307)）。
- **規則在哪**：規格 §5「顏色」；`COMPONENTS.md`「外觀原則」第一條。原生色板與硬寫色碼由 `design-system.test.ts` 擋；「彩色面積不能大」量不出來，靠 review。

### 1.2 層次靠表面，不靠框線

- **長什麼樣**：底色 → 浮起來的玻璃卡片（`Surface tone="raised"`）→ 卡片裡的內層底（`stage`）。卡片的邊畫在陰影裡，不用 `border`：頂上一條光、一圈 1px 細線、貼地的淡影，再加一層浮起來的投影，亮暗是同一組結構（SG `solid-glass.css:380-403`）；按鈕與欄位的細線則是它們自己的 `border`，再疊光與影（規格 §5「形狀」）。亮色每層投影的透明度上限是 solid-glass 現在的值（浮起來的那一層 `--glass-shade` 0.28、貼地的 `--glass-contact` 0.06），只准一樣或更淡（[#1468 拍板](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573) Q8，[#1512](https://github.com/DemianLi/nexus-agent/issues/1512)）。
- **例外**：貼在輸入框上方的那一排（待辦、送出佇列、目標列，`Surface tone="docked"`）用平的細線，因為它們接在輸入框上、不是浮在對話裡；SG 會把它畫成浮起來的卡片，覆寫檔補回平線（#1512）（規格 §5「形狀」；`apps/web/src/components/surface.tsx` 檔頭）。
- **從哪裡來**：
  - 卡片外框、裡面再嵌一個展示區、1px 半透明邊線、幾乎不用實色邊框：Libraries.dev 的外觀（[元件清單](agent-ui-element-inventory.md) §3.2）；`--stage`、`--chip`、`--material-shadow` 這些名字是原型為了映射它而加的（同節 §3.4 第 2 點、規格 §5「顏色」）。
  - 邊緣畫在陰影裡：[#377 定稿](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498)。
  - 亮色投影有上限：原本是 beautiful-ui「不刺眼」那條原則只採亮色的部分，每層 ≤ 0.06（比對文件 §3，#1307）；改用 solid-glass 後上限換成它的值，護欄保留（Q8，#1512）。
- **規則在哪**：規格 §5「形狀」；`COMPONENTS.md`「外觀原則」最後一段；`border-shadow.test.ts`、`shadow-alpha.test.ts`、`design-system.test.ts`（卡片與內層底只能用 `Surface`）。

### 1.3 圓的形狀

- **長什麼樣**：圓角走 solid-glass 的階梯（以 14px 為 `lg`，`sm` 到 `4xl` 是它的 0.6 到 2.6 倍；控制項小一階）；按鈕是全圓（`rounded-full`）。
- **從哪裡來**：Libraries.dev 的按鈕與 chip 是全圓 pill、卡片外框圓角約 24–26px、選單 12px、選項 8–9px（元件清單 §3.2）；原本的階梯（`sm` 6 到 `3xl` 24）在 [#377 定稿](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498) 拍板，不用 superellipse。改用 solid-glass 後圓角屬於外觀類，照它的階梯、不重綁（[#1468 拍板](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573) Q8）；不用 superellipse 照舊。
- **規則在哪**：規格 §5「形狀」；`design-system.test.ts` 擋任意值圓角。

### 1.4 字：四階、兩種粗細，次要靠顏色

- **長什麼樣**：
  - 介面字 Geist，等寬字 Geist Mono（只用在程式碼、工具輸入輸出、終端機），中文兩者都退 Noto Sans TC。
  - 字級只有四階：內文 `text-body`、可以點的與當標題的小字 `text-ui`、說明與附註 `text-tip`，以及只用在程式碼區塊語言標籤的 `text-micro`。
  - 字重只有 400 與 500。次要的字（說明、時間、計數）用 `text-muted-foreground` 退後，不把字變細。
- **從哪裡來**：
  - 字型：solid-glass 用 Geist，打包 latin 子集（等寬另加方框字元），等寬再接系統等寬，中文接 Noto Sans TC（[#1468 拍板](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573) Q6）；原本是 Google Sans Flex／Code。四階：規格 §5「字型」（[#377](https://github.com/DemianLi/nexus-agent/issues/377)）；Libraries.dev 用的 Inter／Roboto Mono 沒有採用，標題字 Saans 授權不明不拿（元件清單 §3.2、規格 §3、§5）。
  - 只走四階、不用 Tailwind 預設字級：[#1141](https://github.com/DemianLi/nexus-agent/issues/1141)。
  - 主次（可以點的與當標題的用 13，說明用 12）：[#1281](https://github.com/DemianLi/nexus-agent/issues/1281)（PR [#1296](https://github.com/DemianLi/nexus-agent/pull/1296)）。
  - `text-micro` 保留：它其實有一處在用（程式碼區塊的語言標籤），demian 2026-10-12 決定保留，不刪（規格 §5「字型」）。
  - 次要靠顏色不靠字重，「細字在中文與小字級下先糊掉」：beautiful-ui 的原則，加上一條它自己沒守住的——次要色本身要過 4.5:1（它的說明字只有 2.4–2.7:1，比對文件 §3、§4；`COMPONENTS.md`「外觀原則」第二條）。
- **規則在哪**：規格 §5「字型」；`COMPONENTS.md`「字級的主次」；`design-system.test.ts`（只准四階、擋細字重）、`type-hierarchy.test.ts`、`tokens-contrast.test.ts`。

### 1.5 動效：數值照 SG，清單封閉

- **長什麼樣**：
  - 彈出的東西先縮一點再長出來，進場和退場一樣快：時長與曲線照 SG（#1687），對話框、確認框、popover 開關都是 100ms，tooltip 150ms，曲線 `ease`；展開收合沒有高度動效。
  - 有動效的只有封閉清單裡的幾種模式：浮層彈出、對話框、側滑抽屜、換內容、展開收合、進場、進度、按壓、持續狀態。清單外只留 100–150ms 的顏色過渡。
  - 按下去縮一下只給實心主按鈕與送出鍵；逐項錯開進場只給提問選項。
  - 執行中的持續狀態是狀態列上 SG 的 `StatusGlyph`（三個點換著圖形動，JS 每幀畫，#1684 起；規格 §7 的「純 CSS」例外）和邊框光；空白 hero 的待命仍是純 CSS 的 breathing orb（`agent-orb.tsx`）。
  - 減少動態時不是全關：拿掉位移、縮放、模糊，留 150ms 以內的淡入淡出。
- **從哪裡來**：
  - 進出場的時長與曲線、展開收合不做高度動效：SG（#1687）。
  - 「先縮一點再長出來」與其餘時長、位移、縮放、模糊 token：Libraries.dev（元件清單 §3.3）；這組 token 還有消費者，留給 ⑥（#1689）一起收。
  - 封閉清單、按壓只給主按鈕、減少動態的退法：[#378 動效策略](https://github.com/DemianLi/nexus-agent/issues/378#issuecomment-5718598887)。
  - 不裝 `thinking-orbs`、`border-beam`，改純 CSS 仿：demian 看過原型後的決定（[#375 原型結論](https://github.com/DemianLi/nexus-agent/issues/375#issuecomment-5708312161)，由 #378 拍板）。
  - 按壓不擴大到 ghost 按鈕：「一按就縮，在一排工具卡上會很吵」（比對文件 §4）。
- **規則在哪**：規格 §7；`apps/web/src/styles/motion.css`；`design-system.test.ts`（時長只能用 token）；`scripts/check-built-css.mjs`（`@keyframes` 允許清單、無限動畫在減少動態下都有對應）。

### 1.6 AI 的過程：集中、收著也有重點、要人決定時換掉輸入框

這一塊的參考對象是 beautiful-ui：**不安裝、不複製，只用本專案的元件重寫**（AGENTS.md「技術實現標準」）。逐元件的比對在 [`beautiful-ui-comparison.md`](beautiful-ui-comparison.md)。

- **狀態只有一處**：連線、執行中、等待核准、失敗、已停止……全由狀態列講；螢幕閱讀器也只由它唸，`role="status"` 全站只有狀態列外加兩格寫明的例外（規格 §8，[#1290](https://github.com/DemianLi/nexus-agent/issues/1290)）。執行中顯示經過時間，重新整理不歸零（[#1308](https://github.com/DemianLi/nexus-agent/issues/1308)，比對文件 §6 C7）。
- **收著也看得到重點**：推理列收著時顯示最新一行或第一行（比對文件 §2 第 2 列）；一輪裡連續完成的工具呼叫收成一列（[#1309](https://github.com/DemianLi/nexus-agent/issues/1309)，C8）。
- **要人決定時換掉輸入框**：核准、提問、計劃審核都取代輸入框，照 dsh 的 composer takeover；同時只出一個面板、先來先處理；輸入框隱藏但不卸載，草稿不會丟（規格 §4.3，[#376](https://github.com/DemianLi/nexus-agent/issues/376#issuecomment-5709355235)）。
- **收尾的小東西**（都來自 beautiful-ui 比對，比對文件 §6）：
  - 回覆、程式碼區塊、交付檔路徑共用同一顆複製鈕（[#1305](https://github.com/DemianLi/nexus-agent/issues/1305)，C1）。
  - 提問換題時面板高度跟著變、推薦選項畫成小標（[#1306](https://github.com/DemianLi/nexus-agent/issues/1306)，C2＋C3）。
  - 推理列展開區左線、會話搜尋清除鈕（[#1307](https://github.com/DemianLi/nexus-agent/issues/1307)，C4＋C6）。
  - 回覆的 markdown 表格整列 hover、數字欄對齊（[#1330](https://github.com/DemianLi/nexus-agent/issues/1330)）。
- **規則在哪**：規格 §4.3、§8；`live-region.test.ts`。

### 1.7 亮暗一樣清楚

- **長什麼樣**：亮、暗、跟系統三態，預設跟系統。兩套主題共用同一組對比度目標（取兩主題較強者）。
- **從哪裡來**：「暗色和亮色的邊框效果、區塊鑑別度要一樣明顯」是 #372 那一輪的拍板（元件清單開頭「後續決議」），由 [#377](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498) 落成數字；三態切換見 [#391](https://github.com/DemianLi/nexus-agent/issues/391#issuecomment-5722962752)。Libraries.dev 寫死暗色（元件清單 §3.4 第 1 點）、beautiful-ui 預設暗色（比對文件 §5），兩者都不跟。
- **規則在哪**：規格 §5「對比度目標」、§6；`tokens-contrast.test.ts`。

### 1.8 內網、手機也能用

- **內網**：字型、動效 CSS 等資源一律打包進本地，執行期不打外部 CDN（規格 §3）。外部字型、外連影片、遙測都不碰（比對文件 §5）。
- **手機**：1024 以下側欄收成抽屜；驗收寬度 375／768／1280；觸控目標 44px；會話區裡的排版看容器寬度，不看視窗寬度（規格 §9）。

## 2. 從哪裡來：參考過的元件庫各給了什麼

**原則是「只看不裝」**：用它們的結構與手感，換成本專案的值和積木重寫（`GLOSSARY.md`「參考對象」）。例外是 shadcn 官方：registry 元件裝進來就是我們的原始碼（規格 §4.1）。另一個例外是 [solid-glass](https://github.com/deeplethe/solid-glass)：demian 拍板改用它取代現有的主題（[#1468 拍板](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573)、地圖 [#1497](https://github.com/DemianLi/nexus-agent/issues/1497)），原樣 vendor 在 `apps/web/src/vendor/solid-glass/`，外觀類照它，機制類與無障礙門檻照本專案（Q5、Q8），修改逐條登記在該目錄 README 的「本地修改」。主題在地圖第 ② 步換上；元件換成它的 Base UI 版在第 ③ 步，AI 元件在第 ④ 步。

| 來源 | 角色 | 拿了什麼 | 沒拿什麼、為什麼 | 出處 |
| --- | --- | --- | --- | --- |
| [shadcn/ui](https://github.com/shadcn-ui/ui) 官方（含 2026 新出的 chat 元件與 `questionnaire`） | **基底** | 元件外殼與基礎件（sidebar、sheet、dialog、command、collapsible、button……） | registry 原樣的外觀：`border` 換成陰影（規格 §5）、`ring-[3px]` 關掉改 outline（規格 §5「互動狀態」）、英文報讀字串換中文（規格 §8） | 規格 §4；[#374](https://github.com/DemianLi/nexus-agent/issues/374#issuecomment-5707786108) |
| [solid-glass](https://github.com/deeplethe/solid-glass)（固定在 `6e8903e`，跟上游 `main`） | **外觀與設計 token 的來源**，取代原本的主題 | 顏色的色相、彩度、alpha；玻璃面（含大面積 blur）與陰影；圓角階梯；字型 Geist／Geist Mono；5 個 `sg-*` keyframes | 達不到本專案門檻的色值（只重解明度）、灰色的焦點線（換回文字色）、reduced-motion 下進場整個關掉（改 150ms 淡入）、三個簡體中文字型；dark variant、body 寫在 layer 外照本專案的機制 | [#1468 拍板](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573)；`apps/web/src/vendor/solid-glass/README.md`「本地修改」 |
| [Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) | **元件多樣性與交互模式的參考**：用在 SG 沒有定義的元件或互動上（demian 2026-10-17 在 PM session 拍板，記在 [#1512](https://github.com/DemianLi/nexus-agent/issues/1512)；原本是一般元件的模仿對象，視覺、token、動效的數值改以 SG 為準） | 原本拿的外觀：卡片套展示區、全圓 pill、淡陰影、半透明細線；accent 變成 `--brand`；整組動效 token 與「開快關更快」（開 250、關 150；進出場 #1687 起改照 SG，開關都 100）；orb 與邊框光的樣子 | 效果套件不裝，改純 CSS 仿（#375、#378）；寫死暗色不跟、視覺不複刻（規格 §2）；字型不用 Inter／Roboto Mono，標題字 Saans 授權不明不拿（規格 §3、§5）；`#17181c` 帶藍，主色改用無彩（#377） | [元件清單 §3](agent-ui-element-inventory.md)；[#377](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498)、[#378](https://github.com/DemianLi/nexus-agent/issues/378#issuecomment-5718598887) |
| [beautiful-ui](https://github.com/slev12397/beautiful-ui) | **AI 專屬元件的參考對象**；不安裝、不複製，只用本專案元件重寫 | 收尾與密度的細節（§1.6 那幾張卡）；三條外觀原則（`COMPONENTS.md`「外觀原則」） | 它的設計數值：說明字對比不及格、任意字級 201 處（比對文件 §4）；8 個我們沒有場景的元件（比對文件 §0）；音效、預設深色、影片、示範資料、外部字型與外連素材（[#1278](https://github.com/DemianLi/nexus-agent/issues/1278) 拍板第 6 點） | [比對文件](beautiful-ui-comparison.md)；地圖 [#1278](https://github.com/DemianLi/nexus-agent/issues/1278)；PR [#1289](https://github.com/DemianLi/nexus-agent/pull/1289) |
| [AI Elements](https://github.com/vercel/ai-elements)（Vercel） | 清單參考 | 「agent 介面該有哪些元件」的清單 | 程式碼一律不裝：`reasoning`／`message` 會把主 chunk 拉到約 2 MB（規格 §4.1） | [選型調研](agent-ui-library-survey.md) 開頭「後續決議」；[#374](https://github.com/DemianLi/nexus-agent/issues/374#issuecomment-5707786108) |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | 調研過，拒絕 runtime 層 | — | runtime 層會跟 `@nexus/wire` 搶狀態擁有權 | 選型調研「結論速查表」、§3.2 |
| [prompt-kit](https://github.com/ibelick/prompt-kit)、[agent-chat-ui](https://github.com/langchain-ai/agent-chat-ui)、[LlamaIndex chat-ui](https://github.com/run-llama/chat-ui)、[shadcn-chatbot-kit](https://github.com/Blazity/shadcn-chatbot-kit) | 調研過 | 對照用（工具卡、核准、RWD 誰在做） | 沒有一家對得上 `@nexus/wire` 的 `ConversationEntry`，也沒有一家替你做好頁面層的 RWD | 選型調研「結論速查表」、§3–§5 |
| dsh（deepseek-harness） | 元件多樣性；執行語意 | 有哪些元件、哪些面；會動到執行語意的互動照它（核准與提問換掉輸入框、`@` 選單的觸發與鍵盤） | 它的外觀：React 18＋CSS Modules，沒有 shadcn（選型調研「結論速查表」）；UI/UX 不以它為依據 | AGENTS.md「技術實現標準」；規格 §3、§4.3、§4.4 |

**沒查的**：Kibo UI 的 AI 元件、CopilotKit、Tambo，當初沒 clone、沒讀（選型調研 §3.8）。這張表以外的元件庫都**還沒整理進來**；要加的話，先照 beautiful-ui 那樣寫一份比對文件。

## 3. 用什麼蓋

三種元件，定義見 `GLOSSARY.md`：

- **registry 元件**（`components/ui/`）：shadcn 裝進來的，改過的地方登記在 `ui/registry-edits.test.ts`。
- **積木**：兩處以上用同一份配方才抽出來（`COMPONENTS.md`「什麼時候抽共用元件」）。今天有：

  | 積木 | 用在 | 檔案（`apps/web/src/components/`） |
  | --- | --- | --- |
  | `Surface` | 卡片（`raised`）、內層底（`stage`）、貼在輸入框上的那一排（`docked`） | `surface.tsx` |
  | `RowTrigger` | 可展開的列 | `row-trigger.tsx` |
  | `Chevron` | 展開箭頭 | `chevron.tsx` |
  | `ChatBubble` | 對話裡的文字泡泡 | `chat-bubble.tsx` |
  | `MonoBlock` | 夾在說明文字裡的等寬小框 | `mono-block.tsx` |
  | `CopyButton` | 複製路徑、複製回覆、複製程式碼 | `copy-button.tsx` |

- **功能元件**：只為一個功能存在的，按功能分資料夾（`tool/`、`todo/`、`sidebar/`……），由前兩種組成。

新增元件的流程與會被擋的寫法，全在 `COMPONENTS.md`。

## 4. 怎麼守住

能變成測試的規則都寫成了測試（[#1278](https://github.com/DemianLi/nexus-agent/issues/1278) 拍板第 5、7 點；規格 §11）：

| 守什麼 | 檔案（`apps/web/` 下） |
| --- | --- |
| 只用系統的值：顏色、字級、圓角、時長、表面、積木、焦點外框、細字重 | `src/styles/design-system.test.ts` |
| 同一元素不同時用 `border` 與陰影 | `src/styles/border-shadow.test.ts` |
| 亮色每層陰影透明度不超過上限（solid-glass 現在的值） | `src/styles/shadow-alpha.test.ts`（token）、`guard/guard.test.ts`（瀏覽器量元件） |
| 文字、非文字、狀態色的對比度，亮暗共用目標 | `src/styles/tokens-contrast.test.ts` |
| 按鈕、觸發鈕、選單項不縮成說明字級 | `src/styles/type-hierarchy.test.ts` |
| 焦點外框畫得出來 | `src/styles/focus-outline.test.ts` |
| solid-glass 用灰色畫的焦點全部蓋掉：帶回來的 ring、欄位聚焦的邊框 | `src/styles/focus-ring-suppression.test.ts`、`src/styles/focus-line-suppression.test.ts` |
| 出貨 CSS 在真的 Chrome 裡：焦點、欄位聚焦的邊框、每個字對實際底色的對比、chip 三階（warning 用量表平常狀態守狀態色 5.2）、貼在輸入框上方的卡片是平的、對話定位那一則的圓角、陰影、不透明的退路 | `guard/guard.test.ts`（`pnpm test:guard`，要先 build） |
| vendor 的 solid-glass 沒被手改 | `src/vendor/solid-glass/vendor.test.ts` |
| `role="status"` 只有狀態列 | `src/styles/live-region.test.ts` |
| registry 元件上登記過的修改沒被改回去 | `src/components/ui/registry-edits.test.ts` |
| 全站只從 `@/lib/utils` 取 `cn` | `src/lib/utils.test.ts` |
| 建置出的 CSS：`@keyframes` 允許清單、減少動態、沒有只來自測試或文件的 class | `scripts/check-built-css.mjs`（`pnpm build` 最後一步） |
| axe-core 無障礙掃描 | `src/test/axe.ts` 與用到它的畫面測試 |

**量不出來、靠 review 的**：彩色面積不能大、一個面只有一顆實心按鈕、「是不是標題」（`COMPONENTS.md`）；持續動畫只動 transform／opacity（規格 §11）。大面積玻璃的效能改由合併前的量測守（規格 §7「效能」）。

## 5. 刻意不做的

- **beautiful-ui 比對後不開的**（[#1278 收尾前的選卡留言](https://github.com/DemianLi/nexus-agent/issues/1278)）：diff 行號與字詞級高亮（只有改檔案時用得到，不是這個產品的主要場景）、側欄與選單的滑動高亮（要先改動效規格，只是裝飾）、推理列「想了 N 秒」（要 harness 補資料，dsh 也沒有）。
- **比對後不換的數值**：陰影層數、按壓縮放的範圍、緩動曲線、時長、字級（比對文件 §4）。
- **不要的**：互動音效、預設深色、影片載入畫面、示範資料、外部字型與外連素材（#1278 拍板第 6 點）；遙測（比對文件 §5）；Libraries.dev 的視覺複刻與暗色專用（規格 §2）。
- **產品面沒有的**：設定頁、工作區挑選、分割版面、右側欄裡的檔案樹與終端、語音、生圖特效（規格 §2）。

## 6. 還沒定或還沒驗的

- beautiful-ui 裡判定「沒有場景」的 8 個元件中，跟資料呈現有關的 4 個（records-table、filter-table、insight-cards、diff-table）在 [#1318](https://github.com/DemianLi/nexus-agent/issues/1318) 階段 B 重開時重評（B 已在 2026-10-11 擱置，見 [#1318 的 PM 留言](https://github.com/DemianLi/nexus-agent/issues/1318#issuecomment-6110645206)）。
- 「引用來源」（答案出自哪個內部系統）的地圖是 [#1318](https://github.com/DemianLi/nexus-agent/issues/1318)：階段 A 已完成；階段 B 擱置，重開條件是 demian 提供至少一個試點內部系統的 MCP 回傳範例；階段 C 不排（同一則留言）。
- 規格 §11「還沒驗過的」：下拉的動效值、macOS VoiceOver、停在提問時按停止等。
- `text-micro`（11）：保留，只用在程式碼區塊的語言標籤（`apps/web/src/styles/markdown.css:89`），demian 2026-10-12 決定。#1278 拍板第 8 點「沒人用再刪」的前提不成立。

## 7. 這份怎麼更新

- 規則或值改了：改規格或 `COMPONENTS.md`。這份只有在「整體長什麼樣」或「參考來源」變了才動。
- 加一個新的參考對象：先寫比對文件、demian 選過，再回來在 §2 加一列。
