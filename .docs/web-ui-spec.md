# nexus web 介面規格：P0 元件、設計 token、動效與無障礙

**狀態**：規格已拍板（2026-09-18），**待實作**。來源是地圖 [#372 web 介面重做](https://github.com/DemianLi/nexus-agent/issues/372) 的八張卡；原型定版在 tag [`proto-375-design-language`](https://github.com/DemianLi/nexus-agent/tree/proto-375-design-language)（`61cc564`）。

**用途**：交給實作的那一份。讀完這份就知道 P0 要做什麼、每個元件從哪裡拿、token 與動效的規則、無障礙要做到哪、原型哪些可以直接搬、實作必須帶哪些測試。**怎麼切實作卡不在這份**（地圖把它排在終點之外）。

## 結論速查表

| 問題 | 結論 | 在 |
| --- | --- | --- |
| 誰是準的 | 理由在卡片（凍結）、現行規則在這份、數字在程式碼 | §1 |
| UI/UX 的依據 | shadcn＋Tailwind 是基底，Libraries.dev 是模仿對象；dsh 只參考元件多樣性 | §3 |
| 元件從哪裡拿 | 主用 shadcn 官方；AI Elements 只參考清單、不用程式碼；registry 檔裝進來就是我們的原始碼 | §4 |
| 核准與提問放哪 | **換掉輸入框**（隱藏不卸載），同時只一個面板、先來先處理 | §4.3 |
| 顏色怎麼定 | oklch 語意 token 直接寫值；Leonardo＋WCAG 2.x 解出來；亮暗鑑別度一樣 | §5 |
| 邊框怎麼畫 | 畫在陰影裡，同一元素不同時用 `border` 與陰影 | §5 |
| 字型 | Google Sans Flex／Google Sans Code，中文退 Noto Sans TC，**全部打包進本地** | §5 |
| 亮暗切換 | header 循環三態、預設跟系統、`localStorage`、`index.html` 內嵌腳本防閃、不裝 `next-themes` | §6 |
| 動效 | 純 CSS＋`tw-animate-css`；封閉模式清單；開 250／關 150；reduced-motion 分模式退 | §7 |
| 無障礙 | WCAG 2.2 AA＋APG＋Radix 內建；焦點只在會丟掉時才搬 | §8 |
| 斷點 | 1024（以下收成抽屜）；驗收 375／768／1280 | §9 |
| 原型哪些能搬 | 主題、token、模式規則、registry 改法直接搬；原型 App 只當參考 | §10 |
| 實作必須帶的測試 | 11 條絆索 | §11 |

## 1. 怎麼用這份文件

三層，各有一個家，**同一個東西只寫在一個地方**：

| 層 | 家 | 會不會再改 |
| --- | --- | --- |
| **為什麼**（當初的取捨、查過的事實、被否決的選項） | 各卡的結論留言 | **不會**。那是拍板當下的快照，之後改規則也不回頭追改 |
| **現行規則**（要做什麼、做到哪、目標值與階梯） | 這份文件 | 規則改了就改這裡 |
| **解出來的值**（oklch 色碼、陰影疊層、alpha、對比度實測） | token 產生器與它的產物（§5、§10） | 改了就重跑產生器 |

**數字寫不寫進這份的判準**：改這個數字要不要重跑產生器。不用的是**決定**（圓角階梯、字級、時長、斷點、對比度目標），寫在這裡；要的是**解**，不寫在這裡。

## 2. 範圍

**要做**：inventory [§2](agent-ui-element-inventory.md) 的 P0 與純前端列，也就是 §4 那張表。

**明確不做**（實作時最容易誤做的；完整清單見地圖 Out of scope）：

- **P1 元件**：reasoning、連線狀態、todo、goal、plan mode、context 用量、佇列、子代理血緣、附件——都要先補 harness／wire。其中佇列 2026-09-26 由 [#645](https://github.com/DemianLi/nexus-agent/issues/645) 做了（伺服器端的送出佇列，#637），形狀見 §4.2 第 29 列。
- **320px 與 1920px 以上的驗收**：只驗三個寬度（§9）。
- **Libraries.dev 的視覺複刻**、暗色專用：走風格參考，保留亮暗兩套。
- **nexus 沒有的產品面**：設定頁、工作區挑選、dock 分割版面、右側欄裡的檔案樹與終端、語音、生圖特效。右側欄本身 2026-09-25 由 [#640](https://github.com/DemianLi/nexus-agent/issues/640) 做了（一格停靠＋分頁，形狀見 §9），這一句原本把整個右側欄列在這裡，是 #372 那一輪的範圍。

## 3. 基底與依據

- **shadcn＋Tailwind 是基底**；**[Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) 是模仿對象**（元件多樣性、交互體驗、動效呈現）；最後長成我們自己的系統風格。
- **dsh 在 UI/UX 上最多只參考元件多樣性**，不寫「偏離 dsh」的標註（[AGENTS.md「技術實現標準」](../AGENTS.md)）。先前以「照 dsh」寫下的 UI 行為（markdown 自建、工具依名分類、1024 收側欄、觸控 44px、核准獨立成卡）照舊，只是依據不再是 dsh。
- **動到執行語意的仍照 dsh**，唯一寫明的例外是提問面板的 ❌（§4.3）。
- **完全內網**：字型、動效 CSS 等資源一律打包進本地，執行期不打外部 CDN。
- Libraries.dev 讀的是 `b300ff8`（inventory 調研時 `44fef85`）；標題字 Saans 沒附授權，**不拿**。

## 4. 元件

### 4.1 安裝程序

1. `shadcn add … --overwrite`（shadcn 4.21.0 實測）。**不加 `--overwrite` 時非互動安裝會卡在覆寫提問、exit 0 靜默中止、檔案寫一半**——判準是實際寫入的檔，不是 exit code。
2. 舊版 `button.tsx` 讓 registry 版覆寫（default／secondary／destructive 少了 `shadow-xs`、outline 暗色改 `bg-input/30`、多四種尺寸與 `data-variant`／`data-size`；原型並排比過，沒有異議）。
3. `shadcn migrate cn`：`cn` 統一成 `cn` 套件，`@/lib/utils` 變成 `export { cn } from "cn"`，`clsx`、`tailwind-merge` 移除。**`@radix-ui/react-slot` 會殘留**，覆寫 button 後已經沒人用，要手動拿掉。
4. 對寫入的檔跑 `prettier --write`（registry 檔全數過不了 `format:check`，**不排除**）。
5. **registry 檔裝進來就是我們的原始碼**：照 repo 規範改，檔頭記來源 URL 與版本，之後不靠重跑 `shadcn add` 更新。
6. 提問的 `questionnaire` 只能從 `radix-vega` 風格裝（new-york 404），要用完整網址。

**AI Elements 一律不裝**（`tool`、`message`、`question`、`reasoning`…），只參考它有哪些元件。`reasoning`／`message` 會把主 chunk 拉到約 2 MB（streamdown＋mermaid，tree-shake 不掉）。

### 4.2 逐列來源

**這張表只住在這裡**（卡片留言是當時的快照）。列號對應 inventory §2。

| 列 | 元件 | 來源 | 現有檔案 |
| --- | --- | --- | --- |
| 1 | App 殼 | shadcn `sidebar` | — |
| 2 | 手機抽屜 | shadcn `sheet` | — |
| 3 | 主題切換 | 自建（§6） | — |
| 6 | 會話列表 | shadcn `SidebarMenu*` | `thread-list.tsx` 留邏輯、換外殼 |
| 7 | 空白狀態 hero | 自建（shadcn 基礎件＋breathing orb） | — |
| 9 | 歷史往回捲 | shadcn `message-scroller`（帶 `@shadcn/react`） | — |
| 10／11 | 使用者／助理訊息 | shadcn `message`＋`bubble`；**markdown 自建**：`mdast-util-from-markdown`＋`micromark-extension-gfm`＋增量解析＋`cjkFriendlyStrong` | `transcript.tsx` 留（歸屬、狀態字面） |
| 13 | 工具卡 | 自建，shadcn `collapsible`＋`badge`，直接吃四格 `ToolEntry.status`；浮起來（material），輸入輸出放內層 stage | 在 `transcript.tsx` |
| 14 | 工具專屬呈現 | 自建：依工具名分類（`classifyTool`）＋通用卡兜底，分哪幾類照 nexus 實際工具名定；高亮 `shiki/core`（ts／bash／json 靜態、其餘 `import()`）、數學 `katex` | — |
| 15／22 | 子代理歸屬、決定紀錄 | 自建＋shadcn `badge` | 在 `transcript.tsx` |
| 21 | 核准 | 自建，shadcn `card`＋`button`，換掉輸入框（§4.3） | `approval-card.tsx` 留邏輯 |
| 23 | 提問 | shadcn `questionnaire`（`radix-vega`）＋§4.3 的補件 | `question-card.tsx` 被取代 |
| 26 | 輸入框 | shadcn `input-group`＋`textarea` | 在 `App.tsx` |
| 27 | slash 選單 | shadcn `command` | 在 `App.tsx` |
| 29 | 送出佇列 | 自建，shadcn `collapsible`＋`button`＋`textarea`；行為照 dsh `QueueDock`（一件直接畫、兩件以上收合、就地改與刪、沒有插話）；新項目撐過 200ms 才畫、只淡入淡出不 stagger；放在待辦面板下、換手區外，停在核准點時照樣看得到 | `queue-dock.tsx` |
| 31 | 狀態列 | 自建（shimmer、orb 見 §7） | `status-line.tsx` 留 |
| 35 | 讚踩＋回饋框 | 框換 shadcn `dialog`，表單邏輯留；讚踩按鈕留在 `transcript.tsx` | `feedback-dialog.tsx` 換外殼 |
| 36 | Toast | shadcn `sonner`，**改成收 `theme` prop、拿掉 `next-themes`** | — |

### 4.3 核准與提問

出處：[核准與提問](https://github.com/DemianLi/nexus-agent/issues/376#issuecomment-5709355235)、[無障礙](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797)。

- **兩種都換掉輸入框**。輸入框用 `hidden`＋`inert` 隱藏**不卸載**，草稿保留（原型早期的 `Swap` 是卸載，會丟草稿，不能照抄）。
- **同時只一個面板、先來先處理**，面板名稱帶跨面板進度「（1／2）」。
- **核准面板**：只有允許／不允許，沒有 ❌、沒有停止、不可收起。只有在允許的決定交集為空時，才顯示原因、摺疊原始中斷，並出現「停止這一輪」（送出不在清單上的決定會讓基座拋錯）。
- **提問面板**：每題有選項時附一列「輸入你的答案」（單選填字就取代選項、多選並存）；可收起；可上下題、送出前回頭改；單選自動跳下一題（**只認指標選取**，§8）。
- **提問的 ❌＝停止這一輪，拿掉「放棄整組」**。這是**寫明的例外**：dsh 的取消是放棄後這一輪繼續，我們表達得出來，是 demian 選擇不讓模型接著猜。停止後那張提問工具卡直接展開、列出題目與選項，標「已停止，請直接打字回覆」。
- **答完**：`ask_user_question` 的工具卡上列「問題 → 回答」（按 id 配對，配不起來退成「已回答 N 題」）；拿掉 `transcript.tsx` 的 `answerSummary`，重寫 `App.tsx` 的 `stuck` 邏輯（它的「解鎖輸入框」本來就是假出口）。
- **`questionnaire` 要補**：自由作答列、單選自動跳、中文進度（primitive 寫死 `Question ${n} of ${total}`）、真的渲染 `QuestionnaireError` 並給中文訊息、數字快捷鍵、❌ 的位置、跨面板進度、收起／展開、legend 前的 sr-only 題號。

## 5. 設計 token

出處：[設計 token 定稿](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498)。**色碼與完整對比度表不在這裡**，在 `apps/web/tokengen/token-table.md` 與 `apps/web/src/styles/tokens.generated.css`（產生器 `apps/web/tokengen/generate.mjs`，`pnpm --filter @nexus/web tokens:gen`）。

**顏色**
- 全部 oklch，**語意 token 直接寫值**，不另建色板層；registry 帶進來的 `--sidebar-*` 由 `hsl()` 轉掉。
- `--primary` **無彩**。另加 `--brand`／`--brand-soft`，**只**用在連結、info、核准與提問面板的邊框光。
- 補 `--success`／`--warning`／`--info`（Tailwind green／amber／blue 當關鍵色），error 沿用 `--destructive`。
- 原型另加的名字：`--stage`、`--chip`／`--chip-hover`／`--chip-pressed`、`--card-hairline`、`--material-shadow`／`--menu-shadow`／`--card-shadow`、`--beam-*`。

**對比度目標**（Leonardo `@adobe/leonardo-contrast-colors`＋WCAG 2.x；表面層用 colorjs.io 逐對解）
- 文字 ≥ 4.5，非文字 ≥ 3（SC 1.4.11）；狀態色對**底色** **5.2**（產生器的解目標，讓暗色狀態色對卡片仍過 4.5）；brand 在亮色底色上 ≥ 4.5。
- **亮暗鑑別度一樣**：兩主題共用一組目標，取兩主題較強者；起算點是原型 `eb800a1` 認可的對比度。
- 不用 APCA（2023-07 已從 WCAG 3 草稿移除）。人工抽驗用 Vispero Colour Contrast Analyser，CI 用 colorjs.io 重算（§11）。

**形狀**
- 圓角重綁 Tailwind 階梯：`sm` 6、`md` 8、`lg` 12、`xl` 14、`2xl` 16、`3xl` 24；按鈕 `rounded-full`。不用 superellipse。
- **邊緣畫在陰影裡**：同一元素不同時用 `border` 與陰影；細線 1px；registry 元件裝進來時把 `border` 換成陰影 token。亮色＝外環＋投影，暗色＝inset 疊層。
- 邊框光的靜態補償（亮色線 2px、光暈 brand 60% 28px、呼吸下限 .55；暗色 1.5px、30% 24px、.3）沿用原型值。

**字型**
- 介面 **Google Sans Flex**；等寬 **Google Sans Code**，只用在程式碼、工具輸入輸出、終端機；中文兩者都退 **Noto Sans TC**（所以介面上的中文實際是 Noto Sans TC）。
- 三套都用 `@fontsource-variable/*` 打包（OFL，自帶 unicode-range 切片；原型建置 120 檔 5.2 MB，零外部請求）。
- 字級 UI 13、內文 14／23、tooltip 12、微標籤 11（`@theme` 的 `text-ui`／`text-body`／`text-tip`／`text-micro`）；**字重只用 400／500**（`semibold`、`bold` 落在 500）。

**互動狀態**
- 焦點外框 `outline: 2px solid` 文字色、`offset 2px`；registry 的 `ring-[3px]` 關掉。
- chip 階梯（rest／hover／pressed）、主按鈕 hover／active、disabled `.6`。

**Tailwind layer 的坑**：body 的底色、字色、`color-scheme` **寫在 layer 外**。寫在 `@layer base` 時，頁面被嵌進任何帶 reset 的外殼，暗色會變成黑底深字（原型在 Artifact 裡踩過）。

## 6. 亮暗三態

出處：[亮暗三態切換](https://github.com/DemianLi/nexus-agent/issues/391#issuecomment-5722962752)。

- header 一顆圖示鈕**循環三態**（淺／深／跟系統），**預設跟系統**，切換不做動效。
- 偏好存 `localStorage`，key `nexus.theme.preference`。存後端做不到：wire 協定封閉，也沒有「使用者」可以掛。
- **首屏不閃**靠 `apps/web/index.html` 的內嵌腳本（沒有 SSR、harness 不送 HTML）。**不裝 `next-themes`**。
- 真正套 class 的程式放 `main.tsx` 的 `createRoot` 之前；hook 讀系統偏好前先確認 `typeof window.matchMedia === 'function'`（jsdom 沒有）；**不加 `setupFiles`**。
- 跟隨系統時監聽系統偏好（`addEventListener`）；跨分頁監聽 `storage` 事件。
- 一併補：`color-scheme`（整個專案現在都沒設）；dark variant 改成 `&:is(.dark, .dark *)`。

## 7. 動效

出處：[動效策略](https://github.com/DemianLi/nexus-agent/issues/378#issuecomment-5718598887)。完整互動對照表與持續狀態的節奏在該留言。

**底層**
- **純 CSS**，`thinking-orbs`、`border-beam` 不進 `apps/web`。
- **裝 `tw-animate-css`**：registry 的 dialog／sheet／tooltip 寫了 `animate-in` 等 class，沒裝時建置出來一筆都沒有，也不報錯。
- 在 `@theme`（**不用 `inline`**）覆寫 `--animate-in` 250ms／`--animate-out` 150ms、曲線 `--ease-smooth-out: cubic-bezier(0.22, 1, 0.36, 1)`。覆寫後 registry 的 `duration-*` 蓋不掉，單獨改用 `animation-duration-*`。
- 進場 fill-mode `backwards`，退場 `both`。

**token**：時長、曲線、位移、縮放、模糊、resize 整組照 Libraries.dev（時長 40／80／150／250／350／400／500，位移 4／6／8／12／30，縮放 .96–.99，模糊 2／3／8，resize 300），外加 `--duration-press` 120、`--duration-overlay` 200、`--auto-advance-delay` 200。

**模式清單封閉**：浮層彈出、對話框、側滑抽屜、換內容、展開收合、進場、進度、按壓、持續狀態。清單外沒有動效，只留 100–150ms 顏色過渡。

| 互動 | 開／關 |
| --- | --- |
| 下拉、popover、指令選單 | 250／150，scale .97／.99（popover 與指令選單在 [#407](https://github.com/DemianLi/nexus-agent/issues/407) 的真 Chrome 量過：開 250、scale .97、曲線 smooth-out、fill backwards；關 150、scale .99、fill both；reduced-motion 只剩 150 淡入淡出。**下拉還沒有這個元件，沒驗過**） |
| tooltip | 150（延遲 50）／150，只淡入＋blur 3px |
| 對話框 | 250／150，scale .96；遮罩 200 |
| 手機側欄（<1024） | 350／250 |
| 桌面側欄收合、面板高度差 | resize 300 |
| 工具卡展開、提問面板收起 | 250／150，高度＋透明度 |
| 新訊息、工具卡出現 | 250，往上 8px |
| 面板換掉輸入框、上下題 | 舊 150 淡出 → 新 250 長出；上下題有方向 |
| 單選自動跳 | 先停 200 |
| 用量環的弧長（[#528](https://github.com/DemianLi/nexus-agent/issues/528)） | 250 smooth-out；reduced-motion 直接跳到新值 |

- **按壓 .96（120ms）只給實心主按鈕與送出鍵**。
- **stagger 40ms 只給提問選項**（前 6 個）。
- **不動的**：載入歷史與切換對話、串流逐字（只有游標閃）；sonner 用它自帶的動畫與 reduced-motion（全關，跟我們「留 150 淡入」不同，已知差異）。
- **orb** P0 只做 working 與 breathing。

**reduced-motion**（不是全關；實作寫 `@media (prefers-reduced-motion: reduce)`，原型的 `data-reduce-motion` 屬性只是模擬）
- 位移、縮放、模糊拿掉，留 ≤ 150 的透明度；尺寸瞬間到位；按壓不縮；循環停一格；**狀態不能只靠動效表達**。
- 做法：media query 裡把 `--animate-in`／`--animate-out`／`--animate-collapsible-*` 換成只有透明度的版本。
- JS 的 `scrollTo({ behavior: 'smooth' })` 不看 CSS，要自己讀偏好。

**效能**：持續動畫只動 transform／opacity，唯一例外是執行中邊框光的 conic 角度（同時最多一個）；blur 只給小元素；`will-change` 不常駐。CPU 降速 6 倍量過 60fps，不需要退路。

## 8. 無障礙

出處：[無障礙](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797)。

**依據**：WCAG 2.2 AA 定門檻 → WAI-ARIA APG 定模式 → Radix 與 `@shadcn/react` primitive 的內建行為當基底。

**焦點**
- **只在焦點本來會丟掉時才搬**（在輸入框裡或已經在 body）。人在別處就不搶，由狀態列報讀。
- 核准落在面板本身（`tabIndex=-1` 的 region），**不能落在按鈕上**；提問落在當前題的 fieldset。
- 面板收掉：有下一個待決就到下一張，沒有就回輸入框。
- **焦點搬動的判斷寫在換手那一層**，不要散在各元件。
- 對話框、抽屜一律經過 Radix 的 Trigger；做不到的（`SidebarTrigger`、受控開啟）自己在 `onCloseAutoFocus` 還焦點。
- `[tabindex="-1"]:focus-visible` 不畫外框。

**鍵盤**
- 核准面板不加快捷鍵，**Esc 不做事**。
- 提問面板留 primitive 內建，加數字鍵 1–9，**Esc＝收起**（不是停止）。
- **單選自動跳只認指標選取**（滑鼠、觸控、VoiceOver 點兩下）；鍵盤改選取不跳，要按 Enter。說明補一句告知（WCAG 3.2.2）。

**螢幕閱讀器**
- 面板出現不另開 live region，由狀態列（`role="status"`）唸；面板名稱＝報讀內容，例如「等待核准：edit_file（1／2）」「有 3 個問題要你回答（2／2）」。
- 換題：進度條 `aria-live` 關掉，legend 前放 sr-only「第 2 題，共 3 題」。
- AI 回覆：`role="log"` 設 `aria-live="off"`，串流不逐字唸，結束時把全文丟進 polite 區唸一次。
- 往前翻讀完：另一格 polite 唸「載入了較早的 N 則。」（N＝人打的字與模型的回覆，同 wire 一頁的單位），**不唸接上來的內容**，也不跟上一條共用一格（2026-09-25，inventory 列 9）。
- 工具卡狀態變化不唸；orb 旁已有同義文字時 `aria-hidden`。
- ❌ 的名稱「停止這一輪，不回答這些問題」（`aria-label` 與 tooltip 同一句），不加確認。
- **英文報讀字串全換中文**（Messages、Scroll to end、Question X of Y、Toggle Sidebar、Close、Sidebar、sonner 的 Notifications）。

## 9. 版面與 RWD

- **驗收寬度 375／768／1280**。
- **斷點 1024**：以下收成抽屜。registry 的 `use-mobile.ts` 是 768（`max-width: 767px`），**要改**——768 剛好是驗收寬度，不改會顯示成桌面側欄。
- 觸控目標 44px。
- `message-scroller` 的兩個坑：
  - `scroll-fade-b`、`scrollbar-none` 在建置出的 CSS 裡**沒有產出**，底部漸層與捲動時隱藏捲軸都沒作用。
  - item 帶 `content-visibility:auto`（paint containment），會把卡片外陰影與面板光暈切成直角。原型直接關掉；實作要另外保住長列表的效能。
- 側欄的 cookie 與 `history.replaceState` 在沙盒 iframe 裡可能拋錯（原型包了 try/catch；產品頁面不在 iframe 裡，視情況處理）。
- **右側欄**（[#640](https://github.com/DemianLi/nexus-agent/issues/640)，`components/right-sidebar.tsx`）：
  - 一格停靠＋分頁，住著改動比對與交付預覽；不做分格、浮窗、拖放、復原。開關鈕在會話區右上角，會話標頭做好後搬進去。
  - 1024 以上停靠，會話區讓出寬度，左緣可以拖寬：會話區至少 480、面板至少 320。1024 寬、左側欄展開時兩個下限放不下，面板先縮到 320，再輪到會話區讓。Esc 不做事。
  - 1024 以下全螢幕覆蓋，Esc 或收起鈕關掉，分頁留著；**載入時一律從收起開始**，不照存下來的「開著」蓋住對話。
  - 改動一輪一個分頁、交付一個檔一個分頁；分頁第一次被選中才讀內容。版面每條會話存在 `localStorage`，最近 50 條。
  - 分頁像瀏覽器那樣先縮（標題截斷，最窄 112），縮到底才橫向捲，捲軸用細的。
  - 分頁的 × 不可聚焦：`tablist` 裡多一顆可聚焦的鈕 axe 就報 `aria-required-children`；鍵盤用 Delete 關。停靠時從面板裡收起，焦點交回開關鈕。
  - 會話區可能在寬視窗裡只剩 480，**會話區裡的排版看容器寬度，不看視窗寬度**（交付卡的兩欄用 `@container`）。

## 10. 原型怎麼取

- **tag** [`proto-375-design-language`](https://github.com/DemianLi/nexus-agent/tree/proto-375-design-language)（`61cc564`）。分支 `prototype/375-design-language` 還在，但**不會合併**，引用一律用 tag。
- **跑起來**：

  ```bash
  git worktree add ../nexus-proto-375 proto-375-design-language
  ```

  會停在 detached HEAD（`61cc564`），這是預期的。在那個目錄裡 `pnpm install`，再 `pnpm --filter @nexus/web prototype:375`（port 5375）。靜態建置用 `prototype:375:build`，**建完要刪掉 `dist-prototype-375/`**，不然 eslint 會掃進去報上千個錯。
- **Artifact**：<https://claude.ai/artifact/1HgfkuooJT27c1eVKu5WoY>（Version 6）。**私有**：只有 demian 本人或他帳號底下的 Claude session 打得開。它是那天那一版的快照；要看活的就跑上面的 tag。

**三層**：

| 層 | 檔案 | 怎麼用 |
| --- | --- | --- |
| **直接搬** | `apps/web/src/index.css` 的 `@import`、兩段 `@theme`、layer 外的 body 規則；`prototype-375/tokens.css` 的動效 token、模式規則、reduced-motion 區塊；`prototype-375/tokens.generated.css`；`prototype-375/tokengen/`（產生器，搬到它被消費的地方）；`components/ui/*` 的改法（border 換陰影、中文字串、動效時長、`onCloseAutoFocus`） | 起點。搬進來後移出 `prototype-375` 範圍、拿掉 `:root[data-proto-375]` 前綴 |
| **只當參考** | `prototype-app.tsx`、`kit.tsx`（`AutoHeight`、`AgentOrb`、`Beam`）、`scenario.ts`、`old-button.tsx` | 看行為怎麼長，照產品的資料流重寫 |
| **不搬** | `main.tsx` 的原型掛載、`?prototype=375` 開關、假資料劇本、切換列 | — |

**搬的時候會無聲壞掉的一處**：`index.css` 的 `@theme` 覆寫 `--animate-collapsible-down/up` 時引用 `motion-fade-in`／`motion-fade-out`，而這兩個 `@keyframes` 定義在原型範圍的 `tokens.css`。只搬 `index.css` 不搬 keyframes，collapsible 的動效會變成什麼都沒有，而且不報錯。

**另一件實作要想的**：`AutoHeight` 在高度變化那 300ms 裁切（`overflow: hidden`），期間邊框光會被切掉一瞬間。

## 11. 實作必須帶的絆索

每條連回出處；#378 的三條量**建置出來的 CSS**，不是原始碼。

| # | 絆索 | 出處 |
| --- | --- | --- |
| 1 | 同一 className 同時有 `border` 與 `shadow-`（排除 `shadow-none`）就報錯 | [#377](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498) |
| 2 | 用 colorjs.io 重算產生出來的 token，達到 §5 的對比度目標（文字、非文字、狀態色、亮暗共用） | [#377](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498) |
| 3 | reduced-motion 下 `--animate-in`／`--animate-out` 換成只有透明度的版本 | [#378](https://github.com/DemianLi/nexus-agent/issues/378#issuecomment-5718598887) |
| 4 | `@keyframes` 名稱在允許清單上（清單在 `apps/web/scripts/check-built-css.mjs`），清單分兩段：**我們的** `motion-*`；**第三方** tw-animate 的 `enter`／`exit`／`collapsible-*`（之後裝 accordion 多 `accordion-*`）、Tailwind 的 `spin`／`pulse`、sonner 的 `sonner-fade-*`／`sonner-spin`／`swipe-out-*`。只寫第一段，第一次跑就紅 | [#378](https://github.com/DemianLi/nexus-agent/issues/378#issuecomment-5718598887) |
| 5 | 每個 `infinite` 動畫在 reduced-motion 下都有對應：`spin`／`pulse` 用 class 蓋，`sonner-spin` 由 sonner 自己的 media query 關——要認得這兩種寫法 | [#378](https://github.com/DemianLi/nexus-agent/issues/378#issuecomment-5718598887) |
| 6 | axe-core 的 vitest（開發期相依），至少掃原型驗過的四個畫面：核准面板 375 暗、提問面板 375 暗、提問面板 1280 亮、對話流＋輸入框 375 暗 | [#384](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797) |
| 7 | 對話列表 `role="log"` 的 `aria-live="off"` 單獨釘一條 | [#384](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797) |
| 8 | 提問進度條的 `aria-live` 關掉單獨釘一條 | [#384](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797) |
| 9 | `index.html` 內嵌腳本與程式碼用同一個 `localStorage` key（讀腳本文字比對常數） | [#391](https://github.com/DemianLi/nexus-agent/issues/391#issuecomment-5722962752) |
| 10 | 三態各自套出正確結果：淺色沒有 `.dark`、深色有、`color-scheme` 跟著對 | [#391](https://github.com/DemianLi/nexus-agent/issues/391#issuecomment-5722962752) |
| 11 | 沒存過偏好時跟隨系統：stub `matchMedia` 回深色，確認掛上 `.dark` | [#391](https://github.com/DemianLi/nexus-agent/issues/391#issuecomment-5722962752) |

**靠 review、不寫測試的**：blur 只給小元素、持續動畫只動 transform／opacity。

**還沒驗過的**（實作時要補驗或留意）：

- 停在**提問**時按停止：`turn-cancel.test.ts` 只測了停在核准；模型看到「before dispatch」後會不會重問同一組，要實跑（[#376](https://github.com/DemianLi/nexus-agent/issues/376#issuecomment-5709355235)）。
- 自建 markdown＋shiki＋katex 的 bundle 大小；`cn` 套件與 clsx＋tailwind-merge 是否完全等價——`button` 的 240 組已驗（197 組觸發合併、差異 0，#401），其他 registry 元件進來時各卡順手比對（[#374](https://github.com/DemianLi/nexus-agent/issues/374#issuecomment-5707786108)）。
- 下拉的動效值（[#378](https://github.com/DemianLi/nexus-agent/issues/378#issuecomment-5718598887)；popover 與指令選單已在 [#407](https://github.com/DemianLi/nexus-agent/issues/407) 量過，見 §7）。
- macOS VoiceOver 沒走過，只有 iPhone VoiceOver（[#384](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797)）。
- Artifact 沙盒裡的字型載入（[#377](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498)）。

## 12. 維護

- **改 token**：改產生器的輸入，重跑，表與 CSS 跟著出。這份文件只有在**目標或階梯**改了才動。
- **改動效**：改共用 CSS；新增或刪掉 `@keyframes` 時，同一個 PR 更新 §11 第 4 條的允許清單。
- **改規則**：改這份文件，PR 內文寫理由。**卡片留言不追改**——它是當初取捨的快照，只有「為什麼」是它的。規則被推翻時，在這裡寫新規則並連到做決定的地方。
