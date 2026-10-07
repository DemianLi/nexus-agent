# apps/web 新增元件規則

給「要在 `apps/web` 加元件、改樣式」的人。**值**（色碼、字級、圓角、時長）不在這裡，在 [`.docs/web-ui-spec.md`](../../.docs/web-ui-spec.md)；這裡只講**該放哪、該用什麼、什麼會被擋**。來歷見 [#1141](https://github.com/DemianLi/nexus-agent/issues/1141)。

## 放哪一層

| 層 | 放什麼 | 規則 |
| --- | --- | --- |
| `src/components/ui/` | shadcn registry 裝進來的元件 | 只放 registry 來的；檔頭寫來源與版本；裝法見規格 §4.1。自己的元件不要放這裡 |
| `src/components/*.tsx`（含各資料夾） | 我們自己的元件 | 資料夾按功能分（`tool/`、`todo/`、`sidebar/`…），檔名不重複資料夾名 |
| `src/components/row-trigger.tsx` 這類 | 兩處以上共用的自製積木 | 見下面「什麼時候抽」 |
| `src/lib/` | 不畫畫面的邏輯與投影 | 元件只讀它的結果 |
| `src/styles/`、`src/index.css` | token 與全域樣式 | token 只在這裡定義 |

## 只能用系統的值

`src/styles/design-system.test.ts` 會掃元件原始碼的字串字面值，下面四件事寫了就紅：

- **顏色**：只用語意 token（`bg-card`、`text-muted-foreground`、`bg-chip-hover`…）。不用 Tailwind 預設色板（`bg-red-500`、`text-white`、`bg-black/50`），不寫 `#fff`、`rgb(…)`。
- **字級**：只有 `text-ui`／`text-body`／`text-tip`／`text-micro` 四階。不用 `text-xs`／`text-sm`／`text-base`／`text-lg`，不寫 `text-[13px]`。
- **表面**：卡片與內層底用 `Surface`，不手寫 `bg-stage shadow-stage`、`bg-card shadow-material rounded-3xl`。
- **圓角**：走階梯（`rounded-md`…`rounded-3xl`、`rounded-full`）或有名字的 `rounded-row`。不寫 `rounded-[20px]`。
- 需要一個系統裡沒有的值 → **先在規格與 `index.css` 加一階**（有名字、有理由），不要寫任意值。

真的要例外：列進該測試的 `ALLOWED`，附理由。**例外只會變少**：列了卻不再命中的條目會報錯。registry 原文的例外（`ui/`）等它們被改掉或確認要留再處理。

## 新增自訂 token 要登記 `cn`

`cn`（class 合併）不認得自訂的 `text-*`／`rounded-*` 名，會把字級當字色互相吃掉（2026-10-07 發生過，PR #1144）。所以：

- `index.css` 加了 `--text-<名>` 或 `--radius-<名>`，就到 `src/lib/utils.ts` 的 `createCn` 登記同一個名字。
- **全站只從 `@/lib/utils` 取 `cn`**，不要 `from 'cn'`（`utils.test.ts` 會擋，registry 檔裝進來也要改）。
- 改 class 名的重構，前後比對要量**字級、字色、寬度**的計算樣式，不只高度與截圖。

## 什麼時候抽共用元件

- **兩處以上手寫同一份配方**（不只是名字像）才抽；只有一處就留在原地。
- 只抽**共通的部分**，差異用 `className` 補（例：`RowTrigger` 只含底色、最小高度、圓角、過渡，圖示與間距由呼叫端給）。
- 抽完要證明**畫面沒變**：展開成的 class 集合與原本逐項相等，再加實機前後比對。
- 已抽的：`RowTrigger`（可展開列）、`Surface`（卡片 `raised` 與內層 `stage`，用 `as` 選元素）。新的卡片或內層底用 `Surface`，手寫 `bg-stage shadow-stage` 或 `bg-card shadow-material rounded-3xl` 會被護欄擋下。
- 還沒抽的：`border` 畫邊線的卡片（`queue-dock`、`todo/panel`、`goal-bar`，與 `raised` 的陰影邊緣不同，待決定）、`pending-swap`（走 `ui/Card` 覆寫）。

## 新增 shadcn 元件

照規格 §4.1：`shadcn add … --overwrite`，跑 `prettier --write`，把 `from 'cn'` 改成 `@/lib/utils`，檔頭記來源 URL 與版本，把改過且「改回去畫面不會報錯」的地方補進 `ui/registry-edits.test.ts`。AI Elements 一律不裝。
