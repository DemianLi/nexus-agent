# nexus web 介面規格：P0 元件、設計 token、動效與無障礙

**狀態**：規格拍板於 2026-09-18，P0 已照這份實作（§11 末尾仍有還沒驗過的項目）；之後的收斂見 [#1141](https://github.com/DemianLi/nexus-agent/issues/1141)（token 與積木）、[#1278](https://github.com/DemianLi/nexus-agent/issues/1278)（設計系統地圖）。這份是現行規格：值或規則改了，回寫這裡。來源是地圖 [#372 web 介面重做](https://github.com/DemianLi/nexus-agent/issues/372) 的八張卡；原型定版在 tag [`proto-375-design-language`](https://github.com/DemianLi/nexus-agent/tree/proto-375-design-language)（`61cc564`）。給人看的整體風格與參考來源總覽在 [web-design-style.md](web-design-style.md)。

**用途**：交給實作的那一份。讀完這份就知道 P0 要做什麼、每個元件從哪裡拿、token 與動效的規則、無障礙要做到哪、原型哪些可以直接搬、實作必須帶哪些測試。**怎麼切實作卡不在這份**（地圖把它排在終點之外）。

## 結論速查表

| 問題 | 結論 | 在 |
| --- | --- | --- |
| 誰是準的 | 理由在卡片（凍結）、現行規則在這份、數字在程式碼 | §1 |
| UI/UX 的依據 | shadcn＋Tailwind 是基底，外觀與 token 用 solid-glass（原樣 vendor＋覆寫檔）；視覺、token、動效的數值以 SG 為準，Libraries.dev 只參考元件多樣性與交互模式；dsh 只參考元件多樣性 | §3 |
| 元件從哪裡拿 | 主用 shadcn 官方；AI Elements 只參考清單、不用程式碼；registry 檔裝進來就是我們的原始碼 | §4 |
| 核准與提問放哪 | **換掉輸入框**（隱藏不卸載），同時只一個面板、先來先處理 | §4.3 |
| 顏色怎麼定 | oklch 語意 token 直接寫值；色相、彩度、alpha 取 solid-glass，用 colorjs.io 解明度到 WCAG 2.x 門檻；亮暗鑑別度一樣 | §5 |
| 邊框怎麼畫 | 照 SG：面（卡片、浮層）的邊畫在陰影裡；控制項（按鈕、欄位）的細線是自己的 `border`，再疊 inset 光與投影 | §5 |
| 字型 | Geist／Geist Mono（打包 latin，等寬另加方框字元的 symbols2），等寬再退系統等寬，中文退 Noto Sans TC，**全部打包進本地** | §5 |
| 亮暗切換 | header 循環三態、預設跟系統、`localStorage`、`index.html` 內嵌腳本防閃、不裝 `next-themes` | §6 |
| 動效 | 純 CSS＋`tw-animate-css`（例外：狀態列的 SG `StatusGlyph`，§7）；封閉模式清單；進出場時長照 SG（浮層 100、tooltip 150）；reduced-motion 分模式退 | §7 |
| 無障礙 | WCAG 2.2 AA＋APG＋Radix 內建；焦點只在會丟掉時才搬 | §8 |
| 斷點 | 1024（以下收成抽屜）；驗收 375／768／1280 | §9 |
| 原型哪些能搬 | 主題、token、模式規則、registry 改法直接搬；原型 App 只當參考 | §10 |
| 實作必須帶的測試 | 13 條絆索 | §11 |

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

- **shadcn＋Tailwind 是基底**，外觀與設計 token 用 **[solid-glass](https://github.com/deeplethe/solid-glass)**（以下稱 SG）：原樣 vendor 在 `apps/web/src/vendor/solid-glass/`，修改寫在後載入、layer 外的覆寫檔，逐條登記在該目錄 README 的「本地修改」（[#1468 的拍板](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573) Q1、Q4、Q9）。**外觀類照 SG，機制類保留**（Q8）；碰到本份 §5、§7、§8 的無障礙門檻時以門檻為準（Q5）。元件目前仍是 registry 的 Radix 版，換成 Base UI 在地圖 [#1497](https://github.com/DemianLi/nexus-agent/issues/1497) 第 ③ 步。
- **視覺、設計 token、動效的數值以 SG 為準**；**[Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) 只當元件多樣性與交互模式的參考**，用在 SG 沒有定義的元件或互動上（例如 #1497 第 ⑤ 步的設計稿）（demian 2026-10-17 在 PM session 拍板，記在 [#1512](https://github.com/DemianLi/nexus-agent/issues/1512)；原本是「模仿對象：元件多樣性、交互體驗、動效呈現」）。最後長成我們自己的系統風格。
- **dsh 在 UI/UX 上最多只參考元件多樣性**，不寫對照 dsh 的紀錄（[AGENTS.md「技術實現標準」](../AGENTS.md)）。先前以「照 dsh」寫下的 UI 行為（markdown 自建、工具依名分類、1024 收側欄、觸控 44px、核准獨立成卡）照舊，只是依據不再是 dsh。
- **動到執行語意的仍照 dsh**，唯一寫明的例外是提問面板的 ❌（§4.3）。
- **完全內網**：字型、動效 CSS 等資源一律打包進本地，執行期不打外部 CDN。
- Libraries.dev 讀的是 `b300ff8`（inventory 調研時 `44fef85`）；標題字 Saans 沒附授權，**不拿**。

## 4. 元件

### 4.1 安裝程序

（新增自己的元件、改樣式該放哪一層、用哪些值、什麼會被擋：[`apps/web/COMPONENTS.md`](../apps/web/COMPONENTS.md)。）

1. `shadcn add … --overwrite`（shadcn 4.21.0 實測）。**不加 `--overwrite` 時非互動安裝會卡在覆寫提問、exit 0 靜默中止、檔案寫一半**——判準是實際寫入的檔，不是 exit code。
2. 舊版 `button.tsx` 讓 registry 版覆寫（default／secondary／destructive 少了 `shadow-xs`、outline 暗色改 `bg-input/30`、多四種尺寸與 `data-variant`／`data-size`；原型並排比過，沒有異議）。
3. `shadcn migrate cn`：`cn` 統一成 `cn` 套件，`@/lib/utils` 的 `cn` 是 `cn/config` 的 `createCn`，並登記自訂字級名（`text-ui`／`text-body`／`text-tip`／`text-micro`，與 `index.css` 的 `--text-*` 一致；沒登記的話預設 `cn` 會把它們當文字顏色，跟 `text-primary-foreground` 之類互相吃掉，#1141 的後續）。**全站只從 `@/lib/utils` 取 `cn`，registry 檔裝進來也要把 `from "cn"` 改成 `@/lib/utils`**（`utils.test.ts` 會擋）。`clsx`、`tailwind-merge` 移除。**`@radix-ui/react-slot` 會殘留**，覆寫 button 後已經沒人用，要手動拿掉。
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
| 7 | 空白狀態 hero | SG `Empty`（靜態圖示＋標題＋一句說明，#1695） | — |
| 8 | 會話標頭 | 自建；標題規則在 `lib/thread-title.ts`（標頭、瀏覽器分頁標題、側欄列表共用），換字不做動效 | 在 `App.tsx` |
| 9 | 歷史往回捲 | shadcn `message-scroller`（帶 `@shadcn/react`） | — |
| 10／11 | 使用者／助理訊息 | shadcn `message`＋`bubble`；**markdown 自建**：`mdast-util-from-markdown`＋`micromark-extension-gfm`＋增量解析＋`cjkFriendlyStrong`。撞到輸出上限的那一輪，最後一則底下一行灰字，同「（已停止）」（`lib/max-tokens-view.ts`，#608） | `transcript.tsx` 留（歸屬、狀態字面） |
| 12 | 推理區塊（思考過程） | solid-glass 的 `Reasoning`（#1683 起；vendor `components/ui/reasoning.tsx`，套 vendor README「本地修改」第 67、68 條的 patch、第 69 條的包裝，第 63、64 條的覆寫擴到它身上）。原生 `<details>`，預設收合；收合時一行摘要放在標題後面的 `trailing`；內文用列 10／11 那一套 markdown | `reasoning-row.tsx` 留轉接 |
| 13 | 工具卡 | solid-glass 的 `StepRow`（#1682 起；vendor `components/ui/tool-steps.tsx`，套 vendor README「本地修改」第 56–59 條的 patch、第 60–66 條的包裝與覆寫）。`lib/tool-step.ts` 把 `ToolEntry` 轉成 SG 的 `Step`：狀態收成 SG 的三態，四格 `ToolEntry.status` 的字放在列尾的 `badge`（狀態不靠顏色或動效）；通用卡的參數、結果、錯誤用 SG 的結果框，寫檔／改檔給 SG 的 `step.patch`（#1685 起：列上的 `+N −M` 與展開後的 `DiffView` 由 SG 畫，收著不再只畫 9 列；上限與報讀在 nexus 層，第 77–80 條），其餘專屬呈現（列 14）、提問、交付、待辦、子代理面板畫在展開後的 children，不畫兩次。連續完成的工具（至少 2 顆）收成 SG 的 `StepGroup`（工具段，`tool-run.tsx`），段收著那一列有整段的 `+N −M`。沒有狀態圖示、邊框光、外框卡片 | `tool/card.tsx`、`tool-run.tsx` |
| 14 | 工具專屬呈現 | 自建：依工具名分類（`classifyTool`）＋通用卡兜底，分哪幾類照 nexus 實際工具名定；讀檔卡的高亮 `shiki/core`（ts／bash／json 靜態、其餘 `import()`）、數學 `katex`。通用卡的參數是 SG 結果框裡的純文字，不上色（#1682）。寫檔／改檔的 diff 是 SG 的 `DiffView`（#1685，轉換在 `lib/tool-diff.ts`，見列 13） | `tool/result.tsx`、`lib/tool-diff.ts` |
| 15／22 | 子代理歸屬、決定紀錄 | 自建＋shadcn `badge` | 在 `transcript.tsx` |
| 21 | 核准 | 自建，shadcn `card`＋`button`，換掉輸入框（§4.3） | `approval-card.tsx` 留邏輯 |
| 23 | 提問 | shadcn `questionnaire`（`radix-vega`）＋§4.3 的補件 | `question-card.tsx` 被取代 |
| 24 | 計劃審核 | 自建，shadcn `card`＋`button`，換掉輸入框；全文開在右側欄的「計劃」分頁，markdown 用列 10／11 那一套；對話裡的計劃卡放在 `exit_plan_mode` 工具卡的位置（§4.3） | `plan-review.tsx`、`plan-preview-tab.tsx`、`lib/plan-review.ts` |
| 26 | 輸入框 | solid-glass 的 `Composer`（#1591 起；vendor `components/ui/composer.tsx`，套 vendor README「本地修改」第 28、29、32、33 條的 patch）。`/` 與 @ 選單、附件、`@子代理` 標記由 nexus 從外面接（`leading`、`above`、外層 `div` 的 capture 階段攔鍵）。主按鈕照 dsh `InputBar`：跑著、草稿空（或送不出）是停止，有草稿是送出，名稱說出這次是排隊還是插話（`lib/submit-mode.ts`）；斷線時沒有停止。輸入框底下一列是 SG 的 `ComposerFooter`：左邊權限、右邊模型與推理強度，都是 SG 的 `ComposerPick`（下拉選單，鎖住時 `aria-disabled`、聚焦得到）；最右邊是 SG 的 `ContextRing`（用量環，套第 34 條；色階 70% 琥珀、90% destructive，壓回 status token） | `composer.tsx`（App 組裝在 `App.tsx`） |
| 27 | slash 選單 | shadcn `command` | 在 `App.tsx` |
| 28 | `@` 引用 | shadcn `command`（跟 slash 選單共用同一顆 popover）；觸發、插入、非同步狀態照 dsh（§4.4） | `lib/file-mention.ts`、`lib/session-mention.ts`、`lib/mention-menu.ts`、`components/session-reference.tsx`、在 `composer.tsx` |
| 29 | 送出佇列 | 自建，shadcn `collapsible`＋`button`＋`textarea`；行為照 dsh `QueueDock`（一件直接畫、兩件以上收合、就地改、刪與插話；插話鈕只在這一輪跑著時按得動，按下去那一則離開佇列、改畫在對話尾端）；新項目撐過 200ms 才畫、只淡入淡出不 stagger；放在待辦面板下、換手區外，停在核准點時照樣看得到。**插話**（#710）：跑著時 Cmd/Ctrl+Enter 送插話，Enter 與送出鈕照舊排隊（照 dsh 的預設，沒做它讓 Enter 改成插話的偏好設定），送出提示跟著換（#1591 起提示只給報讀：sr-only、掛在輸入框的 `aria-describedby`，畫面上不畫，看畫面的人因此看不到加速鍵那一句，PM 已告知 demian）；排著的插話不進佇列，照 dsh 畫在對話尾端（淡一階，底下一句「插話・下一步送進模型」；這一輪停了就改說「下一輪送進模型」，harness 留到下一輪的第一次模型呼叫才領），被領走時同一格換成人的話。**草稿空白時 Cmd/Ctrl+Enter 把排著的全部改成插話**（照 dsh `steerQueue`：照排的先後一件一件送，碰到「不收了」或「不在隊裡」靜靜停），輸入框提示字跟著換 | `queue-dock.tsx`、`lib/submit-mode.ts`、`lib/steer-view.ts`、`lib/steer-queue.ts` |
| 31 | 狀態列 | 執行中那一列是 SG 的 `TurnStatus`＋`StatusGlyph`（#1684，vendor 原樣加 patch `0022`、`0023`）；其他支自建 | `status-line.tsx` 留（live region 與轉接層） |
| 35 | 讚踩＋回饋框 | 框換 shadcn `dialog`，表單邏輯留；讚踩按鈕留在 `transcript.tsx` | `feedback-dialog.tsx` 換外殼 |
| 36 | Toast | shadcn `sonner`，**改成收 `theme` prop、拿掉 `next-themes`** | — |

### 4.3 核准與提問

出處：[核准與提問](https://github.com/DemianLi/nexus-agent/issues/376#issuecomment-5709355235)、[無障礙](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797)。

- **兩種都換掉輸入框**。輸入框用 `hidden`＋`inert` 隱藏**不卸載**，草稿保留（原型早期的 `Swap` 是卸載，會丟草稿，不能照抄）。
- **同時只一個面板、先來先處理**，面板名稱帶跨面板進度「（1／2）」。
- **核准面板**：只有允許／不允許，沒有 ❌、沒有停止、不可收起。只有在允許的決定交集為空時，才顯示原因、摺疊原始中斷，並出現「停止這一輪」（送出不在清單上的決定會讓基座拋錯）。
- **提問面板**：每題有選項時附一列「輸入你的答案」（單選填字就取代選項、多選並存）；可收起；可上下題、送出前回頭改；單選自動跳下一題（**只認指標選取**，§8）。題目帶 `detail` 時，在題目下、選項前畫成 markdown（同 dsh）；認得的計劃審核走下面那一節的面板，認不出來的照一般提問畫。
- **提問的 ❌＝停止這一輪，拿掉「放棄整組」**。這是**寫明的例外**：dsh 的取消是放棄後這一輪繼續，我們表達得出來，是 demian 選擇不讓模型接著猜。停止後那張提問工具卡直接展開、列出題目與選項，標「已停止，請直接打字回覆」。
- **答完**：`ask_user_question` 的工具卡上列「問題 → 回答」（按 id 配對，配不起來退成「已回答 N 題」）；拿掉 `transcript.tsx` 的 `answerSummary`，重寫 `App.tsx` 的 `stuck` 邏輯（它的「解鎖輸入框」本來就是假出口）。
- **計劃審核**（[#654](https://github.com/DemianLi/nexus-agent/issues/654)，harness 那一半是 #652）：見下一節。
- **`questionnaire` 要補**：自由作答列、單選自動跳、中文進度（primitive 寫死 `Question ${n} of ${total}`）、真的渲染 `QuestionnaireError` 並給中文訊息、數字快捷鍵、❌ 的位置、跨面板進度、收起／展開、legend 前的 sr-only 題號。

#### 計劃審核

出處：[#654](https://github.com/DemianLi/nexus-agent/issues/654) 的拍板（2026-09-26）。行為照 dsh `477b4f4`：`ui-user-questions` 的 `planReviewOf`、`PlanReviewPanel`，`ui-plan` 的 `plan.ts`、`PlanCard.tsx`（`PlanReviewOpen`）。

- **認得意圖才接管**：恰好一題、`intent.kind` 是 `plan-review`、帶 `detail`、不是複選、選項至多兩個、其中一個的標籤等於 `intent.approve`。有一條不成立就照一般提問。
- **面板**：名稱「計劃待審」＋跨面板進度；計劃標題（第一個 `# ` 標題的純文字，沒有就寫「計劃」）＋第一段的純文字摘要（截兩行）＋「查看全文」；兩顆鈕，「要求修改」次要樣式在左、「同意執行」主要樣式在右。跟核准面板一樣：不可收起、沒有 ❌、Esc 不做事、沒有數字鍵。
- **「同意執行」** 用 `intent.approve` 指名的標籤回答，不寫死字面。
- **「要求修改」** 關掉這一題（送 `cancelled`，dsh 的 `ASK_CANCELLED`）：**這一輪不停**，模型收到「停在這裡等使用者的訊息」；面板收掉、焦點回到輸入框，人打的意見照常送（跑著時排進佇列）。它不是一般提問那顆 ❌（那顆停止這一輪）。
- **全文**：開在右側欄的「計劃」分頁，一份計劃一個分頁（以工具呼叫 id 為鍵），面板與計劃卡打開的是同一個；內容讀對話裡那一份，還沒載入到那一段時分頁講一聲。1024 以上待審時自動停靠一次、焦點不動；同一份只自動開一次（記在 `localStorage`，重新整理後不再開），人關掉就不再彈。1024 以下不自動開，按「查看全文」才全螢幕打開。
- **計劃卡**：放在 `exit_plan_mode` 那張工具卡的位置，跟面板同一套版型，多一顆結果 chip（已同意／要求修改／停止，決定紀錄的樣式）；還在等、或在問人之前就被擋掉的沒有 chip。沒有 `# ` 標題、參數解不開的照通用工具卡（同 dsh `submittedPlan`）。
- **結果讀工具卡的結果**，不讀本地那則回答：工具跑完＝同意；關掉審核、選了「繼續規劃」、改路由之前的閘門拒絕＝要求修改；收回的那一句＝停止。即時與重播同一串，所以重新整理、別的分頁、舊會話都讀得到。
- **跟 dsh 不同的地方**（UI/UX 不在 dsh 規則範圍）：計劃卡不是 dsh 那種輪尾的文件卡，而是跟面板同一套、放在原位；多一顆結果 chip；自動打開的紀錄 dsh 只放記憶體，我們多記進 `localStorage`（卡上要求重新整理後不再開）。

### 4.4 `@` 引用

出處：[#653](https://github.com/DemianLi/nexus-agent/issues/653) 的拍板（純文字、只列檔案與資料夾、沒有 `--workspace` 就沒有選單、不做 chip、泡泡原樣顯示）。行為照 dsh `477b4f4`：`file-reference/src/grammar.ts`、`ui-input-trigger/src/core/`（`detect.ts`、`menu.ts`、`controller.ts`）、`ui-reference`。

- **觸發**：`@` 只在字首或空白後面才算（`a@b`、`user@host`、全形 `＠` 不開）；`@"` 開頭的可以跨空白。**先判 `@` 再判 `/`**，`@/` 是路徑不是命令。
- **插入的字**：`@/src/a.ts` 加一個空白；資料夾補結尾 `/`；有空白就用 `@"/a b.md"`；路徑有雙引號或控制字元寫不回草稿，那一列不列。送出時照舊修掉頭尾空白，`@path` 原樣送，模型自己用讀檔工具去讀。
- **鍵盤**（dsh `arbitrate`）：上下選；Enter 選定；資料夾按 Tab 往下鑽（換上 `@/dir/`、選單留著、查下一層），檔案按 Tab 就是選定；Esc 或 Shift+Tab 收起，同一段不再自己跳出來。組字中所有鍵都不歸選單。
- **非同步**（dsh `menuReduce`）：每次查詢一個號，號不對的結果丟掉；查詢變了先留著舊列，**還沒回來時舊列選不到**，這時 Enter／Tab 被選單吃掉、不選也不送；一列都沒有時畫骨架，這時 Enter 照常送出；回來是空的或失敗就收起。伺服器回「沒有工作區」就記住，之後一律不開。
- **跟卡片原文不同的地方**：卡片原文寫「查詢中 Enter 不送出」；dsh 的 `arbitrate` 在沒有選中列時放行 Enter。按下去送不送是執行語意，照 dsh：只有畫面上有列時才吞。
- **畫面取捨**（UI/UX 不在 dsh 規則範圍，依據是 #653 的拍板與第一版範圍）：
  - **第一次回來之前不畫**（dsh 先畫骨架）：依 Q3。回來之前分不出有沒有工作區，沒有工作區時打 `@` 會閃一下。
  - **不做 chip**（Q7）：dsh 選定之後是一顆 chip，我們換成純文字。引號形式的資料夾選定時收掉引號，往下鑽時留著開口。
  - **不畫麵包屑**（第一版範圍）：dsh 往下鑽之後在上方畫麵包屑、列裡不再寫父目錄；我們每一列都寫父目錄。
- **會話與子代理**（[#713](https://github.com/DemianLi/nexus-agent/issues/713)，2026-09-29；拍板在該卡 2026-09-28 的分類留言 Q2–Q4）：同一個 `@` 選單分三段——檔案、會話、子代理（有 `parentSessionId` 的算子代理）；只有檔案時不畫段標題，跟原來一樣。
  - **問法**：打普通的字時檔案與會話一起問；`@/…`（路徑）與 `@"…`（有空白的路徑）只問檔案。每打一個字，兩邊的上一次都取消。
  - **兩個來源各回各的**：先回來的先畫，檔案不等會話（會話是跨專案冷讀，慢一點）；後回來的併進去，選中的那一列跟著自己走。可不可用**按來源記**——沒有工作區只關掉檔案、沒接落盤只關掉會話，**兩個都不可用才整個不開**。
  - **列**：會話寫標題，別的專案後面加目錄名；子代理寫「屬於 <母會話標題>」，不畫 id。候選內容（列全部、同工作區排前、最多 50、不搜內文）是伺服器的事，照 dsh。
  - **插入**：選定就是把 `@…` 那一段換成伺服器編好的 `@[標題](nexus-session:…)` 加一個空白，**原樣插、不自己改寫**（Q2：第一版不做標籤）；Tab 對會話也是選定，沒有往下鑽。草稿、送出、排隊、重新編輯看到的都是這段完整文字；選好的整段貼著游標時不算在打 `@`。
  - **還沒被領走的話仍是原文**（`inbox` 的 `items`、`nextStep`）：停靠列的預覽與待送插話泡泡把引用換成 `@標題` 再畫（`mentionDisplayText`），編輯框拿原文。
  - **被領走之後**（Q3）：伺服器已把引用換成 `@標題` 並帶 `references`（即時走 `inbox` 的 `claimed`，歷史走人話 `message-start`），泡泡把那一段畫成引用 `@標題`，可見文字就是 `@標題`：點得開的是一直帶 brand 色底線的連結，點不開的是粗一點的字（#1695 X6-C）。**清單上有的會話（同專案的主會話）點了切過去**，別的專案與子代理只顯示：serve 綁在一個工作目錄上，今天切不過去。
  - **被拒絕**（引用太多、引用自己、網址壞、沒接落盤）：伺服器回 `invalid_argument`，訊息開頭帶 `SESSION_REFERENCE_*`；送出時走原本的「這一句沒送出去」提示並把草稿放回去，改排隊裡的那一件走停靠列的錯誤提示。
- **還沒做**：skill 來源；標籤（chip 進輸入框，Q2 留到之後檔案與會話一起做）。

## 5. 設計 token

出處：[設計 token 定稿](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498)；改用 SG 之後的顏色、字型、圓角見 [#1468 的拍板](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573)（Q5、Q6、Q8、Q10），落地在 [#1512](https://github.com/DemianLi/nexus-agent/issues/1512)。**色碼與完整對比度表不在這裡**，在 `apps/web/tokengen/token-table.md` 與 `apps/web/src/styles/tokens.generated.css`（產生器 `apps/web/tokengen/generate.mjs`，`pnpm --filter @nexus/web tokens:gen`）。

**顏色**
- 全部 oklch，**語意 token 直接寫值**，不另建色板層；registry 帶進來的 `--sidebar-*` 由 `hsl()` 轉掉。
- `--primary` **無彩**。`--brand` **只**用在連結、info、核准與提問面板的邊框光；error 沿用 `--destructive`。
- **帶色相的 token 都是 SG 自己就有的**：`--brand`、`--brand-muted`（`solid-glass.css:192-194`、`:302-304`）、`--success`（`:199`、`:308`）、`--destructive`、`--status-*`（`:198`、`:307` 起）。值以 SG 的為輸入，照下面的目標解。**第 ⑥ 步不刪它們**。用量環 70% 以下是 `--status-done`（vendor README 本地修改第 37 條）。
- 原型另加的名字（SG 也沒有）：`--stage`、`--stage-ring`、`--beam-*`。
- **「需要你處理」那一色是 SG 的 `--status-interrupted`**（Q14）：產生器另外要求它疊在 stage 上也過 4.5。
- **可點的小面用 SG 的面**（#1689）：平常 `--muted`；滑鼠移上去與按著同一階，照 SG ghost 是 `--hover`，字換成 foreground；選中是 SG 的 `.glass-chosen`。
- **nexus 獨有的顏色**（`stage`，同 vendor README「另外新增」）與原型另加的陰影名字，在 #1497 第 ⑥ 步刪掉，自製元件改用 SG 有的 token（Q11）。刪之前它們的值照下面的目標解，亮暗都要過。

**對比度目標**（WCAG 2.x；產生器用 colorjs.io 逐對解，不再用 Leonardo）
- **輸入是 SG 的值**（Q10）：色相、彩度、alpha 照 SG，彩度收進 sRGB，只解明度（步長 0.001）；SG 原值已達標的原樣留。唯一的例外是暗色 `--destructive`，照 SG 原值、不收進 sRGB。逐值的 SG 原值與產物在 `apps/web/tokengen/token-table.md`。
- 文字 ≥ 4.5，非文字 ≥ 3（SC 1.4.11）；狀態色對**底色** **5.2**（產生器的解目標，讓暗色狀態色對卡片仍過 4.5；SG 的 `--status-*` 也套）；brand 在亮色底色上 ≥ 4.5（Q5）。
- **表面的亮暗鑑別度**：卡片、細線、側欄、`--muted` 這些面對底色的對比，亮色與暗色相差 ≤ 0.05；不到就只調亮色的明度（Q5）。表面只疊在底色上算；文字與狀態色的對比則疊在每一個底色與漸層停點上算，取最差的。
- **不透明的退路一樣要過**：`prefers-reduced-transparency: reduce` 與 `<html data-glass="opaque">` 下的面換成不透明，對比與表面差照同一組目標量（Q7）。
- **亮暗鑑別度一樣**：兩主題共用一組目標，取兩主題較強者；起算點是原型 `eb800a1` 認可的對比度。
- **不准比 develop 差**：換主題前已達標的對要維持達標。可點的小面上的字（`--muted` 上的次要字、`--hover` 上的 foreground）與 `status-interrupted` 都過 4.5，沒有例外。
- 不用 APCA（2023-07 已從 WCAG 3 草稿移除）。人工抽驗用 Vispero Colour Contrast Analyser，CI 用 colorjs.io 重算（§11）。

**形狀**
- 圓角照 SG 的階梯，不重綁（Q8）：`--radius` 14px，`sm`／`md`／`lg`／`xl`／`2xl`／`3xl`／`4xl` 是它的 0.6／0.8／1／1.4／1.8／2.2／2.6 倍；控制項寫 `rounded-lg` 時改用小一階的 `--radius-control`（11.2px，`solid-glass.css:546-559`）。按鈕的圓角照 vendor 原文（`vendor/solid-glass/components/ui/button.tsx`，#1523 起不再是 `rounded-full`）。不用 superellipse。
- 列的圓角 `--radius-row` 是 SG 的 `3xl` 減 4px（`index.css`），nexus 新增、不是改 SG。
- **邊緣照 SG 的畫法**（Q8 外觀照 SG；PM 2026-10-17 定照 SG 實際怎麼畫來寫，#1512，照 `solid-glass.css` 實際的寫法）。亮暗是同一組結構，只換 token 值（`:260-267`），所以暗色也是外環＋投影，不再是 inset 疊層：
  - **面**（`.bg-card`、`.glass-panel`、`.bg-popover`）：**邊畫在陰影裡**，`border` 歸零（`:380-403`）。由內到外是頂上一條光 `inset 0 1px 0 --glass-rim`、`inset 0 0 0 1px --glass-inner`、外側細線 `0 0 0 1px --glass-edge`（浮層是 `--popover-edge`）、貼地 `0 1px 2px --glass-contact`、投影 `0 12px 32px -14px --glass-shade`；浮層把投影換成 `0 24px 60px -18px --glass-shade` 加 `0 6px 16px -6px --glass-lift`。側欄只有 inset 線（`:407-411`）。
  - **控制項**（主按鈕 `:438-464`、outline／secondary 按鈕 `:642-666`、欄位 `:919-935`、沒有底色的裸框 `:567-576`）：**細線就是元素自己的 `border`**（`--border`、`--glass-edge`、`--field-edge`），同一個元素再疊 inset 光與貼地投影。所以「同一元素不同時用 `border` 與陰影」只對面成立，對控制項不成立。
  - `border-shadow.test.ts` 量的是元件原始碼的 className：vendor 的 SG 元件放行（外觀照 SG，名單在 `src/test/vendor-upstream.ts`，#1523），產品原始碼（含 `components/ui/` 的 nexus 層）照樣檢查。
  - **例外：貼在輸入框上方的卡片是平的、不浮起**（`Surface tone="docked"`：待辦、送出佇列、目標列）。它們不是浮在對話裡，是接在輸入框上的一排，所以只畫一圈 1px 細線（`--glass-edge`）、不帶投影；底色與 blur 照 SG。**這條是覆寫 SG 的本地修改**：SG 的 `.bg-card` 在 layer 外把 `border` 歸零、畫上浮起的整組陰影，`Surface` 給 docked 掛 `data-surface="docked"`，`solid-glass.overrides.css` 用它補回平線（vendor README「本地修改」第 13 條；Q8 機制類保留，#1512）。出處 `apps/web/src/components/surface.tsx` 檔頭；`design-system.test.ts` 只准 `Surface` 本身寫這組配方，`solid-glass-overrides.test.ts` 與 `guard/` 釘住它是平的。
- 邊框光的靜態補償（亮色線 2px、光暈 brand 60% 28px、呼吸下限 .55；暗色 1.5px、30% 24px、.3）沿用原型值。

**字型**
- 介面 **Geist**；等寬 **Geist Mono**，只用在程式碼、工具輸入輸出、終端機；中文兩者都退 **Noto Sans TC**（所以介面上的中文實際是 Noto Sans TC），再退系統的 PingFang TC、Microsoft JhengHei；SG 原本的三個簡體中文字型拿掉（Q6）。等寬在 Noto Sans TC 前面先接**系統等寬**：Geist Mono → Consolas（Windows）→ Menlo（macOS）→ Noto Sans TC → 系統後備，只列名字、不打包。系統等寬接住 Geist Mono 兩個子集都沒有的字（← → 之類）；它們退到中文字型會是全形寬，程式碼的欄位就對不齊（demian 2026-10-17 在 PM session 拍板，記在 [#1512](https://github.com/DemianLi/nexus-agent/issues/1512)）。等寬堆疊尾端保留三個 emoji 字型（#979）。
- 三套都用 `@fontsource-variable/*` 打包（OFL）。Geist／Geist Mono **打包 latin 子集**，Geist Mono 另加 **symbols2 子集**（方框字元 U+2500–259F，5.7 KB；程式碼的樹狀圖與框線，demian 2026-10-17 在 PM session 拍板，記在 [#1512](https://github.com/DemianLi/nexus-agent/issues/1512)）：`apps/web/src/styles/fonts.css` 只寫這三條 `@font-face`，不 import 套件入口（入口會帶進 cyrillic 等子集）；Noto Sans TC 照套件入口，自帶 unicode-range 切片。零外部請求。堆疊在 `solid-glass.overrides.css` 的 `@theme inline`，`font-stack.test.ts` 釘住堆疊順序與打包的三條子集。
- 字級 UI 13、內文 14／23、tooltip 12、微標籤 11（`@theme` 的 `text-ui`／`text-body`／`text-tip`／`text-micro`）；**字重只用 400／500**（`semibold`、`bold` 落在 500）。
- **只走這四階，不用 Tailwind 預設的 `text-xs`／`text-sm`**（#1141）：`text-xs`（12／16）一律寫成 `text-tip`（尺寸與行高相同，畫面不變）；`text-sm`（14／20）一律寫成 `text-body`（字級相同、行高 20 → 23）。`ui/` 的 registry 原文也照改（它們裝進來就是我們的原始碼）；換成 vendor 的 SG 元件之後（#1523 起，名單在 `src/test/vendor-upstream.ts`），vendor 檔照 SG 原樣用 `text-sm`／`text-xs`，不改（Q8）。例外：`text-base`、`text-lg` 沒有對應的階，還留在 registry 原文裡的（dialog 標題等）保留。要用第五個尺寸，先在這裡加一階，不要寫任意值。
- **主次**（[#1281](https://github.com/DemianLi/nexus-agent/issues/1281)）：**可以點的與當標題的小字用 `text-ui`（13）**（`xs` 按鈕、小字的可展開列、輸入框底列的膠囊鈕、群組與區段標題、卡片標頭）；**小字說明、附註、時間、計數用 `text-tip`（12）**（tooltip、`Badge`、快捷鍵、工具名與摘要、等寬的輸出）；內文 `text-body`（14）與本來就是 14 的按鈕、選單項不變。逐處怎麼判與護欄見 [`apps/web/COMPONENTS.md`](../apps/web/COMPONENTS.md)「字級的主次」。`text-micro`（11）只用在程式碼區塊的語言標籤（`markdown.css` 的 `.md-code-lang` 用 `var(--text-micro)`，從 #419 起），保留（demian 2026-10-12 決定；#1278 拍板第 8 點「沒人用再刪」的前提不成立）。

**互動狀態**
- 焦點外框 `outline: 2px solid` 文字色、`offset 2px`；registry 的 `ring-[3px]` 關掉。SG 用 `--focus-line`（灰）畫的焦點全部換回文字色：SG 把 ring 帶回來的選擇器照抄壓回透明，**文字欄位的聚焦是邊框換成文字色**（SG 原本是灰線，Q5 優先於 Q8）。
- chip 階梯（rest／hover／pressed）、主按鈕 hover／active、disabled `.6`。

**Tailwind layer 的坑**：body 的底色、字色、`color-scheme` **寫在 layer 外**（SG 寫在 base layer，所以在 `solid-glass.overrides.css` 重寫一次，Q8 保留的機制）。寫在 `@layer base` 時，頁面被嵌進任何帶 reset 的外殼，暗色會變成黑底深字（原型在 Artifact 裡踩過）。

## 6. 亮暗三態

出處：[亮暗三態切換](https://github.com/DemianLi/nexus-agent/issues/391#issuecomment-5722962752)。

- header 一顆圖示鈕**循環三態**（淺／深／跟系統），**預設跟系統**，切換不做動效。
- 偏好存 `localStorage`，key `nexus.theme.preference`。存後端做不到：wire 協定封閉，也沒有「使用者」可以掛。
- **首屏不閃**靠 `apps/web/index.html` 的內嵌腳本（沒有 SSR、harness 不送 HTML）。**不裝 `next-themes`**。
- 真正套 class 的程式放 `main.tsx` 的 `createRoot` 之前；hook 讀系統偏好前先確認 `typeof window.matchMedia === 'function'`（jsdom 沒有）；**不加 `setupFiles`**。
- 跟隨系統時監聽系統偏好（`addEventListener`）；跨分頁監聽 `storage` 事件。
- 一併補：`color-scheme`（整個專案現在都沒設）；dark variant 改成 `&:is(.dark, .dark *)`。SG 自己定義成 `&:is(.dark *)`（`<html class="dark">` 本身吃不到），`solid-glass.overrides.css` 重新定義回來，`check-built-css.mjs` 量產物（Q8）。

## 7. 動效

出處：[動效策略](https://github.com/DemianLi/nexus-agent/issues/378#issuecomment-5718598887)。完整互動對照表與持續狀態的節奏在該留言。

**底層**
- **純 CSS**，`thinking-orbs`、`border-beam` 不進 `apps/web`。**例外：狀態列執行中那一列的 SG `StatusGlyph`**（#1684）是 JS `requestAnimationFrame` 每幀畫，vendor 原樣。「純 CSS」是 demian 2026-09-18 在 [#378](https://github.com/DemianLi/nexus-agent/issues/378) 拍板的；後來 #1468 的 Q12（status-line 換成 `TurnStatus`，它硬依賴 `StatusGlyph`）與 Q16（SG 的 AI 元件 vendor 原樣）蓋過了這一條，#1468 §6 的牴觸表當時沒列到它（#1684 PM 定，demian 可推翻）。
- **裝 `tw-animate-css`**：registry 的 dialog／sheet／tooltip 寫了 `animate-in` 等 class，沒裝時建置出來一筆都沒有，也不報錯。
- 進出場照 SG 的機制（#1687）：`--animate-in`／`--animate-out` 讀元件自己的 `duration-*`／`ease-*`（tw-animate 的 `--tw-duration`／`--tw-ease`），沒寫的 150ms、`ease`。`@theme` **不用 `inline`**（inline 會讓 reduced-motion 換掉的變數沒人讀）；值逐元素宣告在 `styles/motion.css` 的 `*` 上，因為只宣告在 `:root` 的話 `var(--tw-duration)` 在 `:root` 就解掉了（vendor README 本地修改第 81 條，`guard/` 與 `check-built-css` 量）。
- 進場 fill-mode `backwards`，退場 `both`。

**token**：SG 沒有定義任何時長、曲線或 `--animate-*` 變數，它的時長寫死在自己的規則裡（transition 150ms ease-out `:982-987`；進場 `sg-float-in` 220ms、`sg-fade-in` 240ms `:1297-1301`；持續動畫 1.2s／2.4s／1.6s `:1259-1293`），元件則自己寫 `duration-*`。進出場與展開收合 #1687 已換成 SG 的機制；下面這組 nexus 的 token 還有消費者或待清，**留給 ⑥（#1689）一起收**（demian 2026-10-17 在 PM session 拍板，記在 [#1512](https://github.com/DemianLi/nexus-agent/issues/1512)）。時長、位移、縮放、resize 的值取自 Libraries.dev（時長 40／150／250／350，位移 4／8，縮放 .96／.97／.99，resize 300），外加 `--duration-press` 120；只留有人用的那幾階。

**模式清單封閉**：浮層彈出、對話框、側滑抽屜、換內容、展開收合、進場、進度、按壓、持續狀態。清單外沒有動效，只留 100–150ms 顏色過渡。

| 互動 | 開／關 |
| --- | --- |
| 下拉選單 | **沒有動畫**（#1583 照 SG：vendor 的 Content 寫 `animate-none!`，開關都是立即的） |
| 指令選單 | 住在 popover 裡（composer 的 `/` 與 @ 選單），動效就是 popover 那一列（輸入框底列的 Pick 是下拉選單，#1591 起）；cmdk 本身沒有動效（#1583 換成 SG 版） |
| popover | 照 SG（#1583、#1687）：淡入＋zoom .95＋往外 slide 2（`slide-in-from-*-2`），開關都是 100ms、`ease`（SG 寫的 `duration-100`） |
| tooltip | 同 popover（#1583）：淡入＋zoom .95＋slide 2，開關都是 150ms、`ease`（SG 的 tooltip 沒寫 `duration-*`，是 tw-animate 的預設，#1687）；延遲 0（SG 的 `TooltipProvider` 預設） |
| 對話框（含確認框） | 同 popover（#1583）：淡入＋zoom .95，開關都是 100ms、`ease`（#1687）；遮罩同樣 100ms 淡入淡出、`backdrop-blur-xs` |
| 抽屜（手機側欄 <1024、窄螢幕的右側欄） | 照 SG 的機制（#1583）：transition 200ms、位移 2.5rem 加淡入淡出；遮罩 150 淡入。reduced-motion 不位移、≤ 150（覆寫檔，vendor README 本地修改第 23 條） |
| 桌面側欄收合 | 照 SG（#1680）：width／left 的 transition 200ms linear；reduced-motion 沒有 transition（`motion.css`，`guard/` 量） |
| 面板高度差 | resize 300 |
| 工具卡、工具段展開 | **沒有動畫**（#1682 照 SG：`StepRow`／`StepGroup` 開關是立即的，只有箭頭轉 90°；reduced-motion 箭頭不轉場，vendor README 本地修改第 64 條） |
| 思考過程展開 | **沒有動畫**（#1683 照 SG：原生 `<details>` 開關是立即的，只有箭頭轉 90°；reduced-motion 箭頭不轉場，第 64 條擴充）。「思考中」用 SG 的 `.status-shimmer`（2.4s 掃過，reduced-motion 停住、改回字色）；狀態列的 shimmer 是 nexus 自己的 `.text-shimmer`，兩種並存 |
| 提問面板收起 | **沒有動畫**（#1687 照 SG：collapsible 沒有高度動效，收起的同一輪就 `hidden`，內容保持掛載）；箭頭照 SG 朝右、轉 90° |
| 其他展開收合（摘要列、待辦、排隊清單、核准的原始內容、觀測分頁） | **沒有動畫**（#1687 照 SG），只有 `Chevron` 朝右、轉 90°（150ms，reduced-motion 不轉場） |
| 捲到最新的按鈕 | 照 vendor 原樣（#1687 撤掉本地修改第 41 條）：藏著時往下位移一整個身高、縮 .95；出現 200ms、藏起來 400ms；reduced-motion 沒有 transition。避讓除了捲動與尺寸，過渡跑完（`transitionend`）再量一次 |
| 新訊息、工具卡出現 | 250，往上 8px |
| 面板換掉輸入框、上下題 | 舊 150 淡出 → 新 250 長出；上下題有方向 |
| 單選自動跳 | 先停 200 |
| 用量環的弧長（[#528](https://github.com/DemianLi/nexus-agent/issues/528)） | 500（#1591 起照 SG 的 `ContextRing`，#1468 Q8）；reduced-motion 直接跳到新值 |

- **按壓 .96（120ms）只給實心主按鈕與送出鍵**。
- **stagger 40ms 只給提問選項**（前 6 個）。
- **不動的**：載入歷史與切換對話、串流逐字（只有游標閃）；sonner 用它自帶的動畫與 reduced-motion（全關，跟我們「留 150 淡入」不同，已知差異）。
- **沒有 orb**：狀態列執行中是 SG 的 `StatusGlyph`（#1684，語意是「這一輪正在跑」）；空白 hero 是 SG 的 `Empty`，圖示不動（#1695）。`StatusGlyph` 在 reduced-motion 下停在每個圖形的起始姿勢，換圖形時 450ms 的 morph 也不跑。
- **「還在等」是 SG 的 `DotLoader`**（三點依序閃）：輪尾的重試提示、往前翻的讀取中（#1695）。reduced-motion 下停在全亮。

**reduced-motion**（不是全關；實作寫 `@media (prefers-reduced-motion: reduce)`，原型的 `data-reduce-motion` 屬性只是模擬）
- 位移、縮放、模糊拿掉，留 ≤ 150 的透明度；尺寸瞬間到位；按壓不縮；循環停一格；**狀態不能只靠動效表達**。
- SG 的進場（`.animate-float-in`／`.animate-fade-in`）在 reduced-motion 下被 SG 設成 `animation: none`，覆寫檔改回 150ms 淡入；SG 的持續動畫照 SG 停掉（Q5 優先於 Q8，`reduced-motion.test.ts`）。
- 做法：media query 裡把 `--animate-in`／`--animate-out` 換成只有透明度的版本，選擇器寫到 `:root:root *`（平常的值逐元素宣告，只寫 `:root:root` 會被蓋回去，#1687）。SG 的 sheet 用 transition 滑入、不走這幾個變數，由覆寫檔對抽屜另外拿掉位移、壓到 150（#1583，`check-built-css` 量產物）。
- JS 的 `scrollTo({ behavior: 'smooth' })` 不看 CSS，要自己讀偏好。

**效能**：持續動畫只動 transform／opacity（例外：`StatusGlyph` 每幀改 SVG 的 `cx`／`cy`／`r`／`opacity` 屬性，vendor 原樣，由 #1684 驗收 E 的量測當保險：串流中捲動與串流中不捲動兩格，條件同下），邊框光只剩等你處理那一圈的呼吸（opacity；執行中那道 conic 光隨 #1682 的工具卡換成 SG 拿掉）；`will-change` 不常駐。
- **大面積玻璃照 SG**（Q7），不再限「blur 只給小元素」。換來的是一道合併門檻（Q13、Q17）：Chrome 關 GPU 加速、CPU 降速 4 倍，量**串流中捲動、開 composer 選單（兩層 blur）、開關側欄**三種情境，p95 frame time ≤ 16.7ms。判讀用 rAF 間隔換算成 vsync 個數之後的 p95，**≤ 1 個 vsync** 就是過（≥95% 的幀準時；不用乘回毫秒比 16.7，headless 的時間戳只到 0.1ms，閒置間隔量成 16.8 時零掉幀也會判不過）；合成器 trace 的 `DrawAndSwap` 當佐證。量具是 `apps/web/scripts/measure-frames.mjs`（假模型端點、真 serve、headless Chrome）。
- [#1512](https://github.com/DemianLi/nexus-agent/issues/1512) 量過三種情境都是 16.70ms（CPU 實測降速約 3.8 倍；數字與條件在該 PR）。限制：headless；實機只量 demian 那台 Mac，VDI／沒有 GPU 的機器沒量（已知缺口，接受）。
- **不達標的退路是不透明**：沿用 `prefers-reduced-transparency` 那條路與 `<html data-glass="opaque">`，面換成不透明、拿掉 blur（§5 的目標一樣要過）。

## 8. 無障礙

出處：[無障礙](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797)。

**依據**：WCAG 2.2 AA 定門檻 → WAI-ARIA APG 定模式 → Base UI（#1523、#1583 起換成 solid-glass 的元件）、Radix 與 `@shadcn/react` primitive 的內建行為當基底。

**焦點**
- **只在焦點本來會丟掉時才搬**（在輸入框裡或已經在 body）。人在別處就不搶，由狀態列報讀。
- 核准與計劃審核落在面板本身（`tabIndex=-1` 的 region），**不能落在按鈕上**；提問落在當前題的 fieldset。
- 計劃審核按「查看全文」：焦點進右側欄的那個分頁；停靠時按收起，焦點回到「查看全文」（覆蓋那一種由 Sheet 還）。自動打開不搬焦點。
- 面板收掉：有下一個待決就到下一張，沒有就回輸入框。
- **焦點搬動的判斷寫在換手那一層**，不要散在各元件。
- 對話框、抽屜一律經過 Trigger（#1583 起是 Base UI 的）；做不到的（`SidebarTrigger`、受控開啟）自己用 Popup 的 `finalFocus` 還焦點：回傳要聚焦的元素，或自己聚焦之後回傳 `false`。
- `[tabindex="-1"]:focus-visible` 不畫外框。
- 確認框（alert-dialog）打開時落在第一個可 tab 的按鈕，也就是「取消」：不小心按 Enter 不會執行（Base UI 的預設，#1583）。
- 下拉選單：Trigger 是原生 button，Enter 打開（瀏覽器轉成 click），方向鍵移動 highlighted、Enter 選取並收起（Base UI 的 Menu；`guard/` 用真的 Chrome 量，#1583）。

**鍵盤**
- 核准面板與計劃審核面板不加快捷鍵，**Esc 不做事**。
- 提問面板留 primitive 內建，加數字鍵 1–9，**Esc＝收起**（不是停止）。
- **單選自動跳只認指標選取**（滑鼠、觸控、VoiceOver 點兩下）；鍵盤改選取不跳，要按 Enter。說明補一句告知（WCAG 3.2.2）。

**螢幕閱讀器**
- 面板出現不另開 live region，由狀態列（`role="status"`）唸；面板名稱＝報讀內容，例如「等待核准：edit_file（1／2）」「有 3 個問題要你回答（2／2）」「計劃待審」。
- **`role="status"` 只有狀態列**（[#1290](https://github.com/DemianLi/nexus-agent/issues/1290)，`apps/web/src/styles/live-region.test.ts` 守著）：代理的現況（待決、串流、失敗、連線）只由它唸。別處要唸，先看能不能不唸——背景變化（用量、目標、待辦、工具卡）不唸；讀取中不唸（只唸得出「開始讀」，讀完的內容不唸）；背景失敗掛在相關按鈕的 `aria-describedby`。例外只有兩格，都是**人自己的動作、焦點沒有地方落的結果**：
  - 側欄搜尋的結果（`sidebar/thread-list.tsx`）：焦點留在搜尋框，「沒有結果」不唸就不知道（WCAG 4.1.3 的例子）。
  - 觀測分頁「看這一輪」與定位的結果（`trace/panel.tsx`）：找不到、還在拉的時候焦點沒有地方落。
- **live region 要常駐、內容之後才填**：連同內容一起掛上去的那種，NVDA／JAWS 常常不唸。同一句要再唸一次，先清空、隔一下再填回去（DOM 沒變報讀器不會唸）。
- `role="alert"` 留給人剛做的事失敗了、要馬上知道的那一句（改名失敗、回饋送不出去、對子代理送話被拒），不是例外清單管的範圍。
- 換題：進度條 `aria-live` 關掉，legend 前放 sr-only「第 2 題，共 3 題」。
- AI 回覆：`role="log"` 設 `aria-live="off"`，串流不逐字唸，結束時把全文丟進 polite 區唸一次。
- 往前翻讀完：另一格 polite 唸「載入了較早的 N 則。」（N＝人打的字與模型的回覆，同 wire 一頁的單位），**不唸接上來的內容**，也不跟上一條共用一格（2026-09-25，inventory 列 9）。
- 工具卡狀態變化不唸。狀態列的 glyph（SG `StatusGlyph`）旁已有同義文字時 `aria-hidden`；`DotLoader` 本身沒有名稱，旁邊一定有同義的字。glyph 是裝飾，非文字對比以裝飾性豁免（WCAG 1.4.11 只管辨識內容所需的圖形；這一刻在做什麼由狀態列的字與工具列的字講，不靠 glyph）。
- **工具卡與工具段**（#1682，SG 的 `StepRow`／`StepGroup`）：
  - 列是一顆帶 `aria-expanded` 的按鈕，名稱＝標題＋摘要＋列尾看得見的字（工具名、計數、歸屬、狀態字）。狀態一定有字（Badge），不靠顏色、圖示或動效。
  - 群組按鈕的名稱＝「N 個工具呼叫，讀取 ×3、寫入檔案」（段裡只收完成的工具）。摘要是純字串、會被報讀，用「，」「、」接，不用「·」。段裡有寫檔／改檔時名稱後面接整段的合計「新增 N 行，刪除 M 行」（#1685，看得見的「+N −M」`aria-hidden`）。
  - 寫檔／改檔的列名稱裡「新增 N 行，刪除 M 行」只唸一次（同上）。展開後的 diff（SG `DiffView`）停得上焦點（vendor patch `0024`），名稱「改動內容」，方向鍵可以橫向、直向捲。
  - 展開後沒有內容的列，SG 會停用按鈕（聽起來像壞掉），所以空的時候放一句 emptyNote（「沒有參數。」「還沒有結果。」「沒有結果文字。」），按鈕照樣按得到。
  - 結果框的 `pre` 停得上焦點（vendor patch `0019`），名稱是框的標題（「參數」「結果」「錯誤」），鍵盤可以捲。
- **思考過程**（#1683，SG 的 `Reasoning`）：原生 `<summary>`，不另加 role、`aria-expanded`，展開與否由瀏覽器報。名稱只有「思考過程」或「思考中」；收合時那行摘要與「·」`aria-hidden`（摘要每來一顆 chunk 就變，焦點停在上面時報讀器會跟著重唸）。推理不進 polite 區唸（狀態列已經唸「執行中」）。
- **狀態列執行中那一列**（#1684，SG 的 `TurnStatus`）：live region 是 `status-line.tsx` 包在外面的 `<div role="status">`，vendor 的兩處 `role="status"` 由 patch `0023` 拿掉（按鈕上那處還會蓋掉按鈕角色）。字固定「執行中…」，不跟著 glyph 的樣子換（換一次就唸一次）。經過時間在 live region 外、`aria-hidden`（#1308），不接 SG 的經過時間、token 數與 children（都在那一列裡，會被一起唸）。
- **輸入框**（#1591）：名稱「要說的話」（`<label for="prompt">`），送出的說明（平常「Enter 送出」，跑著時「Enter 排隊・⌘/Ctrl Enter 插話」，`lib/submit-mode.ts`）是 sr-only 的一段、掛在 `aria-describedby`。`/` 與 @ 選單開著時輸入框帶 `aria-controls`（清單）與 `aria-activedescendant`（目前那一項）。主按鈕的名稱是「送出」「排隊送出」「插話送出」「停止」之一，照 dsh 的 `primaryLabel`。
- ❌ 的名稱「停止這一輪，不回答這些問題」（`aria-label` 與 tooltip 同一句），不加確認。
- **tooltip 只是視覺**（#1583）：Base UI 的 tooltip 不給 `role="tooltip"`、也不掛 `aria-describedby`，報讀器聽不到它。tooltip 的字不能帶 Trigger 名稱裡沒有的資訊，要聽到的寫進 `aria-label`（例：模型座「模型：X，從下一步生效，點開切換」）。
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
  - 一格停靠＋分頁，住著改動比對與交付預覽；不做分格、浮窗、拖放、復原。開關鈕在會話標頭那一列的右端（#655 做標題時確認它已經在標頭上，不用再搬）。
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

**搬的時候會無聲壞掉的一處**：`index.css` 的 `@theme` 覆寫 `--animate-collapsible-down/up` 時引用 `motion-fade-in`／`motion-fade-out`，而這兩個 `@keyframes` 定義在原型範圍的 `tokens.css`。只搬 `index.css` 不搬 keyframes，collapsible 的動效會變成什麼都沒有，而且不報錯。（#1687 照 SG 拿掉 collapsible 的高度動效之後，這兩個變數已不存在。）

**另一件實作要想的**：`AutoHeight` 在高度變化那 300ms 裁切（`overflow: hidden`），期間邊框光會被切掉一瞬間。

## 11. 實作必須帶的絆索

每條連回出處；#378 的三條量**建置出來的 CSS**，不是原始碼；第 12 條量原始碼的字串字面值；第 13 條量建置出來的 CSS 有沒有只來自測試檔或說明文件的 class。

| # | 絆索 | 出處 |
| --- | --- | --- |
| 1 | 同一 className 同時有 `border` 與 `shadow-`（排除 `shadow-none`）就報錯 | [#377](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498) |
| 2 | 用 colorjs.io 重算產生出來的 token，達到 §5 的對比度目標（文字、非文字、狀態色、亮暗共用） | [#377](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498) |
| 3 | reduced-motion 下 `--animate-in`／`--animate-out` 換成只有透明度的版本；用 transition 滑入的面（SG 的 sheet，名單在 `check-built-css.mjs` 的 `SLIDING_SURFACES`）要有拿掉位移、時長 ≤ 150ms 的規則（#1583） | [#378](https://github.com/DemianLi/nexus-agent/issues/378#issuecomment-5718598887) |
| 4 | `@keyframes` 名稱在允許清單上（清單在 `apps/web/scripts/check-built-css.mjs`），清單分兩段：**我們的** `motion-*`；**第三方** SG 的 `sg-dot-flash`／`sg-status-shimmer`／`sg-sweep`／`sg-float-in`／`sg-fade-in`（Q8）、tw-animate 的 `enter`／`exit`／`collapsible-*`（之後裝 accordion 多 `accordion-*`）、Tailwind 的 `spin`／`pulse`、sonner 的 `sonner-fade-*`／`sonner-spin`／`swipe-out-*`。只寫第一段，第一次跑就紅 | [#378](https://github.com/DemianLi/nexus-agent/issues/378#issuecomment-5718598887) |
| 5 | 每個 `infinite` 動畫在 reduced-motion 下都有對應：`spin`／`pulse` 用 class 蓋，`sonner-spin` 由 sonner 自己的 media query 關——要認得這兩種寫法 | [#378](https://github.com/DemianLi/nexus-agent/issues/378#issuecomment-5718598887) |
| 6 | axe-core 的 vitest（開發期相依），至少掃原型驗過的四個畫面：核准面板 375 暗、提問面板 375 暗、提問面板 1280 亮、對話流＋輸入框 375 暗 | [#384](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797) |
| 7 | 對話列表 `role="log"` 的 `aria-live="off"` 單獨釘一條 | [#384](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797) |
| 8 | 提問進度條的 `aria-live` 關掉單獨釘一條 | [#384](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797) |
| 9 | `index.html` 內嵌腳本與程式碼用同一個 `localStorage` key（讀腳本文字比對常數） | [#391](https://github.com/DemianLi/nexus-agent/issues/391#issuecomment-5722962752) |
| 10 | 三態各自套出正確結果：淺色沒有 `.dark`、深色有、`color-scheme` 跟著對 | [#391](https://github.com/DemianLi/nexus-agent/issues/391#issuecomment-5722962752) |
| 11 | 沒存過偏好時跟隨系統：stub `matchMedia` 回深色，確認掛上 `.dark` | [#391](https://github.com/DemianLi/nexus-agent/issues/391#issuecomment-5722962752) |
| 12 | 元件原始碼的字串字面值不越過系統的值：不用 Tailwind 預設色板（含 `white`／`black`）、字級只走 `text-ui`／`text-body`／`text-tip`／`text-micro`、圓角不寫數字任意值、不硬寫色碼、卡片與內層 stage 用 `Surface` 不手寫配方。例外只能列在 `apps/web/src/styles/design-system.test.ts` 的 `ALLOWED`（附理由），列了卻不再命中的條目報錯，所以例外只會變少 | [#1141](https://github.com/DemianLi/nexus-agent/issues/1141) |
| 13 | 建置出來的 CSS 裡沒有只來自測試檔或說明文件的 class：Tailwind 預設掃整個專案，測試的範例字串與文件提到的類別名會被編成真的規則（裸的 `.container`、`.shadow` 會套到不相干的元素）。`src/index.css` 用 `@source not` 排除，`scripts/check-built-css.mjs` 量產物確認 | [#1141](https://github.com/DemianLi/nexus-agent/issues/1141) |

**靠 review、不寫測試的**：持續動畫只動 transform／opacity（`StatusGlyph` 例外，見 §7）。

**還沒驗過的**（實作時要補驗或留意）：

- 停在**提問**時按停止：`turn-cancel.test.ts` 只測了停在核准；模型看到「before dispatch」後會不會重問同一組，要實跑（[#376](https://github.com/DemianLi/nexus-agent/issues/376#issuecomment-5709355235)）。
- 自建 markdown＋shiki＋katex 的 bundle 大小；`cn` 套件與 clsx＋tailwind-merge 是否完全等價——`button` 的 240 組已驗（197 組觸發合併、差異 0，#401），其他 registry 元件進來時各卡順手比對（[#374](https://github.com/DemianLi/nexus-agent/issues/374#issuecomment-5707786108)）。
- macOS VoiceOver 沒走過，只有 iPhone VoiceOver（[#384](https://github.com/DemianLi/nexus-agent/issues/384#issuecomment-5719457797)）。
- Artifact 沙盒裡的字型載入（[#377](https://github.com/DemianLi/nexus-agent/issues/377#issuecomment-5717372498)）。

## 12. 維護

- **改 token**：改產生器的輸入，重跑，表與 CSS 跟著出。這份文件只有在**目標或階梯**改了才動。
- **改動效**：改共用 CSS；新增或刪掉 `@keyframes` 時，同一個 PR 更新 §11 第 4 條的允許清單。
- **改規則**：改這份文件，PR 內文寫理由。**卡片留言不追改**——它是當初取捨的快照，只有「為什麼」是它的。規則被推翻時，在這裡寫新規則並連到做決定的地方。
