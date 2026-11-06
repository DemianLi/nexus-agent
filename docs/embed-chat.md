# 嵌入版對話框 `<nexus-chat>`

宿主頁（例如可視化系統）放一個元素就有一個對話框，不用 iframe。元件用 Shadow DOM，樣式與字型不外洩，宿主頁的樣式也進不來。

## 載入

宿主頁要跟 serve 同源：在宿主頁前面放一台反向代理，把 `/nexus/` 底下的請求去掉前綴後轉給 serve，其餘路徑轉給宿主頁自己的伺服器。設定與 nginx 範本見 [`operations.md`](operations.md) 的〈放在反向代理後面〉。

serve 在 `/nexus/` 底下供應兩個檔：

- `/nexus/embed.js`：載入就註冊好 `<nexus-chat>`。
- `/nexus/nexus-chat.d.ts`：元素的型別（以 `application/octet-stream` 回，下載下來放進專案用）。

元件照 `embed.js` 自己的網址找 serve：從 `/nexus/embed.js` 載入，對話請求就打 `/nexus/embed/threads/…`，下行的 WebSocket 是 `/nexus/embed/threads/mux`，字型在 `/nexus/assets/…`，全都落在 `/nexus/` 這一條裡，代理不用另外轉別的路徑。serve 看 `/embed` 這段決定這條對話能用什麼：沒有子代理、沒有斜線命令；內建工具沒標唯讀的都要使用者核准，MCP 工具照那一列設定的 `approval`。

登入：使用者先開 serve 啟動時印的登入網址（`https://<宿主頁的網域>/nexus/?token=…`），serve 設好會話 cookie 後轉到 `/nexus/`，也就是獨立頁面；之後開宿主頁，元件就帶著這個 cookie。cookie 只送給 `/nexus/`，宿主頁自己的路徑收不到。

換票登入（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）：宿主系統的後端用服務憑證打 `POST /nexus/embed/exchange`，替使用者換一張一次性的登入票；元件拿票打 `POST /nexus/embed/session`，兌換一顆只打得到嵌入路由的 cookie，見 [`operations.md`](operations.md) 的〈嵌入方換票登入〉。元件收票的入口是 `signIn`，見〈[換票登入](#換票登入)〉。

同源的代價：宿主頁上執行的任何腳本，都能以使用者的身分打 `/nexus/` 底下的 API。cookie 是 `HttpOnly`，腳本讀不到它，但發得出帶著它的請求。宿主頁載入哪些腳本，跟元件一樣要信得過。

同源是雙向的：serve 在 `/nexus/` 供應的頁面跟宿主頁共用沒標 `HttpOnly` 的 cookie、`localStorage` 與 `sessionStorage`。

- serve 的頁面讀得到宿主頁沒標 `HttpOnly` 的 cookie 與 storage，所以宿主頁的會話 cookie 要標 `HttpOnly`。
- nexus 寫進 `localStorage` 的鍵都以 `nexus.` 開頭。
- nexus 的頁面不寫 cookie，唯一的 cookie 是 serve 設的會話 cookie。serve 發的是 `Path=/`，照 [`operations.md`](operations.md) 的〈放在反向代理後面〉nginx 範本架代理時，`proxy_cookie_path` 把它改成 `/nexus/`，宿主頁自己的路徑收不到。〈[開發伺服器的設定](#開發伺服器的設定)〉的 Vue CLI 與 Vite 寫法不改 `Path`，開發時這顆 cookie 會送到開發伺服器的每個路徑；cookie 不分 port，同一台電腦上 `localhost` 其他 port 的伺服器也收得到。

開發時在自己的電腦接上另一台主機上的 serve，見〈[開發時接上另一台主機的 serve](#開發時接上另一台主機的-serve)〉，有 [Vue CLI（webpack）](#vue-cliwebpack) 與 [Vite](#vite) 兩種寫法。

```html
<script type="module" src="/nexus/embed.js"></script>

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
- 模型叫了其中一支，元件在元素上發 `nexus-host-tool` 事件，`detail` 帶 `id`（這次呼叫的身分）、`name`（宣告時的名字）與 `args`（已照 `parameters` 驗過）。執行完呼叫
  `respond(結果)` 或 `fail(原因)`，只算第一次。結果要是 JSON 值；不是的話元件改成錯誤交回。
- 沒在期限內交回就當失敗，模型會知道，這一輪接著跑。期限預設 30 秒，由 serve 的設定決定（`host-tools` 那一列的 `timeoutMs`）。元件被拿掉時一樣由這個期限收。
- 頁面重新整理後，還沒交回的那幾支會再發一次事件，不會再出核准卡；新的頁面沒宣告那支工具的話，元件直接回「這個頁面沒有這支工具」，不發事件。執行了但還沒交回就
  重新整理的，新的頁面會再收到一次，`id` 跟上一次相同；不能重做的動作，宿主頁要以 `id` 記住做過了沒有（例如存在 `sessionStorage`）。
- `hostTools` 與監聽要在元素放進頁面之前、或同一個 task 裡設好：元件一連上就會補發還沒交回的那幾支，那時還沒宣告的會被回「這個頁面沒有這支工具」，還沒掛監聽的
  沒人接，要等到期限才失敗。
- 使用者按停止之後才交回的結果會被丟掉。
- 預設每次呼叫都會先出核准卡，使用者核准了才發事件。哪幾支不必問由 serve 的設定決定（`host-tools` 那一列的 `approval.exempt`，見
  [`operations.md`](operations.md)），宿主頁自己標不算。

上限：每次至多 8 支；名字合 `^[a-z][a-z0-9_]{0,31}$`、不重名；說明非空、至多 500 字；`parameters` 是 `type: 'object'` 的 JSON Schema，序列化後至多 4 KiB；
整份序列化後至多 16 KiB；交回的結果序列化後至多 4,000 字。宣告超過上限或形狀不對，元件不收、在 console 講一聲，原本的那份不動；結果超過上限，模型拿到的是一則錯誤。
都不截斷。設成 `null` 或空陣列就清掉。

## 換票登入

宿主系統已經有自己的登入時，不用讓使用者再開一次登入網址：宿主系統的後端替這位使用者換一張一次性的登入票（[`operations.md`](operations.md) 的〈嵌入方換票登入〉），交給頁面，頁面呼叫 `signIn`：

```ts
const chat = document.createElement('nexus-chat');
const { expiresAt } = await chat.signIn(ticket); // 毫秒時間戳：嵌入 cookie 什麼時候失效
container.append(chat);
```

- **只有方法，沒有屬性**：票不寫進 DOM，元件也不把它存在任何地方。服務憑證只放在宿主系統的後端，不能進瀏覽器。
- **成功之後**：元件改接這位使用者這一次登入最新開的那一條對話（serve 在兌換的回應裡給），沒有就開一條新的。下行的連線改開新的一條，舊的關掉：連線建立時才看 cookie。
- **換過票就不用瀏覽器記的上一條**：沒換過票時，元件把上一條記在 `localStorage` 的 `nexus.embed.threads.current`，下次打開接著它；換過票就不讀也不寫這個鍵，每次換票成功都把它清掉。同一台電腦換人登入，不會接到上一個人的對話。
- **先換票再放進頁面**：放進頁面的那一刻還沒換過票，元件就照沒換過票的方式先接上一條，換票之後才改過來。
- **失敗時** reject 一個 `NexusSignInError`，畫面不動。看 `code` 決定下一步：

| `code` | 什麼時候 | 宿主頁怎麼辦 |
| --- | --- | --- |
| `ticket_invalid` | 票不存在、用過了（一張票只能兌換一次），或 serve 重啟過 | 再換一張票 |
| `ticket_expired` | 票換來之後太久才兌換（預設 60 秒） | 再換一張票 |
| `identity_rejected` | 這位使用者不在 serve 的身分對應表上，或對應被撤了 | 請管理者查對應表；再換票也一樣 |
| `sign_in_failed` | 其他：票不是非空字串（不發請求）、網路斷了、serve 沒開換票、回應看不懂 | 看 `status` 與 `message` |

續期就是再換一張票、再呼叫一次 `signIn`。每一次 `signIn` 都重接一次：下行重開，改接 serve 回的那一條（沒有就開新的），所以畫面上這一條還沒落盤（例如剛按「新對話」、還沒講話）時，續期之後接不回它；一輪正在跑時續期，下行會重開、重讀歷史。快到期時元件發事件通知宿主頁換票，還沒做（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）。

換過票的元件只打得開這位使用者自己開的對話。碰到別人的，元件說「這不是你的對話」，請使用者按「新對話」，不會一直重試。

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

## 開發時接上另一台主機的 serve

宿主頁的工程師在自己的電腦開前端的開發伺服器（Vue CLI 或 Vite），把 `<nexus-chat>` 接到同一個區網裡另一台主機上的 serve（跑在 docker）。這只用在開發與聯調；正式部署照〈載入〉在宿主頁前面放反向代理。

serve 沒給 `--trusted-host` 時只收 Host 是 loopback 的請求；Origin 有帶的話，要跟 Host 是同一個 authority，不然回 403。工程師開 `http://localhost:<port>`，開發伺服器的 proxy 設 `changeOrigin: false`，轉出去的 Host 仍是 `localhost:<port>`；Origin 也要原樣轉出去，兩條才都過。瀏覽器看來頁面、`embed.js` 與 API 同源，serve 不用開 CORS。

### serve 那台主機

serve 只綁容器裡的 `127.0.0.1`，區網連不進去。在 serve 容器的網路命名空間裡放一支轉送代理，原樣轉送所有路徑，包含 WebSocket 升級：

```js
// dev-proxy.mjs：把區網進來的請求轉給同一個網路命名空間裡的 serve，含 WebSocket 升級。
// Host 與 Origin 要原樣轉送：serve 沒給 --trusted-host 時只收 loopback 的 Host，帶了 Origin 就要跟 Host 同一個 authority，改寫哪一個都會讓 API 與 WebSocket 回 403。
import { createServer, request } from 'node:http';
import { connect } from 'node:net';

const SERVE_PORT = Number(process.env.SERVE_PORT ?? 8787);
const PORT = Number(process.env.PORT ?? 8080);

const server = createServer((req, res) => {
  const upstream = request(
    { host: '127.0.0.1', port: SERVE_PORT, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = connect(SERVE_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, '0.0.0.0', () => console.log(`dev-proxy :${PORT} → 127.0.0.1:${SERVE_PORT}`));
```

代理跟 serve 共用網路命名空間，所以 port 要開在 **serve 容器**上：起 serve 的 `docker run` 加 `-p <主機的區網 IP>:18080:8080`。代理這樣起（serve 的 `--port` 不是預設的 8787 時，加 `-e SERVE_PORT=<port>`）：

```bash
docker run -d --name nexus-dev-proxy --network container:<serve 容器> \
  -v <dev-proxy.mjs 所在目錄>:/proxy:ro node:22-bookworm-slim node /proxy/dev-proxy.mjs
```

### 開發伺服器的設定

兩種開發伺服器的做法相同，只是寫法不同：

- 元件從 `/nexus/embed.js` 載入。`/nexus/` 開頭的請求去掉前綴後轉給 serve，只有這一條：`embed.js`、型別 `nexus-chat.d.ts`、字型（`/nexus/assets/…`）、API（`/nexus/embed/threads/…`）與下行的 WebSocket（`/nexus/embed/threads/mux`）都走它，所以這一條要轉 WebSocket（`ws: true`）。
- 頁面裡這樣放：

  ```html
  <script type="module" src="/nexus/embed.js"></script>
  ```

- 型別從 `http://localhost:<port>/nexus/nexus-chat.d.ts` 下載。

#### Vue CLI（webpack）

`vue.config.js`：

```js
const { defineConfig } = require('@vue/cli-service');

const nexus = { target: 'http://<serve 主機的區網 IP>:18080', changeOrigin: false };

module.exports = defineConfig({
  chainWebpack: (config) => {
    config.module
      .rule('vue')
      .use('vue-loader')
      .tap((options) => ({
        ...options,
        compilerOptions: { ...options?.compilerOptions, isCustomElement: (tag) => tag === 'nexus-chat' },
      }));
  },
  devServer: {
    proxy: {
      '^/nexus/': { ...nexus, ws: true, pathRewrite: { '^/nexus': '' } },
    },
  },
});
```

- **`isCustomElement` 要設給 vue-loader。** `.vue` 檔在建置時就編譯好了，`app.config.compilerOptions` 只管執行期編譯的模板，對 `.vue` 檔沒有作用。
- **登入不能靠比對 `/?token=`。** `@vue/cli-service` 把每一條的 key 拿去對 URL 的路徑部分做 `pathname.match(key)`，比不到 query；在那一條另外寫函式形式的 `context` 也一樣，`/?token=` 仍由開發伺服器回自己的首頁。登入改走 `/nexus/`（見下面〈登入〉）。
- key 沒有寫 `^` 的話，路徑中間有出現也算比中。
- 宿主自己 `public/assets/` 底下的檔照常由開發伺服器回；改了 `.vue` 檔照常熱更新。

#### Vite

`vite.config.ts`：

```ts
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const nexus = { target: 'http://<serve 主機的區網 IP>:18080', changeOrigin: false };

export default defineConfig({
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'nexus-chat' } } })],
  server: {
    proxy: {
      '^/nexus/': { ...nexus, ws: true, rewrite: (path) => path.replace(/^\/nexus/, '') },
    },
  },
});
```

Vite 不改 Origin。key 用 `^` 開頭的 RegExp：字串 key 比的是前綴，`/embedded.html` 這類自己的路徑也會被轉走。Vite 自己的路徑（`/@vite/client`、原始碼、HMR 的 WebSocket）不受影響，改了 Vue 檔照常熱更新。只驗過 `vite`，沒驗過 `vite preview`。

### 登入

架 serve 的人從容器日誌裡 serve 印出的網址取出 `token`，交給工程師。工程師開 `http://localhost:<port>/nexus/?token=<token>`：請求經 `/nexus/` 那一條轉給 serve，serve 設好 cookie 之後 303 到 `./`，落在 `/nexus/`，也就是 serve 的獨立頁面；再開工程師自己的頁面，元件就帶著這個 cookie。`token` 不必是第一個參數。

### 注意事項

- **一定要開 `localhost:<port>`。** 開發伺服器印的 Network 網址（`http://<IP>:<port>`）帶的 Host 不是 loopback，API 與 WebSocket 全部回 403。
- **元件為什麼掛在 `/nexus/` 底下：** 為了不佔用宿主頁自己的 `/assets`。`embed.js` 照自己的網址找字型（`./assets/…`），從 `/embed.js` 載入的話，就要把 `/assets` 整條轉給 serve。宿主頁自己的 `assets/` 會跟它撞路徑：以 Vite 為例，proxy 排在 Vite 自己的檔案之前，專案 `public/assets/` 底下的檔會被轉給 serve、回 404。掛在 `/nexus/` 底下，字型跟著落在 `/nexus/assets/`，API 與 WebSocket 也跟著落在 `/nexus/embed/…`。

### 代價與限制

- **只限開發。** 代理對區網開放之後，同網段任何人都能帶 `Host: localhost` 打進來，擋人的只剩 token；走 HTTP 時，token 與 cookie 在區網上是明文。
- 多位工程師共用同一顆 token。要分人，就要設好嵌入方與身分對應表，由後端替每個人換票，見〈[換票登入](#換票登入)〉。
- 兩台機器之間的防火牆要放行代理的 port。
