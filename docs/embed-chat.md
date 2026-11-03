# 嵌入版對話框 `<nexus-chat>`

宿主頁（例如可視化系統）放一個元素就有一個對話框，不用 iframe。元件用 Shadow DOM，樣式與字型不外洩，宿主頁的樣式也進不來。

## 載入

serve 供應兩個檔，跟網頁同一個來源：

- `/embed.js`：載入就註冊好 `<nexus-chat>`。
- `/nexus-chat.d.ts`：元素的型別。

宿主頁要跟 serve 同源：在宿主頁的伺服器上設反向代理，把 serve 的路徑轉過去。登入沿用 serve 的登入網址換到的會話 cookie。

```html
<script type="module" src="/embed.js"></script>

<div style="height: 600px">
  <nexus-chat theme="auto"></nexus-chat>
</div>
```

元素會填滿父容器，所以父容器要給高度。版面的斷點看元素自己的寬度，不看視窗的寬度。

## 屬性

| 屬性 | 值 | 說明 |
| --- | --- | --- |
| `theme` | `light`、`dark`、`auto` | 預設 `auto`，跟著系統。只改元件裡面，不改宿主頁的 `<html>`。 |
| `context` | 字串 | 情境標籤上顯示的字，例如畫面上目前選取的設備。 |

`context` 也可以用 property 設定，值可以是字串或 `{ label: string }`，設成 `null` 就清掉。`embed.js` 還沒載入、元素還沒升級時就設好的值也會生效。

情境是資料，不是指令：使用者可能選了某一台設備，問的卻是另一台。這一版只把它畫成標籤，不會送給模型。

## 可覆寫的外觀

只開放四個，寫在元素上的 CSS 自訂屬性：

| 屬性 | 套到 |
| --- | --- |
| `--nexus-primary` | 主色（主按鈕） |
| `--nexus-background` | 底色 |
| `--nexus-radius` | 圓角的基準（其餘圓角照比例算） |
| `--nexus-font` | 介面字型。要自己帶中文的後備字型 |

```css
nexus-chat {
  --nexus-primary: #1e3a8a;
  --nexus-radius: 8px;
}
```

主色跟主按鈕上的字、底色跟內文的對比度不到 4.5 時，那一個不套用，退回預設值，並在 console 印一句警告。每次切換亮暗都會重新檢查一次，所以同一個主色可能亮色能用、暗色退回預設。元件只在放上頁面時、以及 `theme` 改變時讀這些屬性。

## Vue

要告訴 Vue 的模板編譯器 `nexus-chat` 是自訂元素，不然 Vue 會把它當成元件去解析：

```ts
// vite.config.ts
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'nexus-chat' } } }),
  ],
});
```

`context` 要用 `.prop` 修飾符綁成 property，物件才會原樣交給元件：

```vue
<nexus-chat :theme="theme" :context.prop="selected === null ? null : { label: selected }" />
```

型別：把 serve 供應的 `nexus-chat.d.ts` 放進專案，加進 `tsconfig` 的 `include`。

## 有什麼功能、沒有什麼功能

有：
- 對話紀錄，包含工具呼叫列與思考摘要；
- 狀態列；
- 輸入框與停止鈕；
- 核准卡與反問面板；
- 情境標籤；
- 「新對話」鈕；
- 回覆底下的回饋鈕。

沒有：
- `/` 與 `@` 選單；
- 模型與權限的選擇；
- 計劃模式、目標、待辦、送出佇列；
- 分叉、側欄與歷史清單；
- 花費；
- 附件上傳。

輸入框送出的一律當成一句話，`/` 開頭也不會當成命令。一輪還在跑時不收下一句，要先按停止。

打開元件時會接上一次的對話（記在瀏覽器的 `nexus.embed.threads.current`，跟獨立頁面分開）；按「新對話」開一條新的。
