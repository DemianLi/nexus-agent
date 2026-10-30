# apps/web 新增元件規則

給「要在 `apps/web` 加元件、改樣式」的人。詞（registry 元件、積木、配方……）的定義在 [`GLOSSARY.md`](./GLOSSARY.md)。**值**（色碼、字級、圓角、時長）不在這裡，在 [`.docs/web-ui-spec.md`](../../.docs/web-ui-spec.md)；這裡只講**該放哪、該用什麼、什麼會被擋**。來歷見 [#1141](https://github.com/DemianLi/nexus-agent/issues/1141)。整體長什麼樣、參考過哪些元件庫，見 [`.docs/web-design-style.md`](../../.docs/web-design-style.md)。

## 放哪一層

| 層                                    | 放什麼                                                                 | 規則                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/ui/`                  | shadcn registry 裝進來的元件，或 vendor 的 solid-glass 元件的 nexus 層 | 只放 registry 來的；檔頭寫來源與版本；裝法見規格 §4.1。已換成 solid-glass 的（#1523 起：button、input、textarea、input-group、separator、skeleton、card、badge；#1583 起：dialog、popover、sheet、tooltip、alert-dialog、dropdown-menu、command；#1591 起：composer、context-ring；#1682 起：tool-steps、diff-view）只轉出 `src/vendor/solid-glass/components/ui/` 的原檔，本地修改寫在這一層或覆寫檔，登記在 [vendor README](src/vendor/solid-glass/README.md) 的「本地修改」。自己的元件不要放這裡 |
| `src/components/*.tsx`（含各資料夾）  | 我們自己的元件                                                         | 資料夾按功能分（`tool/`、`todo/`、`sidebar/`…），檔名不重複資料夾名                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/components/row-trigger.tsx` 這類 | 兩處以上共用的自製積木                                                 | 見下面「什麼時候抽」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/lib/`                            | 不畫畫面的邏輯與投影                                                   | 元件只讀它的結果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/styles/`、`src/index.css`        | token 與全域樣式                                                       | token 只在這裡定義                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 只能用系統的值

`src/styles/design-system.test.ts` 會掃元件原始碼的字串字面值，下面這些寫了就紅：

- **顏色**：只用語意 token（`bg-card`、`text-muted-foreground`、`bg-muted`…）。不用 Tailwind 預設色板（`bg-red-500`、`text-white`、`bg-black/50`），不寫 `#fff`、`rgb(…)`。
- **字級**：只有 `text-ui`／`text-body`／`text-tip`／`text-micro` 四階。不用 `text-xs`／`text-sm`／`text-base`／`text-lg`，不寫 `text-[13px]`。
- **表面**：卡片與內層底用 `Surface`，不手寫 `bg-(--hover-faint) shadow-[inset_0_0_0_1px_var(--border)]`、`bg-card rounded-3xl`、`bg-card border rounded-3xl`。
- **展開箭頭**：用 `Chevron`（照 SG 朝右、打開轉 90 度，#1687），不手寫 `transition-transform … rotate-90`（或跟著 `data-state=open` 轉的 `rotate-*`）。
- **可展開列**：用 `RowTrigger`，不手寫 `hover:bg-muted … w-full … text-left … min-h-11`。
- **對話泡泡**：用 `ChatBubble`，不手寫 `rounded-3xl px-4 py-2.5`。
- **程式碼小框**：用 `MonoBlock`，不手寫 `bg-muted … rounded-lg p-2 font-mono`。
- **多行輸入**：`ui/` 以外不寫原生 `<textarea`，用 `ui/textarea` 的 `Textarea`。
- **時長**：走 `motion.css` 的 token（`duration-(--duration-fast)`、`animation-duration-(--duration-medium)`），不寫 `duration-200` 這種數字。這條連 `ui/` 一起管。`vendor/` 裡 SG 元件寫的數字（例如 dialog 的 `duration-100`）原樣留著，進出場的時長就照它（#1687）；這條規則跟 SG 的寫法最後怎麼收，在 ⑥（#1689）定。
- **高亮**：程式標出來的那一格（例如「看這一輪」的 `data-revealed`）在 `styles/solid-glass.overrides.css` 畫外框，不用 `ring-*`。被程式聚焦的元素 `:focus-visible` 時，ring 會被清掉。
- **焦點外框**：`ui/` 以外不寫 `focus-visible:ring-*`。全域已經畫 outline，`styles/solid-glass.overrides.css` 把 ring 清掉了（solid-glass 自己帶回 ring 的選擇器也照抄壓掉），寫了也畫不出來；配上 `outline-none` 就完全看不到焦點。外框被 `overflow-hidden` 裁掉時用 `focus-visible:-outline-offset-2` 畫在裡面。外框寫在該檔的 layer 外，`outline-none` 擋不掉；文字輸入框（`input`、`textarea`）不畫，它們用邊框變色或群組外框，**邊框變成文字色**（solid-glass 原本畫成灰線，覆寫檔換回來，`styles/focus-line-suppression.test.ts`）；真的自己畫了別的焦點樣子（例如整條變色），標 `data-focus="custom"` 才不畫外框（`styles/focus-outline.test.ts` 守著）。
- **圓角**：走階梯（`rounded-md`…`rounded-3xl`、`rounded-full`）或有名字的 `rounded-row`。不寫 `rounded-[20px]`。
- 需要一個系統裡沒有的值 → **先在規格與 `index.css` 加一階**（有名字、有理由），不要寫任意值。

真的要例外：列進該測試的 `ALLOWED`，附理由。**例外只會變少**：列了卻不再命中的條目會報錯。registry 原文的例外（`ui/`）等它們被改掉或確認要留再處理。

## 外觀原則

三條，來自 beautiful-ui 的比對（[`.docs/beautiful-ui-comparison.md`](../../.docs/beautiful-ui-comparison.md) §3，[#1307](https://github.com/DemianLi/nexus-agent/issues/1307)）。都是我們已經在做的事，寫下來讓新元件照做。

- **顏色只當點綴**。畫面以中性灰為主；帶色相的只有語意 token（brand、success、destructive、SG 的 `status-*`），用在狀態、焦點、需要人注意的地方，不拿來鋪大面積。原生色板與硬寫的色碼由 `design-system.test.ts` 擋；「彩色面積不能大」量不出來，靠 review。
- **次要靠顏色，不靠字重；次要色本身要過 4.5:1**。說明、附註、時間一律 `text-muted-foreground`，不要把字變細（細字在中文與小字級下先糊掉）。`font-thin`／`font-extralight`／`font-light` 會被 `design-system.test.ts` 擋下。次要色的對比度由 `tokens-contrast.test.ts` 守著——次要色看不清楚，就等於沒寫。
- **一個面一顆實心按鈕**。一張卡、一個面板、一列操作裡，只有主動作用實心（`Button` 預設 variant）；其他用 `outline`、`ghost`、`secondary`。按壓縮放也只給實心主按鈕（規格 §7）。條件渲染會讓同一個檔裡兩顆實心按鈕不同時出現，靜態量不準，**不寫測試，靠 review**。

陰影也照同一個方向：亮色每一層投影的透明度有上限，上限是 solid-glass 現在的值（浮起來的那一層 `--glass-shade` 0.28、貼地的 `--glass-contact` 0.06……全表在 `src/styles/shadow-alpha.test.ts`），只准一樣或更淡，不要把一層調濃（[#1468](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573) Q8 外觀照 solid-glass，[#1512](https://github.com/DemianLi/nexus-agent/issues/1512)）。`guard/guard.test.ts` 在真的 Chrome 裡量元件的每層投影。暗底上投影要更濃才看得到，不套上限。

## 字級的主次

四階各有用途（[#1281](https://github.com/DemianLi/nexus-agent/issues/1281)）：

| 階                    | 用在                                                                                                           | 例                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text-body`（14／23） | 內文，與本來就是內文大小的按鈕、選單項                                                                         | 對話、`Button` 預設（vendor 原文寫 `text-sm`，同字級）、下拉選單與 cmdk 的項目、右側欄的分頁鈕                                                                                                                                                                                                                                                                                                                      |
| `text-ui`（13／18）   | **可以點的**與**當標題的**小字                                                                                 | 小字的可展開列（待辦、送出佇列、觀測與成本分頁的列）、輸入框底列的膠囊鈕、「這一輪的過程」、成本分頁的區段標題、卡片標頭（計劃、等待核准）；工具卡與工具段那一列的字照 SG（vendor `tool-steps` 寫死 13px／12.5px，#1682）；思考過程照 SG（vendor `reasoning` 標題 12.5px、內文框 13px，#1683）；狀態列執行中那一列照 SG（vendor `turn-status` 寫死 12.5px、高 20px，#1684；其他支仍是 `text-body`，落差記在 #1688） |
| `text-tip`（12／16）  | 小字說明、附註、時間、計數                                                                                     | 工具名與摘要、`Badge`（vendor 原文寫 `text-xs`，同字級）、`xs` 按鈕（vendor 原文寫 `text-xs`：外觀照 SG，#1468 Q8、Q19 拿掉了 #1281 按鈕那一條，下面「按鈕不縮成 `text-tip`」管的是產品原始碼）、tooltip、快捷鍵提示、時間戳、popover 裡數字上面的欄位名、卡片裡單一區塊上面的小標籤（「子代理的對話」；工具卡的「參數」「結果」「錯誤」是 SG 結果框的標題，照 SG）、錯誤與提示句                                   |
| `text-micro`（11）    | 只有程式碼區塊的語言標籤。它在 CSS 裡用 `var(--text-micro)`，不是 class，所以搜 `text-micro` 這個 class 搜不到 | 回覆裡程式碼區塊左上角的「ts」（`src/styles/markdown.css` 的 `.md-code-lang`）                                                                                                                                                                                                                                                                                                                                      |

怎麼判：

- **先看能不能點**。按鈕、觸發鈕、選單項本身不縮成 `text-tip`。裡面夾的計數、時間、`font-normal` 附註另外標 `text-tip`，不要跟著外層一起變大。
- **再看是不是在幫一群東西命名**：卡片的標頭、清單或群組的標題、區段標題。不可點的也算；同一欄裡可點的群組標題（側欄「已封存」）與不可點的（「今天」）要一樣大。卡片**裡面**只標一塊內容的小標籤（工具卡的「結果」、提問面板的「呼叫參數」）不是在命名一群東西，是附註，留 `text-tip`。
- **同一串清單的列跟著可點的列走**：觀測分頁的列有能展開的（`ExpandableLine`）與不能展開的（`StaticLine`），兩種都是 `text-ui`，不然相鄰的列一大一小。
- **等寬的內容不是標題**：diff、讀檔、搜尋結果、`MonoBlock`、工具卡上的路徑都留 `text-tip`。路徑本身就是那顆鈕的字時（改動清單的列、審閱分頁選檔案的鈕）才是 `text-ui`。
- **只動 12 的那一層**：已經是 `text-body` 的按鈕與選單不降成 13。

機械判得出來的那一半有護欄：按鈕、`RowTrigger` 與其他觸發鈕、選單項自己的 `className` 寫了 `text-tip`／`text-micro` 就紅（`src/styles/type-hierarchy.test.ts`）；registry 元件的預設字級照 SG：#1281 的三條（下拉選單、cmdk、側欄）照 #1468 Q19 拿掉，下拉選單與 cmdk 隨 #1583、側欄（群組標題與 `sm` 選單鈕是 vendor 原文的 `text-xs`）隨 #1680 換成 vendor 版。「是不是標題」判不出來，靠 review。

## 新增自訂 token 要登記 `cn`

`cn`（class 合併）不認得自訂的 `text-*`／`rounded-*` 名，會把字級當字色互相吃掉（2026-10-07 發生過，PR #1144）。所以：

- `index.css` 加了 `--text-<名>` 或 `--radius-<名>`，就到 `src/lib/utils.ts` 的 `createCn` 登記同一個名字。
- **全站只從 `@/lib/utils` 取 `cn`**，不要 `from 'cn'`（`utils.test.ts` 會擋，registry 檔裝進來也要改）。vendor 的 SG 元件放行：它們原樣 `from "cn"`，由別名解析到 `@/lib/utils`（vendor README「本地修改」第 14 條）。
- 改 class 名的重構，前後比對要量**字級、字色、寬度**的計算樣式，不只高度與截圖。

## 什麼時候抽共用元件

- **兩處以上手寫同一份配方**（不只是名字像）才抽；只有一處就留在原地。
- 只抽**共通的部分**，差異用 `className` 補（例：`RowTrigger` 只含底色、最小高度、圓角、過渡，圖示與間距由呼叫端給）。
- 抽完要證明**畫面沒變**：展開成的 class 集合與原本逐項相等，再加實機前後比對。
- 已抽的：`RowTrigger`（可展開列；`fit="card"` 嵌在卡片裡、用 `rounded-row` 同心，`fit="bare"` 自己就是一列）、`Chevron`（展開箭頭，跟著外層的 `data-state` 轉，或用 `open` 直接給）、`ChatBubble`（對話裡的文字泡泡，人的話靠右、子代理寄來的話靠左）、`MonoBlock`（夾在說明文字裡的等寬字小框，平的 `bg-muted`；工具輸出那種有標題、有細線的內層底是 `Surface tone="stage"`，不是它）、`Surface`（`raised` 浮起來的卡片、`stage` 內層底、`docked` 貼在輸入框上方的平邊線卡片，用 `as` 選元素）、`CopyButton`（複製鈕：交付卡的複製路徑、回覆底下的複製回覆、程式碼區塊的複製程式碼共用同一套行為與回饋，[#1305](https://github.com/DemianLi/nexus-agent/issues/1305)）。新的卡片或內層底用 `Surface`，手寫整組配方會被護欄擋下。
- 還沒抽的：`pending-swap`（走 `ui/Card` 覆寫，是 shadcn 元件的用法）。

## 浮層（Base UI）

#1583 起 dialog、alert-dialog、popover、sheet、tooltip、dropdown-menu 是 solid-glass 的 Base UI 版，command 是 solid-glass 的 cmdk 版（vendor README 的「元件怎麼接」有完整對照）。寫呼叫端時：

- **Trigger 接自己的元素用 `render`**，不是 `asChild`：`<PopoverTrigger render={<Button variant="outline" />}>字</PopoverTrigger>`，字放在 Trigger 上。
- **焦點**：打開、關掉要搬到哪裡，給 Popup 的 `initialFocus`／`finalFocus`（boolean、ref 或回傳元素的函式；回傳 `false` 是不要搬）。
- **點外面要不要關**：在 Root 的 `onOpenChange(open, details)` 看 `details.reason === 'outside-press'`，不關就 `details.cancel()` 並且不改自己的 state。
- **tooltip 的字不能帶 Trigger 名稱裡沒有的資訊**：Base UI 的 tooltip 不給 `role="tooltip"`、也不掛 `aria-describedby`，報讀器聽不到它（#1583 驗收 D）。要讓人聽到的資訊寫進 Trigger 的 `aria-label`。
- **下拉選單的選項用 `onClick`**，不是 `onSelect`；Trigger 開著時掛 `data-popup-open`，要「選單開著時怎樣」寫 `data-popup-open:`（不是 `data-[state=open]:`）。
- **確認框的 `AlertDialogAction` 按了就關**（包裝層接了 Close），`onClick` 照樣會跑；不用自己在 `onClick` 裡關。
- **command 的勾自己畫**：vendor 附在每個選項後面的勾被藏掉了（覆寫檔第 27 條）。要標「目前選的」就在選項裡自己放一顆 `<Check aria-label="目前選的" />`（`composer.tsx` 的 `@` 選單）。`CommandDialog` 不自己包 `Command`，由呼叫端包。
- **寬度蓋 SG 的值要寫同一組前綴**：sheet 寫 `data-[side=right]:w-full`、`data-[side=right]:sm:max-w-none`，dialog 寫 `sm:max-w-lg`，cn 才會把 SG 的 `data-[side=*]:w-3/4`、`sm:max-w-sm` 拿掉。

## 工具卡（SG tool-steps）

#1682 起工具卡是 SG 的 `StepRow`、工具段是 `StepGroup`（vendor README 的「本地修改」第 56–66 條；diff 是第 77–80 條）。寫呼叫端時：

- **`ToolEntry` 只經 `lib/tool-step.ts` 轉成 `Step`**：狀態收成 SG 的三態（`running`／`done`／`error`），四格狀態的字由卡放在 `trailing` 的 `Badge`。
- **寫檔／改檔給 `step.patch`**（#1685 B）：字串只從 `lib/tool-diff.ts` 的 `toolDiffView` 拿（全樹組 unified patch 的只有那裡的 `toolPatch`），卡與段才拿到同一份、nexus 層的 `patchStats` 快取才查得到。上限在 nexus 層的 `DiffView`，不要在轉接層截 patch：vendor 從 patch 算列與段的 `+N −M`，截過就少報。
- **結果自己畫的種類不設 SG 的 `output`／`error`**（讀檔、搜尋、提問、交付、待辦、撞到輸出上限的子代理；diff 走 `step.patch`）：畫在 children，SG 的結果框只給通用卡，不畫兩次。展開後什麼都沒有的列 SG 會停用按鈕，所以空的時候放一句 `emptyNote`。
- **`StepGroup` 只有一步、而且沒在跑時退化成單獨一列**，`children`、`trailing`、`open` 都不會轉過去：工具段至少兩顆（`tool-runs.ts` 的 `MIN_TOOLS`，有測試釘住）。
- **段裡沒畫東西的 child 照樣占一格**（SG 逐個包一層有 padding 的 div）：`MessageScrollerItem` 是空的那格由覆寫檔第 66 條藏掉，別在 child 外面再包東西，不然藏不到。

## 狀態列（SG turn-status）

#1684 起狀態列執行中那一列是 SG 的 `TurnStatus`（vendor README 的「本地修改」第 71–74 條）。寫呼叫端時：

- **live region 由 `status-line.tsx` 包在外面**（`<div role="status">`）：vendor 的 `role="status"` 由 patch 拿掉，別的地方畫 `TurnStatus` 不會自己唸。
- **字固定、glyph 換樣子**：`label` 是「執行中…」，`activity` 由 `lib/turn-activity.ts` 從本輪的 root entry 判；字在 live region 裡，不要跟著 activity 換。
- **`since`、`tokens`、`children` 型別上傳不進去**（包裝層 `Omit`），經過時間由 `RunningElapsed` 畫在 live region 外；**`trailing` 也在 live region 裡**，不要拿來放會跳動的東西。
- **jsdom 不畫 glyph**（沒有 `matchMedia`／`IntersectionObserver`，nexus 層回 `null`）：要量真 glyph 的測試用 `src/test/glyph-env.ts`。

## 新增 shadcn 元件

照規格 §4.1：`shadcn add … --overwrite`，跑 `prettier --write`，把 `from 'cn'` 改成 `@/lib/utils`，檔頭記來源 URL 與版本，把改過且「改回去畫面不會報錯」的地方補進 `ui/registry-edits.test.ts`。AI Elements 一律不裝。

## 測試與說明文件裡的類別名

Tailwind 會掃整個專案找 class，所以**測試檔與 `apps/web/*.md` 裡寫到的類別名也會被編成規則**。`src/index.css` 用 `@source not` 排除了它們，`pnpm build` 最後的 `check-built-css` 會量產物確認；新增別種會寫類別名的檔案（例如別的資料夾的 `.md`），要一併排除，否則建置會失敗。

## 不假設自己在安全環境

網頁可能從非安全環境打開（內網用 IP 開的 `http://` 頁面），瀏覽器在那裡不給只限安全環境的 API。用到這類 API 要有退路：產 UUID 走 `@/lib/uuid` 的 `randomUuid()`，`crypto.randomUUID` 由 lint 擋下（#1548）；複製走 `@/lib/clipboard` 的 `copyText`，`navigator.clipboard` 拿不到就退回 `execCommand`。
