# apps/web 新增元件規則

給「要在 `apps/web` 加元件、改樣式」的人。詞（registry 元件、積木、配方……）的定義在 [`CONTEXT.md`](./CONTEXT.md)。**值**（色碼、字級、圓角、時長）不在這裡，在 [`.docs/web-ui-spec.md`](../../.docs/web-ui-spec.md)；這裡只講**該放哪、該用什麼、什麼會被擋**。來歷見 [#1141](https://github.com/DemianLi/nexus-agent/issues/1141)。

## 放哪一層

| 層 | 放什麼 | 規則 |
| --- | --- | --- |
| `src/components/ui/` | shadcn registry 裝進來的元件 | 只放 registry 來的；檔頭寫來源與版本；裝法見規格 §4.1。自己的元件不要放這裡 |
| `src/components/*.tsx`（含各資料夾） | 我們自己的元件 | 資料夾按功能分（`tool/`、`todo/`、`sidebar/`…），檔名不重複資料夾名 |
| `src/components/row-trigger.tsx` 這類 | 兩處以上共用的自製積木 | 見下面「什麼時候抽」 |
| `src/lib/` | 不畫畫面的邏輯與投影 | 元件只讀它的結果 |
| `src/styles/`、`src/index.css` | token 與全域樣式 | token 只在這裡定義 |

## 只能用系統的值

`src/styles/design-system.test.ts` 會掃元件原始碼的字串字面值，下面這些寫了就紅：

- **顏色**：只用語意 token（`bg-card`、`text-muted-foreground`、`bg-chip-hover`…）。不用 Tailwind 預設色板（`bg-red-500`、`text-white`、`bg-black/50`），不寫 `#fff`、`rgb(…)`。
- **字級**：只有 `text-ui`／`text-body`／`text-tip`／`text-micro` 四階。不用 `text-xs`／`text-sm`／`text-base`／`text-lg`，不寫 `text-[13px]`。
- **表面**：卡片與內層底用 `Surface`，不手寫 `bg-stage shadow-stage`、`bg-card shadow-material rounded-3xl`、`bg-card border rounded-3xl`。
- **展開箭頭**：用 `Chevron`，不手寫 `transition-transform … rotate-180`（或跟著 `data-state=open` 轉的 `rotate-*`）。
- **可展開列**：用 `RowTrigger`，不手寫 `hover:bg-chip-hover active:bg-chip-pressed … w-full … text-left`。
- **對話泡泡**：用 `ChatBubble`，不手寫 `rounded-3xl px-4 py-2.5`。
- **程式碼小框**：用 `MonoBlock`，不手寫 `bg-chip … rounded-lg p-2 font-mono`。
- **多行輸入**：`ui/` 以外不寫原生 `<textarea`，用 `ui/textarea` 的 `Textarea`。
- **時長**：走 `motion.css` 的 token（`duration-(--duration-fast)`、`animation-duration-(--duration-overlay)`），不寫 `duration-200` 這種數字。這條連 `ui/` 一起管。
- **高亮**：程式標出來的那一格（例如「看這一輪」的 `data-revealed`）在 `theme.css` 畫外框，不用 `ring-*`。被程式聚焦的元素 `:focus-visible` 時，ring 會被清掉。
- **焦點外框**：`ui/` 以外不寫 `focus-visible:ring-*`。全域已經畫 outline，`theme.css` 把 ring 清掉了，寫了也畫不出來；配上 `outline-none` 就完全看不到焦點。外框被 `overflow-hidden` 裁掉時用 `focus-visible:-outline-offset-2` 畫在裡面。外框寫在 `theme.css` 的 layer 外，`outline-none` 擋不掉；文字輸入框（`input`、`textarea`）不畫，它們用邊框變色或群組外框；真的自己畫了別的焦點樣子（例如整條變色），標 `data-focus="custom"` 才不畫外框（`styles/focus-outline.test.ts` 守著）。
- **圓角**：走階梯（`rounded-md`…`rounded-3xl`、`rounded-full`）或有名字的 `rounded-row`。不寫 `rounded-[20px]`。
- 需要一個系統裡沒有的值 → **先在規格與 `index.css` 加一階**（有名字、有理由），不要寫任意值。

真的要例外：列進該測試的 `ALLOWED`，附理由。**例外只會變少**：列了卻不再命中的條目會報錯。registry 原文的例外（`ui/`）等它們被改掉或確認要留再處理。

## 字級的主次

四階各有用途（[#1281](https://github.com/DemianLi/nexus-agent/issues/1281)）：

| 階 | 用在 | 例 |
| --- | --- | --- |
| `text-body`（14／23） | 內文，與本來就是內文大小的按鈕、選單項 | 對話、`Button` 預設、下拉選單與 cmdk 的項目、右側欄的分頁鈕 |
| `text-ui`（13／18） | **可以點的**與**當標題的**小字 | `xs` 按鈕、小字的可展開列（思考過程、待辦、送出佇列、觀測與成本分頁的列）、輸入框底列的膠囊鈕、「這一輪的過程」、側欄與 cmdk 的群組標題、成本分頁的區段標題、卡片標頭（工具卡的標題、計劃、等待核准） |
| `text-tip`（12／16） | 小字說明、附註、時間、計數 | 工具名與摘要、`Badge`、tooltip、快捷鍵提示、時間戳、popover 裡數字上面的欄位名、卡片裡單一區塊上面的小標籤（「結果」「呼叫參數」「子代理的對話」）、錯誤與提示句 |
| `text-micro`（11） | 先留著，還沒有地方用 | |

怎麼判：

- **先看能不能點**。按鈕、觸發鈕、選單項本身不縮成 `text-tip`。裡面夾的計數、時間、`font-normal` 附註另外標 `text-tip`，不要跟著外層一起變大。
- **再看是不是在幫一群東西命名**：卡片的標頭、清單或群組的標題、區段標題。不可點的也算；同一欄裡可點的群組標題（側欄「已封存」）與不可點的（「今天」）要一樣大。卡片**裡面**只標一塊內容的小標籤（工具卡的「結果」、提問面板的「呼叫參數」）不是在命名一群東西，是附註，留 `text-tip`。
- **同一串清單的列跟著可點的列走**：觀測分頁的列有能展開的（`ExpandableLine`）與不能展開的（`StaticLine`），兩種都是 `text-ui`，不然相鄰的列一大一小。
- **等寬的內容不是標題**：diff、讀檔、搜尋結果、`MonoBlock`、工具卡上的路徑都留 `text-tip`。路徑本身就是那顆鈕的字時（改動清單的列、審閱分頁選檔案的鈕）才是 `text-ui`。
- **只動 12 的那一層**：已經是 `text-body` 的按鈕與選單不降成 13。

機械判得出來的那一半有護欄：按鈕、`RowTrigger` 與其他觸發鈕、選單項自己的 `className` 寫了 `text-tip`／`text-micro` 就紅（`src/styles/type-hierarchy.test.ts`）；registry 元件的預設字級（`ui/button`、`ui/dropdown-menu` 沒有小字，`xs` 按鈕、側欄的群組標題與 `sm` 選單鈕、cmdk 的群組標題、附件的檔名是 `text-ui`）在 `ui/registry-edits.test.ts`。「是不是標題」判不出來，靠 review。

## 新增自訂 token 要登記 `cn`

`cn`（class 合併）不認得自訂的 `text-*`／`rounded-*` 名，會把字級當字色互相吃掉（2026-10-07 發生過，PR #1144）。所以：

- `index.css` 加了 `--text-<名>` 或 `--radius-<名>`，就到 `src/lib/utils.ts` 的 `createCn` 登記同一個名字。
- **全站只從 `@/lib/utils` 取 `cn`**，不要 `from 'cn'`（`utils.test.ts` 會擋，registry 檔裝進來也要改）。
- 改 class 名的重構，前後比對要量**字級、字色、寬度**的計算樣式，不只高度與截圖。

## 什麼時候抽共用元件

- **兩處以上手寫同一份配方**（不只是名字像）才抽；只有一處就留在原地。
- 只抽**共通的部分**，差異用 `className` 補（例：`RowTrigger` 只含底色、最小高度、圓角、過渡，圖示與間距由呼叫端給）。
- 抽完要證明**畫面沒變**：展開成的 class 集合與原本逐項相等，再加實機前後比對。
- 已抽的：`RowTrigger`（可展開列；`fit="card"` 嵌在卡片裡、用 `rounded-row` 同心，`fit="bare"` 自己就是一列）、`Chevron`（展開箭頭，跟著外層的 `data-state` 轉，或用 `open` 直接給）、`ChatBubble`（對話裡的文字泡泡，人的話靠右、子代理寄來的話靠左）、`MonoBlock`（夾在說明文字裡的等寬字小框，平的 `bg-chip`；工具輸出那種有標題、有細線的內層底是 `Surface tone="stage"`，不是它）、`Surface`（`raised` 浮起來的卡片、`stage` 內層底、`docked` 貼在輸入框上方的平邊線卡片，用 `as` 選元素）。新的卡片或內層底用 `Surface`，手寫整組配方會被護欄擋下。
- 還沒抽的：`pending-swap`（走 `ui/Card` 覆寫，是 shadcn 元件的用法）。

## 新增 shadcn 元件

照規格 §4.1：`shadcn add … --overwrite`，跑 `prettier --write`，把 `from 'cn'` 改成 `@/lib/utils`，檔頭記來源 URL 與版本，把改過且「改回去畫面不會報錯」的地方補進 `ui/registry-edits.test.ts`。AI Elements 一律不裝。

## 測試與說明文件裡的類別名

Tailwind 會掃整個專案找 class，所以**測試檔與 `apps/web/*.md` 裡寫到的類別名也會被編成規則**。`src/index.css` 用 `@source not` 排除了它們，`pnpm build` 最後的 `check-built-css` 會量產物確認；新增別種會寫類別名的檔案（例如別的資料夾的 `.md`），要一併排除，否則建置會失敗。
