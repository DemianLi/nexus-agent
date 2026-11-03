# 嵌入版對話框 `<nexus-chat>`

宿主頁（例如可視化系統）放一個元素就有一個對話框，不用 iframe。元件用 Shadow DOM，樣式與字型不外洩，宿主頁的樣式也進不來。

## 載入

serve 供應兩個檔，跟網頁同一個來源：

- `/embed.js`：載入就註冊好 `<nexus-chat>`。
- `/nexus-chat.d.ts`：元素的型別（以 `application/octet-stream` 回，下載下來放進專案用）。

這兩個路徑是暫時的：最終會放在一個固定前綴底下（例如 `/nexus/embed.js`），前綴由 [#2369](https://github.com/DemianLi/nexus-agent/issues/2369) 決定，定案後這份說明跟著改。

宿主頁要跟 serve 同源：在宿主頁的伺服器上設反向代理，把 serve 的路徑轉過去。登入沿用 serve 的登入網址換到的會話 cookie。

元件的對話請求都打 `/embed/threads/…`，下行的 WebSocket 是 `/embed/threads/mux`。serve 看這個前綴決定這條對話能用什麼：沒有子代理、沒有斜線命令；內建工具沒標唯讀的都要使用者核准，MCP 工具照那一列設定的 `approval`。反向代理要多轉 `/embed/`，獨立頁面的 `/threads` 不用轉。

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

每送出一句話，元件就把當下的情境附在那句話上送給模型；沒有情境就不附。情境是資料，不是指令：使用者可能選了某一台設備，問的卻是另一台，所以模型看到的是「畫面上目前選取 X」，問句自己指名了對象就照問句。

只有空白的值不收（字串或 `label` 都算），跟其他不收的值一樣講一聲、標籤維持原樣。超過 200 字的整句送不出去，不會截斷，宿主頁要自己控制長度。

## 宿主頁工具

宿主頁可以宣告自己的工具給模型呼叫，例如把鏡頭轉到某台設備、把它高亮。用 `hostTools` property 設定（沒有對應的屬性）：

```ts
const chat = document.querySelector('nexus-chat');
chat.hostTools = [
  {
    name: 'focus_device',
    description: '把鏡頭轉到指定的設備。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];
chat.addEventListener('nexus-host-tool', (event) => {
  const { name, args, respond, fail } = event.detail;
  if (name !== 'focus_device') return;
  const found = scene.focus(args.id);
  if (found) respond({ focused: args.id });
  else fail(`找不到設備 ${args.id}`);
});
```

- 每送出一句話，元件就把當下的宣告附在那句話上，跟情境一樣；那一輪模型看到的就是那一份，中途改的要到下一句才生效。
- 模型叫了其中一支，元件在元素上發 `nexus-host-tool` 事件，`detail` 帶 `name`（宣告時的名字）與 `args`（已照 `parameters` 驗過）。執行完呼叫
  `respond(結果)` 或 `fail(原因)`，只算第一次。結果要是 JSON 值；不是的話元件改成錯誤交回。
- 30 秒內沒有交回就當失敗，模型會知道，這一輪接著跑。元件被拿掉時一樣由這個期限收。
- 頁面重新整理後，還沒交回的那幾支會再發一次事件；新的頁面沒宣告那支工具的話，元件直接回「這個頁面沒有這支工具」，不發事件。重新整理前已經執行過的會再執行一次，
  不能重做的動作不要列進免核准名單（見下）。
- 使用者按停止之後才交回的結果會被丟掉。
- 預設每次呼叫都會先出核准卡，使用者核准了才發事件。哪幾支不必問由 serve 的設定決定（`host-tools` 那一列的 `approval.exempt`，見
  [`operations.md`](operations.md)），宿主頁自己標不算。

上限：每次至多 8 支；名字合 `^[a-z][a-z0-9_]{0,31}$`、不重名；說明非空、至多 500 字；`parameters` 是 `type: 'object'` 的 JSON Schema，序列化後至多 4 KiB；
整份序列化後至多 16 KiB；交回的結果序列化後至多 4,000 字。宣告超過上限或形狀不對，元件不收、在 console 講一聲，原本的那份不動；結果超過上限，模型拿到的是一則錯誤。
都不截斷。設成 `null` 或空陣列就清掉。

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

`hostTools` 一樣用 `.prop`，事件用 `@nexus-host-tool`：

```vue
<nexus-chat :hostTools.prop="tools" @nexus-host-tool="onHostTool" />
```

型別：把從 serve 下載的 `nexus-chat.d.ts` 放進專案，加進 `tsconfig` 的 `include`。

## 宿主頁的快捷鍵與指標操作

鍵盤事件會從元件的 Shadow DOM 冒到宿主頁，但 `event.target` 換成了 `<nexus-chat>` 元素本身，看不出使用者正在輸入框裡打字。宿主頁的全域快捷鍵（例如 3D 場景用 W／A／S／D 轉視角）要拿 `composedPath()[0]` 判斷，不然在對話框裡打字也會轉動場景：

```ts
window.addEventListener('keydown', (event) => {
  const origin = event.composedPath()[0];
  const typing =
    origin instanceof HTMLElement &&
    (origin.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(origin.tagName));
  if (typing) return;
  // 宿主頁自己的快捷鍵
});
```

滾輪與拖曳的監聽掛在場景自己的元素上（例如 `<canvas>`），不要掛在 `window`：在對話框上捲動就不會縮放場景，一輪還在回覆時照樣能操作場景。

## 有什麼功能、沒有什麼功能

有：
- 對話紀錄，包含工具呼叫列與思考摘要；
- 狀態列；
- 輸入框與停止鈕；
- 核准卡與反問面板；
- 情境標籤；
- 宿主頁工具；
- 「新對話」鈕；
- 回覆底下的回饋鈕。

沒有：
- `/` 與 `@` 選單；
- 模型與權限的選擇；
- 計劃模式、目標、待辦、送出佇列；
- 分叉、側欄與歷史清單；
- 花費；
- 附件上傳（空白畫面也不提「把檔案拖進來」）；
- 改動卡（差異檢視）。

輸入框送出的一律當成一句話，`/` 開頭也不會當成命令。一輪還在跑時不收下一句，要先按停止。

打開元件時會接上一次的對話（記在瀏覽器的 `nexus.embed.threads.current`，跟獨立頁面分開）；按「新對話」開一條新的。獨立頁面開的對話在元件裡打不開，元件會說明並請使用者按「新對話」。
