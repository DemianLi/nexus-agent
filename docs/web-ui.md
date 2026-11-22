# web 的 AGENTS.md

碰 `web` 時才需要的規則。程式放哪個資料夾、誰可以 import 誰見 [`ARCHITECTURE.md`](ARCHITECTURE.md)；怎麼加元件見 [`COMPONENTS.md`](COMPONENTS.md)。

## UI/UX 的參照

**不在根目錄〈技術實現標準〉範圍內的：web 的 UI/UX**（視覺、設計 token、互動、動效）。這一塊以 **shadcn＋Tailwind 為基底**，外觀與設計 token 用 **[solid-glass](https://github.com/deeplethe/solid-glass)**（以下稱 SG）：SG 的檔**原樣 vendor** 在 [`web/src/vendor/solid-glass/`](src/vendor/solid-glass/README.md)，vendor 檔不動，要改的寫在後載入、layer 外的覆寫檔並逐條登記在該目錄 README 的「本地修改」；對比、焦點、reduced-motion 這些無障礙門檻照本專案的（[`.docs/web-ui-spec.md`](../.docs/web-ui-spec.md) §8；對比度目標與焦點外框的數值在 §5，reduced-motion 在 §7），SG 的色值配合調整。`ui/` 的元件也是 SG 的：primitive 以 Base UI 為主（command 用 cmdk、toast 用 sonner、對話捲動與提問用 `@shadcn/react`），[`src/components/ui/`](src/components/ui/) 是它們的 nexus 層，轉出 vendor 的原檔。視覺、設計 token、動效的數值以本專案的標準為準（[`.docs/web-ui-spec.md`](../.docs/web-ui-spec.md) §13）：SG 是值的來源，與標準不一致時照標準、用覆寫蓋掉；[Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) 只當**元件多樣性與交互模式**的參考，用在 SG 沒有定義的元件或互動上（例如 #1497 第 ⑤ 步的設計稿）（demian 2026-10-17 在 PM session 拍板，記在 [#1512](https://github.com/DemianLi/nexus-agent/issues/1512)）。最後長成本專案自己的系統風格。AI 專屬元件（思考過程、工具呼叫、核准、串流回覆這類）另以 [beautiful-ui](https://github.com/slev12397/beautiful-ui) 為參考對象：**不安裝、不複製程式碼**，要吸收就用本專案的元件與設計數值重寫，比對與取捨見 [`.docs/beautiful-ui-comparison.md`](../.docs/beautiful-ui-comparison.md)（地圖 [#1278](https://github.com/DemianLi/nexus-agent/issues/1278)）。「不複製程式碼」管的是 beautiful-ui；SG 是例外，照上面的 vendor 規則。tool-run、reasoning-row、status-line、context-meter、changes、question-panel、composer 這 7 組用的是 SG 自家的 AI 元件，wire 到 props 由本專案的轉接層接，執行語意照下一句。SG 的來龍去脈見 [#1468 的拍板留言](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573)。dsh 在 UI/UX 上**最多只參考元件的多樣性**（有哪些元件、哪些面），不拿來當建議的依據，也不需要寫對照紀錄。會動到執行語意的介面行為（例如按下去這一輪停不停）仍照根目錄 [`AGENTS.md`](../AGENTS.md#技術實現標準)〈技術實現標準〉。來龍去脈見地圖 [#372](https://github.com/DemianLi/nexus-agent/issues/372) 的 Notes。

## 畫面上的文字

> 每個元素都必須提供其他元素還沒表達的資訊；能用版面結構傳達的，就不要再用文字重複。先設計出不靠文字也看得懂的結構，只在結構表達不了的地方才補上文字。

（demian 2026-11-19 定的標準，精簡現有文字的地圖是 [#3033](https://github.com/DemianLi/nexus-agent/issues/3033)。）

**先畫結構，再決定哪裡補字。** 分組、層級、先後、目前在哪、狀態，先用位置、對齊、間距、縮排、字重、顏色、圖示表達。蓋掉所有文字之後還讀得懂誰屬於誰、哪個是主的、現在在哪，才開始補字。

**逐個元素問：拿掉它，少了什麼資訊？** 什麼都不少，就從下面三種處理裡挑一種：

- **刪掉**：別的元素已經講過的。例如區塊標題重述它所在的面板，或已經高亮的那一列又寫「目前這條」。
- **縮短**：資訊本身需要，但句子比資訊長。例如「以下是…」「這裡會顯示…」這類開場，或後面補上的理由。
- **改用結構**：文字在描述位置或關係時，改由位置或關係本身表達。例如接續的位置用分隔線標出，不再寫一段說明。

同一件事在畫面上只由一處講。數量、狀態、名稱出現在兩處以上時，先決定由哪一處負責，其他地方拿掉，或只放指向它的入口。

**不算多餘的：**

- 讀屏專用的名稱（`aria-label`、`sr-only`）。不占畫面，結構也代替不了。可見的字拿掉之後，原本靠它當名稱的元件要把名稱改放到這裡。
- 規格 [§8](../.docs/web-ui-spec.md#8-無障礙) 要求的字，例如工具卡「狀態一定有字」、空內容列的 emptyNote。這些可以縮短、改位置，但不能拿掉。
- 錯誤訊息裡告訴使用者下一步怎麼辦的那句。只檢查重複，不檢查長度。
- 給開發或維運的人看的說明（版本、限制、數字口徑）不在這條的豁免範圍。它們不應該常駐在使用者的畫面上：搬到 [`docs/operations.md`](../docs/operations.md)，或收進按了才展開的地方。

改用結構時，要是需要的圖示或 token 設計系統還沒有，記到 [#2916](https://github.com/DemianLi/nexus-agent/issues/2916)，不要在元件裡自己加。PR 的前後截圖也照這一節自審。
