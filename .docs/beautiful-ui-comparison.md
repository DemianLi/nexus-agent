# beautiful-ui 比對

> 地圖 [#1278](https://github.com/DemianLi/nexus-agent/issues/1278) 的 D 卡（[#1282](https://github.com/DemianLi/nexus-agent/issues/1282)）。2026-10-10，dev-ui。
>
> 對象：[slev12397/beautiful-ui](https://github.com/slev12397/beautiful-ui)，固定在 commit `44a274e598395ab61e7c96c26fda2758780253b7`（寫這份時等於遠端 HEAD）。
> 我們：`develop` 的 `f6b40106`。
>
> 規矩（demian 2026-10-09 拍板，寫在 AGENTS.md「技術實現標準」）：beautiful-ui 只當 **AI 專屬元件**的參考對象，**不安裝、不複製程式碼**。要吸收就用我們自己的元件和設計數值重寫，我們的設計數值不換。
>
> 這份只是比對與提案。**哪幾列要開卡，等 demian 看過再決定**，見 §6 的候選表。

下文把 beautiful-ui 簡稱 BUI。BUI 的路徑相對它的 repo 根目錄，我們的路徑相對 `apps/web/src`。

## 0. 先講結論

- **它的 21 個元件裡，8 個我們沒有對應的場景**：diff-table、records-table、filter-table、flowchart、insight-cards、fine-tune-card、selection-actions、agent-screen。它們是 CRM、表格、畫布、設計工具、看螢幕這類場景。nexus 是企業內部查資料、接內部系統的聊天機器人（產品定位見 [#949](https://github.com/DemianLi/nexus-agent/issues/949)），目前沒有畫這幾種畫面的地方。（[#1307](https://github.com/DemianLi/nexus-agent/issues/1307) 更正：原本寫成「coding agent 的聊天介面」，跟 #949 定的定位相反。）
- **有對應的 13 個裡，狀態覆蓋與無障礙幾乎都是我們比較好。**
  - BUI 大多只有「進行中／完成」兩種狀態，沒有停止、錯誤、空、送出中。
  - 它幾種常見的無障礙寫法有問題：
    - 四顆動作鈕的名稱都叫 `Action`。
    - 收合用 `grid-template-rows: 0fr`，收著的內容仍然能用 Tab 走到。
    - 每 100ms 變一次的計時器放在 `role="status"` 裡，報讀器會一直重唸。
    - 單選題用 `aria-pressed` 的按鈕，不是 radio。
  - 它的 reduced-motion 只有一條全域規則，把所有動畫一刀全關。我們是選擇性的，保留 150ms 淡入。
- **它贏的是幾個「收尾」與「密度」的細節**，例如：
  - 回覆和程式碼區塊有複製鈕。
  - 換題時面板高度會跟著變。
  - 連續的工具呼叫收成一列。
  - 執行中看得到過了多久。
  - 推薦選項有獨立的標示。

  這些都能用我們現有的積木做，列在 §6。
- **它的設計語言跟我們同一路**：中性灰為主、顏色只當點綴、陰影很淡。但它自己有兩處破功：
  - 說明字的顏色 `ink-3` 對比度只有 2.4–2.7:1，不及格，而且在它的積木裡用了 88 次。
  - 任意字級在它的積木裡出現 201 次、14 種值。

  四條原則的提案見 §3，手感並排見 §4。

## 1. 21 列總表

「誰好」那一欄只講整體，細節見 §2。截圖欄是兩邊截圖的檔名，存放方式見 §7。

| # | 它的元件 | 我們對應的 | 誰好 | 要吸收的 | 截圖（它／我們） |
|---|---|---|---|---|---|
| 1 | loading-state | 狀態列 `status-line.tsx`＋`agent-orb.tsx` | 我們（狀態多 10 種）；它多一格經過時間 | 執行中顯示經過時間 | `loading-state`／`01-status-line`、`01-running` |
| 2 | thinking-state | 推理列 `reasoning-row.tsx` | 我們（收著也看得到最新一行）；它展開區有左線 | 展開區左線；「想了 N 秒」要 harness 補資料 | `thinking-state`／`04-reasoning` |
| 3 | streaming-text | 回覆 `transcript.tsx` 的 `Entry`＋`markdown-text.tsx` | 我們（真 markdown、停止／錯誤／上限）；它收尾比較齊 | 複製回覆 | `streaming-text`／`07-answer-code`、`01-running` |
| 4 | approval-card（其實是問卷） | 提問面板 `question-panel.tsx`＋`ui/questionnaire.tsx` | 我們（radio 語意、鍵盤改選不跳題、不自動送出）；它換題高度會跟著變 | 換題時面板高度跟著變 | `approval-card`／`09-question-panel`、`09b-question-answered` |
| 5 | tool-chips | 工具卡 `tool/card.tsx`＋改動卡 `changes/card.tsx` | 我們（四種狀態＋已停止、失敗寫原因）；它密度高 | 連續工具呼叫收成一列（要先拍板，見 §6） | `tool-chips`／`05-tool-card-edit`、`05-tool-card-read`、`06-changes-card` |
| 6 | task-rows | 待辦 `todo/`、工具卡、子代理狀態 | 我們 | 無 | `task-rows`／`03-todo`、`03b-todo-done` |
| 7 | chat-composer | 對話＋輸入框＋右側欄分頁 | 我們 | 無 | `chat-composer`／`08-thread-1280`、`12-composer` |
| 8 | prompt-bar | `composer.tsx`＋模型座／權限座／附件／用量環 | 我們（注音選字、非同步候選、listbox 語意） | 可選：@ 選單底部一行操作提示 | `prompt-bar`／`12-composer`、`10-mention-menu`、`11-slash-menu`、`13-model-picker` |
| 9 | recommendation-card | 大致沒有；最接近的是提問選項與計劃審核 | 不比 | 「（推薦）」字尾畫成小標 | `recommendation-card`／`09-question-panel` |
| 10 | context-cards | 讀檔卡、搜尋卡（`tool/result.tsx`） | 我們（行號、範圍、空狀態、截斷） | 今天沒有：等有檢索類工具再借「來源 chip」 | `context-cards`／`05-tool-card-read` |
| 11 | diff-table | 沒有場景（我們沒有表格資料） | — | 無 | `diff-table`／— |
| 12 | records-table | 沒有場景（只有 markdown 表格） | — | 可選：markdown 表格 hover 底色與數字欄 `tabular-nums` | `records-table`／— |
| 13 | filter-table | 沒有場景；最近的是會話清單 | — | 可選：會話狀態篩選 chip（價值不明） | `filter-table`／`14-sidebar` |
| 14 | sidebar-nav | 側欄 `sidebar/` | 各有所長：它層次清楚，我們清單資訊多、狀態全 | 滑動高亮（要先改規格 §7） | `sidebar-nav`／`14-sidebar` |
| 15 | search | 會話搜尋、cmdk 選單（分散四處） | 我們（狀態多）；它有清除鈕、空狀態好看 | 會話搜尋加 × 清除鈕；可選：空狀態版面 | `search`／`15-sidebar-search`、`15b-sidebar-search-empty` |
| 16 | flowchart | 沒有場景 | — | 無 | `flowchart`／— |
| 17 | insight-cards | 最近的是用量環、成本分頁 | 不比（用途不同） | 今天沒有：要畫圖得先回到 #1017／#1019 的範圍 | `insight-cards`／`17-usage-popover`、`18-cost` |
| 18 | code-block | markdown 程式碼區塊、讀檔卡、工具卡 diff、審查頁 | 我們（shiki、串流上色、收合截斷）；它有複製與 diff 行號 | 程式碼區塊複製鈕；工具卡 diff 加一欄行號；可選：字詞級高亮 | `code-block`／`07-answer-code`、`05-tool-card-edit` |
| 19 | fine-tune-card | 沒有場景 | — | 無 | `fine-tune-card`／— |
| 20 | selection-actions | 沒有場景（web 與 dsh 都沒有「選一段字交給 agent」） | — | 無；要做是新功能卡 | `selection-actions`／— |
| 21 | agent-screen | 沒有場景 | — | 無 | `agent-screen`／— |

另外三張我們的截圖沒有對到它的元件，一起附上，讓整體的樣子看得出來：

- `02-queue-dock`：送出佇列。
- `16-trace`：觀測分頁。
- `19-thread-375`：375 寬的手機版。

元件數是現場數的：`grep -cE '^\s*id:' lib/meta.ts` 得 22，扣掉型別宣告那一行（`lib/meta.ts:2`）是 21。

## 2. 逐列

每列只寫結論與根據。四份完整的中間筆記（逐行號比較結構、互動、狀態、無障礙）不進版控。

### 2.1 AI 過程類

**1. loading-state**

- 它是一行載入列：方格動畫＋shimmer 字＋經過時間，每 100ms 更新一次。
- 它的計時從元件掛上去那一刻起算（`LoadingState.tsx:63-72`），重新掛載就歸零。計時器放在 `role="status"` 裡（`:148-151`），報讀器會一直重唸。
- 我們的狀態列一個元件講完十幾種狀態：連線中、斷線重連、離線、失敗、等待核准、執行中、已停止……（`status-line.tsx:56-158`）。
- **吸收**：「執行中…」後面加經過時間。
  - 樣式用 `text-tip text-muted-foreground tabular-nums`。
  - **必須 `aria-hidden`，或放在 `role="status"` 外面**，不然會重現它的重唸缺陷。
  - 每秒更新一次就夠。
  - 起算點要 demian 選：
    - (a) 瀏覽器第一次看到「執行中」的時刻：小，但重新整理就歸零。
    - (b) server 給的 `startedAt`：中，要處理瀏覽器與 server 的時鐘差。多人共用主機、SSH 轉 port 時兩邊不是同一個時鐘。
- **不吸收**：
  - 四種方格動畫：我們的持續狀態是 orb，換掉要先改規格 §7。
  - Surfer 影片變體。
  - 「Churning」這類趣味文案。

**2. thinking-state**

- 它是可展開的過程：講完後標頭換成「Thought for 4 seconds」，展開區左邊有一條細線串起明細。
- 我們的推理列收著也看得到最新一行（串流中）或第一行（講完）。摘要刻意 `aria-hidden`，免得每來一段就重唸（`reasoning-row.tsx:17-18`）。
- 它把 `role="status"` 放在按鈕裡（`ThinkingState.tsx:164`），按鈕名稱一變就重唸。
- **吸收**：
  - 展開區加左線：沿用 `transcript.tsx:296` 子代理回覆已有的 `border-border border-l`，不做高度動畫。小。
  - 「想了 N 秒」**web 端做不出來**。推理沒有自己的起訖時刻，「講完」是從「正文開始了」推出來的（`lib/reasoning-view.ts:16-24`）；重新整理後回覆的 `startedAt` 等於 `settledAt`（`lib/trace-view.ts:35`）。要 harness 先補資料，跨 session，中。dsh 的 ReasoningRow 也沒有耗時。
- **不吸收**：
  - 自動展開再收起：我們刻意預設收合，免得把工具卡擠出畫面。
  - 明細逐列錯開進場：stagger 只給提問選項。

**3. streaming-text**

- 它講完會給一整排收尾：複製、重試、讚踩、來源、後續問題。但四顆動作鈕沒有 `onClick`，名稱都叫 `Action`（`StreamingText.tsx:161-173`）。串流中這排只是透明，鍵盤還按得到。
- 我們講完只有讚踩與「這一輪的過程」，而且要有評分外掛、`isRatable` 成立才出現（`transcript.tsx:329-331`）。
- **吸收**：回覆底下加複製鈕。
  - 樣子跟讚踩一樣：`Button variant="ghost" size="icon"`，用 lucide 的 Copy／Check。
  - 行為重用 `lib/clipboard.ts` 的 `copyText`（內網非安全來源有退路），回饋照 `deliverable/card.tsx` 的 `CopyPathButton`。
  - **不要跟評分外掛綁在一起**。
  - 小決定：複製 markdown 原文還是純文字。
  - 大小：小。
- **不吸收**：
  - 逐字模糊浮現：規格 §7 寫「串流逐字不動，只有游標閃」。
  - 重新產生：動到執行語意，要先查 dsh。
  - 來源、後續問題：沒有資料來源，要從 harness 或模型端開始，不是 web 的事。

**4. task-rows**

- 兩邊是同一種文法：一列，左邊狀態、中間名稱、右邊狀態字與箭頭，點開看明細。
- 我們的工具卡失敗時，摘要換成錯誤的第一行（`tool/card.tsx:276-284`），狀態一定有文字 Badge。
- 它進行中只有一個轉圈的環，狀態只靠畫面表達。
- **不吸收**：實心綠紅徽章與綠淡底的 Completed。這是取捨，不是對錯：
  - 一輪可能有幾十張工具卡，全標綠會變成一面綠牆。我們完成用灰勾、只有失敗上色，比較安靜。
  - 要改得先加一階 success 淡色 token。

**5. agent-screen**：沒有場景。agent 不操作圖形桌面，出廠工具也沒有截圖或操作瀏覽器的工具。不吸收。

### 2.2 核准與工具類

**6. approval-card**

- 名字叫核准卡，其實是一次一題的問卷。對應我們的提問面板，不是 `approval-card.tsx`（允許／不允許那張，BUI 沒有可比的）。
- 我們較好的地方：
  - **自動跳題**：
    - 它的選項是按鈕的 `onClick`，鍵盤 Enter 也會觸發；480ms 後就跳，最後一題直接送出（`ApprovalCard.tsx:231-238`）。
    - 我們只認指標選取，鍵盤改選不跳，最後一題不自動送出，跳之前先用 sr-only 講。這是規格 §8 與 WCAG 3.2.2 要的。
  - **語意與觸控尺寸**：
    - 它單選用 `aria-pressed`，選項列高約 21px，低於 WCAG 2.5.8 的 24px。
    - 我們用原生 radio、`fieldset`／`legend`，選項卡 44px。
  - **跳過**：它最後一題按 Skip 會關掉整張卡、不送出，跟我們「沒有放棄整組」的規則衝突。
- **它做到、我們沒做到的**：換題時面板高度跟著內容變。
  - 規格 §7 已經寫了「面板高度差 resize 300」（`.docs/web-ui-spec.md:211`）。
  - `styles/motion.css:150` 也定義了 `.motion-resize[data-resizing]`，連 reduced-motion 都排好了。
  - 但**沒有任何元件掛上它**：`grep -rnE 'motion-resize|data-resizing' apps/web/src` 只命中 motion.css 自己兩行。
  - 所以上下題切換時，面板高度是瞬間跳的。
- **吸收**：把 `.motion-resize` 掛到提問面板，換題時先量高度再過渡。不改規格，小。
- **不吸收**：
  - RollingDigits 跳號計數、GlideMenu 滑動高亮、radio 點的縮放：清單外。
  - 送出後的綠色膠囊：我們答完換回輸入框，答案畫在工具卡上。

**7. tool-chips**

- 它把一次執行的工具呼叫畫成一排 28px 高的緊湊列，最上面一顆「4 tool calls」可以收合整串。
- 我們每顆工具一張浮起來的卡，二十顆工具就是二十張卡往下疊。
- 它的狀態覆蓋很薄：
  - 每列沒有狀態，沒有執行中、失敗、停止。
  - 細節一律截斷。
  - 檔案 chip 的 diff 預覽只靠 hover：觸控用不了、沒有 Esc。「+2 more」沒有 `onClick`。
- **吸收（要先拍板）**：一輪裡連續的工具呼叫收成一列「N 個工具呼叫」，展開後是原本的工具卡。
  - 用 `RowTrigger fit="bare"`＋Chevron＋`text-tip`，動效用既有的展開收合 250／150，不改規格。
  - 兩份筆記意見不同：
    - 一份認為這是密度上最大的差距。
    - 另一份認為這是資訊層次的大改動，不建議。
  - 這是設計題，交 demian。要先決定：執行中、等你回答、失敗、帶邊框光的那顆收不收。我傾向只收「全部完成的連續段」。
  - 大小：中（要改對話項目的分組、邊框光、自動展開，還要補測試）。
- **不吸收**：
  - 圖示滑過換成箭頭：我們左邊的圖示是狀態，換掉會丟資訊。
  - hover 的 diff 預覽。
  - 橫排檔名 chip：路徑會被截斷。
  - 逐列冒出動畫。

**8. diff-table**：沒有場景，我們沒有表格資料。它的核心「每筆改動勾選後再套用」搬到我們身上，會變成「每個 hunk 個別核准」，要 harness 支援，是執行語意。不吸收。

**9. code-block**

- 它是一個淺色編輯器面板：有複製鈕、行號；diff 變體用單欄行號（刪除列用舊行號、其他用新行號）、有字詞級高亮。上色是自寫的正則。
- 我們好很多的地方：
  - shiki 上色，串流中逐行上色。
  - 收合頭尾、展開上限、超長單行截中間。
  - 讀檔卡的行號有 `aria-hidden`。它的行號只有 `select-none`，報讀器會唸出來。
- 我們沒有的：
  - **複製**：markdown 程式碼區塊沒有，檔頭寫明當時不在範圍（`components/markdown/code-block.tsx:12`）。
  - **diff 行號**：工具卡的 diff 沒有，只有 +／- 符號欄。
- **吸收**：
  - markdown 程式碼區塊加複製鈕，放在語言名那一列右邊。
    - 用 `Button` ghost＋lucide Copy／Check＋`copyText`。
    - 「已複製」要讓報讀器聽得到，失敗要交代。
    - 小；跟第 3 列的複製回覆可以同一張卡。
  - 工具卡 diff 加一欄行號，學它的單欄做法，`aria-hidden`＋`select-none`。
    - hunk 本身帶 `oldStart`／`newStart`，審查頁已經用 `lib/diff-rows.ts` 算過。
    - 小；但「執行中從參數算出來的 diff，起始行號準不準」要先確認。
  - 可選：字詞級高亮。
    - web 已相依 jsdiff，`diffWords` 現成，不必加套件。
    - 底色要另定一階，加深前要跑 `tokens-contrast.test.ts`。
    - 中。
- **不吸收**：
  - 自寫正則上色。
  - 一律換行：我們 markdown 區塊是刻意橫捲，審查頁另有換行切換。
  - 左邊 3px 色條：我們已有 +／- 符號，不只靠顏色。

**10. recommendation-card**

- 它是一個建議、一個信心度長條、一個替代方案抽屜、一顆主按鈕。
- 我們沒有信心度的資料來源。
- 但「推薦選項」我們有：ask-user 插件要模型「你有推薦的就放第一個，並在標籤後面加上『（推薦）』」（`packages/nexus-plugin-ask-user/src/index.ts:95`）。web 沒有特別處理，畫面上把「（推薦）」當成標籤文字原樣印出來。
- **吸收**：web 認出這個字尾，把它從標籤文字換成一顆小標（`Badge variant="secondary"`＋`text-micro`）。
  - **只改畫法，不改送回去的值**：答案是標籤原文。
  - 事後工具卡的「問題 → 回答」也要同一個畫法。
  - 小。
- **不吸收**：
  - 信心度：要改 ask-user 的 schema，是 harness 與模型面的事。
  - 替代方案抽屜：計劃審核照 dsh 只有兩顆鈕。
  - EntityChip／ValuePill：markdown 內文沒有結構化的實體可以餵。

### 2.3 輸入框與導覽類

**11. chat-composer**

- 它把分頁、對話、輸入框塞進一張 288px 高的卡，是展示用的形狀，回覆靠計時器推進。
- 我們拆成三個獨立元件。
- 它的毛病：
  - 送出不管注音選字。
  - 三顆圖示鈕都叫 `Action`。
  - 分頁用 `aria-pressed` 而不是 tablist。
- 不吸收。

**12. prompt-bar**

- 兩邊都有方向鍵、Enter／Tab 選、Esc 收。
- 它選單開著時，Enter 不看 `isComposing`（`PromptBar.tsx:623-627`），打注音時按 Enter 會直接選中一列。我們在最前面就擋（`composer.tsx:408`）。
- 我們的 @ 候選是問伺服器的：會取消上一次查詢，還沒回來時有骨架與 `aria-busy`，而且有 listbox 語意與 `aria-activedescendant`。
- 它的「單行時控制項同列、換行才分兩列」做得精巧，但我們底列有六樣東西，同列放不下。
- **可選吸收**：@ 選單底部加一行操作提示「Tab 進資料夾 · Enter 選定 · Esc 收起」。資料夾列已經畫了「Tab →」，價值不高。
- **不吸收**：
  - 「No matches」空列：跟我們照 dsh 定的「查回空的就收起」衝突（`lib/mention-menu.ts:10`）。
  - glimm 彩虹掃光。
  - 品牌連接器。
  - 選了模型立刻生效：我們是從下一步生效，屬執行語意。
  - 聽寫：見 §5。

**13. sidebar-nav**

- 它的三層（工作區、主導航、對話）層次清楚，但對話清單只有標題。
- 我們有：
  - 釘選／今天／昨天／過去 7 天的分組。
  - 每列即時狀態點，加給報讀器的一句話。
  - 第二行寫時間。
  - 內容搜尋片段。
  - 每列「⋯」選單。
- 收起時：
  - 它的文字只是透明，Tab 還走得進去。
  - 我們桌面收起時整條 `inert`。
- **吸收（要先改規格）**：GlideMenu 的滑動高亮，也就是一層底色跟著 hover 與焦點在列之間滑動。
  - 這是規格 §7 清單外的新模式，要先在 §7 加「指示器滑動」，由 demian 拍板。
  - 做的話寫成我們自己的積木：時長用 `--duration-fast`（250）＋`--ease-smooth-out`，reduced-motion 下瞬間到位。
  - cmdk 那幾個選單要另外量 `data-selected` 的位置，不能直接套。
  - 中。
- **不吸收**：
  - 工作區切換、邀請、Upgrade：沒有場景。
  - 收成圖示軌：我們側欄只有一顆按鈕。
  - 搜尋框藏起來、點了才長出：我們的搜尋常駐，是找舊會話的主要路。
  - 按壓縮放 .98。

**14. search**

- 它是一個乾淨的通用積木：有明確的 × 清除鈕，空狀態是圖示加兩行字。
- 它的毛病：
  - 1–2 個字搜不到時什麼都不說（`SearchList.tsx:49`）。
  - 清單沒有方向鍵、沒有 listbox 語意。
- 我們的會話搜尋有：搜尋中骨架、兩種「搜不到」說法、結果太多、失敗退回只比標題。
- **吸收**：
  - 會話搜尋加 × 清除鈕：
    - 用 `InputGroup`＋`InputGroupAddon align="inline-end"`＋`Button variant="ghost" size="icon"`。
    - `aria-label="清除搜尋"`，有字才出現，按了清空並把焦點留在輸入框。
    - 要先實機看 Chrome 對 `type="search"` 有沒有畫原生那顆 ×，避免出現兩顆。
    - 小。
  - 可選：搜不到時的版面改成圖示加標題加提示。小。
- **不吸收**：
  - 新做一個通用 SearchList：我們沒有兩處同一份配方。
  - 輸入列的 hover 底色。

**15. selection-actions**

- 它示範的是「選了一段字之後浮出來的 AI 動作列」，但選取是寫死的 span，外層 `select-none`，沒用 Selection API。
- 我們沒有這個場景，dsh 也沒有：它的 `packages/client` 六處 `getSelection` 都讀過，三處是點擊防護，三處在輸入框編輯器裡。
- 要做等於「送一輪給模型，再決定結果寫回哪裡」，是新功能卡，不是 UI 吸收。
- 它的 Shimmer 與串流游標我們已經有（`text-shimmer`、`stream-caret`）。
- **不吸收**它的游標行為：它是串流時實心、停了才閃。我們的游標只在串流時畫，閃爍就是規格 §7 那唯一一個串流動效。

### 2.4 資料與其他類

**16. context-cards**

- 它是 RAG 片段清單：標題、摘錄、來源 chip。
- 我們沒有檢索類工具。`docs/tool-catalog.md` 裡讀檔與搜尋只有 `read_file`、`grep`、`glob`。
- 它的來源 chip 畫了 ↗，但是 `<span>`，不能點、不能 focus。
- 今天不吸收。將來 MCP 或插件帶進檢索工具、要畫片段卡時，用 `Surface tone="stage"`＋`Attachment size="sm"` 做來源 chip，能打開才畫 ↗，而且要是真的按鈕或連結。

**17. records-table**

- 沒有場景。我們唯一的表格是模型回覆裡唯讀的 markdown 表格。
- 它的無障礙問題不少，不要學：
  - 巢狀互動元素。
  - th 沒有 `aria-sort`。
  - 部分選取沒設 `indeterminate`。
  - 調欄寬不能用鍵盤。
  - 資料為空時平均值除以 0，算出 NaN%（`RecordsTable.tsx:736`）。
- 可借的：
  - 「放不下就收成 +N」的量測做法，等哪一排 chip 只能單行時再用。
  - 可選：markdown 表格加列的 hover 底色（`bg-chip-hover`），數字欄加 `tabular-nums`。小。

**18. filter-table**

- 沒有場景。它的計數寫死，沒從資料算。篩掉的列仍在無障礙樹裡。
- 可選：會話清單加狀態篩選 chip。
  - 照 `feedback-dialog.tsx:70-83` 的單選 chip 先例做（`role="group"`＋`Button` default／outline＋`aria-pressed`）。
  - 篩掉的直接不渲染。
  - 今天會話不多，價值不明，不主張排進來。

**19. flowchart**：沒有場景。它拖曳門檻 3px、拖完不誤觸點擊，這兩個細節寫得好，但我們用不到。

**20. insight-cards**

- 它是翻頁輪播，每頁一句結論、一張 canvas 圖、一顆追問。圖由 npm 套件 `liveline` 畫。
- canvas 沒有文字替代，不符 WCAG 1.1.1。
- 檔頭寫有 autoplay 與模糊交叉淡入，程式裡都沒有。
- 我們的成本分頁 v0 寫明「不畫圖表」（`components/cost/panel.tsx:22`），理由是加了就要帶進圖表套件。
- 今天不吸收。要在成本分頁畫逐輪走勢的話：
  - 學它「一句結論＋一張小圖」的組法，照用量環的先例手畫 SVG，旁邊保留數字當報讀替代。
  - 先回到 #1017／#1019 的範圍決定。
  - 中。

**21. fine-tune-card**：沒有場景，nexus 不讓 agent 改視覺屬性。它的 `ScrubField` 鍵盤設計完整（方向鍵、⇧×10），但用不到。

## 3. 它的四條原則

出處是它的 `components/site/Foundations.tsx:44、73、94`，原文是 "Secondary gets color, not weight"、"Color is a condiment"、"Never harsh"。「一個面一顆實心按鈕」出自 `:73` 同一句的後半。

| 原則 | 我們現況（現場數） | 提案 | 能變成測試嗎 |
|---|---|---|---|
| **顏色只當點綴** | 已經是這樣：色值以灰階為主，帶色相的只有 brand、success、warning、info、destructive 這幾個語意 token（`styles/tokens.generated.css`）。`design-system.test.ts` 已擋原生色板、white／black、hex、沒有 var 的色彩函式 | **採用**，寫進 `COMPONENTS.md` 當原則 | 已經有一半：原色擋得住。「彩色面積不能大」靜態量不出來，不另寫測試 |
| **次要靠顏色不靠字重** | `font-light／thin／extralight` 0 次；`font-medium` 28 次、`font-semibold` 1 次（`components/` 不含 ui/）；次要字一律 `text-muted-foreground` | **採用，但加一條它自己沒守住的**：次要色本身要過 4.5:1。它的 `ink-3` 只有 2.4–2.7:1（§4） | 可以：細字重的類別加進 `design-system.test.ts` 的擋單（今天 0 次，是絆索）。次要色的對比已由 `tokens-contrast.test.ts` 守 |
| **一個面一顆實心按鈕** | `components/`（不含 ui/）裡 `variant="ghost"` 32、`outline` 14、`secondary` 6、`destructive` 1；沒寫 variant 的就是實心。按壓縮放也只給實心主按鈕 | **採用**，寫進 `COMPONENTS.md`。這是我們已經在做的事，寫下來讓新元件照做 | 靜態量不準：條件渲染會讓同一個檔裡兩顆實心按鈕不同時出現。**不寫測試**，靠 review |
| **不刺眼**（陰影分層、單位數透明度） | 亮色陰影每層 ≤ 0.06；暗色 menu 的外層是 0.24（暗底上要更濃才看得到） | **採用亮色的部分**。暗色不套這個數字 | 可以：解析 `theme.css` 的 `:root` 陰影，每層透明度 ≤ 0.06。只管亮色 |

## 4. 手感並排

| 項目 | 它 | 我們 | 提案 |
|---|---|---|---|
| 陰影 | card／raised／overlay 都是「1px 細線環＋5–6 層、每層 ≤ 0.05」（層數由它的 shadow-plugin 產生，實機用 computed style 讀） | material：細線環＋2 層（0.06／0.04）；menu：細線環＋2 層（0.05／0.06） | **不補**。兩邊同一個思路（細線環＋淡投影），差在層數。多疊幾層的差別在截圖上要放大才看得出來，不值得換掉已經過對比與實機驗收的數值 |
| 按下縮放 | `atoms/Button.tsx:14` 所有變體 `active:scale-[0.96]`；全站還有 0.94（4 次）、0.97（4）、0.98（8）、0.99（2），0.96 共 14 次 | 只給實心主按鈕與送出鍵，scale .96、120ms（`styles/motion.css:160-178`）；token 有 .96–.99 四階 | **不補**。我們已有，而且範圍更窄是規格 §7 刻意的：ghost 按鈕一按就縮，在一排工具卡上會很吵 |
| 緩動曲線 | `--ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1)` | `--ease-smooth-out: cubic-bezier(0.22, 1, 0.36, 1)`（`index.css:33`） | **不換**。兩條肉眼分不出來 |
| 時長 | 用量最多的是 `duration-150`（69 次）、`duration-100`（50 次），都直接寫數字 | 階梯 40／80／120／150／200／250／350／400／500，元件只能用 token（#1280 起有測試擋） | 不換 |
| 字級 | `components/primitives`＋`components/atoms` 共 201 次任意字級、14 種值：13px×52、12px×44、12.5px×38、11.5px×23、11px×18……；連展示站共 295 次 | 規格四階；任意字級 2 次（`ui/questionnaire.tsx:142` 的快捷鍵字、`session-reference.tsx:25` 的 0.9em） | 不換。字級主次是另一張卡 #1281 |

### 對比度（瀏覽器實測）

| 色對 | 對比 | WCAG AA |
|---|---|---|
| 它 亮 `ink` / `surface` | 16.14:1 | 過 |
| 它 亮 `ink-2` / `surface`（次要字） | 5.84:1 | 過 |
| 它 亮 `ink-3` / `surface`（說明字） | **2.72:1** | **不及格** |
| 它 亮 `ink-3` / `page` | **2.61:1** | **不及格** |
| 它 亮 `ink-3` / `canvas`（展示框底） | **2.43:1** | **不及格** |
| 它 亮 `accent-ink` / `surface`（連結字） | 4.81:1 | 過 |
| 它 亮 白字 / `accent`（accent 按鈕） | 3.62:1 | 只過大字 |
| 它 亮 `canvas` / `ink`（主按鈕） | 14.40:1 | 過 |
| 它 暗 `ink-2` / `surface` | 6.51:1 | 過 |
| 它 暗 `ink-3` / `surface` | 3.08:1 | 只過大字 |
| 我們 亮 `foreground` / `background` | 16.39:1 | 過 |
| 我們 亮 `muted-foreground` / `background`（次要字） | 6.11:1 | 過 |
| 我們 亮 `muted-foreground` / `card` | 6.48:1 | 過 |
| 我們 亮 `muted-foreground` / `chip`（泡泡上的小字） | 4.77:1 | 過 |
| 我們 亮 `foreground` / `chip` | 12.81:1 | 過 |
| 我們 亮 主按鈕 | 17.93:1 | 過 |
| 我們 亮 `brand` / `background` | 4.60:1 | 過 |
| 我們 暗 `muted-foreground` / `background`、`card`、`chip` | 6.05／5.67／4.74:1 | 過 |

`text-ink-3` 在它的 `components/primitives`＋`components/atoms` 裡用了 88 次，連展示站共 141 次。所以它的「次要靠顏色」原則，在說明字這一階是靠一個不及格的顏色撐起來的。我們採用這條原則時，不能連數值一起抄。

## 5. 不碰的

| 東西 | 在它哪裡 | 為什麼不碰 |
|---|---|---|
| 付費圖示 `@central-icons-react` | `lib/meta.ts:118`、`SidebarNav.tsx:5-16` | 授權要另外評估；我們用 lucide |
| 圖示 `iconoir-react` | `SelectionActions.tsx` | 我們只用 lucide 一套 |
| 影片（Surfer 變體，Vercel Blob） | `LoadingState.tsx:81` | 外部資源；nexus 完全內網 |
| 外部字型 Inter、JetBrains Mono | 它的展示站 | 我們的字型（Google Sans Flex／Code、中文退 Noto Sans TC）全部打包進本地，見規格 §5 |
| 預設深色 | 它的展示站 | 我們預設跟系統走（`lib/theme.ts` 讀 `prefers-color-scheme`），亮暗兩套都有對比測試 |
| 音效（`data-sound-silent`） | `RecordsTable.tsx:707` 等 | 不做音效 |
| PostHog、Resend | 它的展示站 | 外部服務；內網不送遙測 |
| 示範資料與計時器推進的假狀態 | ChatComposer、PromptBar（自動播放）、ThinkingState、SelectionActions 等 | 不是元件行為 |
| npm 套件 `liveline`、`glimm` | InsightCards、PromptBar | 不安裝它的東西；圖表沒有文字替代，掃光是 WebGL 裝飾 |
| 清單外的動效：GlideMenu 滑動、RollingDigits、逐列 stagger、`shimmer-text` 無限掃光、`records-pulse`、0fr 逐列收合、寬度與 max-width 動畫 | 多處 | 規格 §7 的模式清單是封閉的。要的話先改規格（目前只有 GlideMenu 列成候選） |
| 聽寫 | `PromptBar.tsx:327-335`（假的，2.2 秒後塞一句寫死的字） | 不是 UI 吸收。dsh 有一個實驗套件 `packages/experimental/client-ui-voice-input`：辨識在 Host 端，模型從可設定的來源下載。要做是另一張功能卡，先問 demian |

## 6. 開卡候選（待 demian 選）

**這張表只給 demian 選，還沒有開任何卡。**

「規格」欄指要不要先改 `.docs/web-ui-spec.md`；「跨 session」指要不要 dev-harness 動手。

| 代號 | 內容 | 來自 | 大小 | 規格 | 跨 session | 我的建議 |
|---|---|---|---|---|---|---|
| C1 | 回覆底下加複製鈕＋markdown 程式碼區塊加複製鈕（同一套按鈕與回饋） | 3、18 | 小 | 不用 | 不用 | 開 |
| C2 | 提問面板換題時高度跟著變（掛上已定義的 `.motion-resize`） | 4 | 小 | 不用（§7 已寫） | 不用 | 開 |
| C3 | 提問選項的「（推薦）」字尾畫成小標，送出的值不變 | 9 | 小 | 不用 | 不用 | 開 |
| C4 | 推理列展開區加左線 | 2 | 小 | 不用 | 不用 | 開，可以跟 #1281 字級主次一起看 |
| C5 | 工具卡 diff 加一欄行號 | 18 | 小 | 不用 | 不用（要先確認執行中 diff 的起始行號） | 開 |
| C6 | 會話搜尋加 × 清除鈕 | 14 | 小 | 不用 | 不用 | 開 |
| C7 | 狀態列執行中顯示經過時間 | 1 | 小（a）／中（b） | 不用 | 不用 | 開，**起算點 a／b 請 demian 選** |
| C8 | 連續工具呼叫收成一列 | 5 | 中 | 不用 | 不用 | **設計題，請 demian 決定要不要**；要的話先定哪些狀態不收 |
| C9 | diff 字詞級高亮 | 18 | 中 | 要加一階底色 | 不用 | 等 C5 做完再看 |
| C10 | 側欄與選單的滑動高亮 | 13 | 中 | **要先改 §7** | 不用 | 不急；要的話先拍板規格 |
| C11 | 推理列「想了 N 秒」 | 2 | 中 | 不用 | **要**（harness 補推理起訖） | 不急 |
| C12 | `COMPONENTS.md` 寫進三條原則＋兩條絆索測試（細字重、亮色陰影透明度） | §3 | 小 | 不用 | 不用 | 開 |

可選、價值不高，不建議現在開：

- @ 選單底部操作提示。
- 搜尋空狀態版面。
- markdown 表格 hover 與 `tabular-nums`。
- 會話狀態篩選 chip。
- chip 溢出收成 +N。
- 成本分頁小圖（要先回 #1017／#1019）。

不是 UI 吸收、是新功能，要另議：

- 聽寫。
- 選取改寫。
- 重新產生。
- 後續問題。
- 引用來源。
- 逐 hunk 核准。

## 7. 截圖與量法

### 截圖

- **它的**：用它公開的展示站 `https://www.beautifului.dev/`，亮色、1280 寬，用 headless Chrome 對每個元件的區塊截圖，共 21 張。
  - 沒有在本機起它的站，也沒有接任何外部服務，只是開一個網頁。
  - 展示站的版本不一定等於上面固定的 commit。程式碼的比對以 commit 為準，截圖只看外觀。
- **我們的**：本機 `serve`，接真模型 `nvidia/nemotron-3-super-120b-a12b`，亮色，headless Chrome 實機操作後截圖，共 25 張。檔名就是 §1 截圖欄寫的那些。
- **截圖不進版控**（PM 2026-10-10 決定）：repo 到今天沒有任何圖片檔，不為這份開先例。兩邊並排的對照頁另外直接交給 demian。

### 量法（都可以照著重跑）

- **元件數**：
  - 在它的 repo 根目錄跑 `grep -cE '^\s*id:' lib/meta.ts`。
- **任意字級**：
  - 在它的 repo 根目錄跑 `grep -rhoE 'text-\[[0-9.]+px\]' components/primitives components/atoms | sort | uniq -c`，加總得 201。
  - 範圍改成 `components app` 得 295。
  - 我們：在 `apps/web/src` 跑 `grep -rhoE 'text-\[[^]]+\]' . --include='*.tsx' --exclude='*.test.tsx'` 得 2。
- **說明字色用量**：
  - `grep -rhoE 'text-ink-3' components/primitives components/atoms | wc -l` 得 88。
  - 範圍改成 `components app` 得 141。
- **按壓縮放、時長**：
  - `grep -rhoE 'active:scale-\[[0-9.]+\]' components | sort | uniq -c`。
  - `grep -rhoE 'duration-[0-9]+' components | sort | uniq -c`。
- **按鈕變體與字重**：
  - 在 `apps/web/src` 跑 `grep -rhoE 'variant="<名稱>"' components --include='*.tsx' --exclude='*.test.tsx' --exclude-dir=ui | wc -l`。
  - 字重同法。
- **對比度**：
  - 前景與背景的 oklch 值，取自它的 `app/globals.css:22-93` 與我們的 `styles/tokens.generated.css`。
  - 在 headless Chrome 裡用 canvas（sRGB）填色、讀回像素，再照 WCAG 2.x 的相對亮度公式算比值。
  - 不是目測，也不是沿用盤點時的估計。
- **陰影**：
  - 它的陰影由 shadow-plugin 產生，原始碼裡只看得到變數名，所以在它的展示站對 `shadow-card`、`shadow-raised`、`shadow-overlay` 讀 `getComputedStyle().boxShadow`。
  - 我們的直接讀 `styles/theme.css:10-31`。

## 8. 順帶發現（不在這張卡修）

- `components/sidebar/thread-list.tsx:240`、`:250` 各有一個 `role="status"`。規格 §8 與 `status-line.tsx` 的檔頭說全站只有狀態列一個。這張卡只動文件，不修，已知會 PM。
- 兩邊都沒有 `aria-current`。我們目前那條會話是 `disabled`（`thread-list.tsx:410`），焦點進不去，靠第二行「目前這條」的字讓人知道。
