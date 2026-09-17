# 基於 shadcn 的 agent UI 元件庫 —— nexus web 介面選型調研

**調研日期**：2026-09-17。

**問題**：`apps/web` 已經是 shadcn/ui（見 [README.md](../README.md) 第 19 行），想找「基於 shadcn、專為 agent UI 設計」的元件來做 nexus 的 web 介面，**RWD 是硬性要求**。

> **後續決議（2026-09-17，[地圖 #372](https://github.com/DemianLi/nexus-agent/issues/372)）**：這份是選型當下的調研快照，下面的推論沒有逐段改寫。跟後來實測與拍板衝突的地方，一律以這裡列的為準：
>
> - **§6 的推薦與速查表「推薦」那一列已被推翻。** [每個 P0 元件各從哪裡拿](https://github.com/DemianLi/nexus-agent/issues/374#issuecomment-5707786108) 拍板：**主用 shadcn 官方當外殼與基礎件；AI Elements 只參考它的元件清單，不用它的程式碼**；markdown、shiki／katex、工具依名分類呈現照 dsh 自建。
> - **§6「代價與風險」第 1、4、6 點與 §7 前兩點已由實測回答**（[#373 結果](https://github.com/DemianLi/nexus-agent/issues/373#issuecomment-5706000767)）：AI Elements registry **沒有**替每個元件加 `ai`／`@ai-sdk/react`／`zod`（只有真的 import 的四個帶 `ai`）；`questionnaire` 在 new-york 下 404、用 `radix-vega` 完整網址裝得上；AI Elements `question` 線上 registry 沒部署；`reasoning`／AI Elements `message` 讓主 chunk 漲到約 2 MB。
> - **提問卡走 shadcn `questionnaire`**，缺的部分自己補（[設計語言原型](https://github.com/DemianLi/nexus-agent/issues/375#issuecomment-5708312161)）。
> - **核准與提問都換掉輸入框**（照 dsh 的 composer takeover），不是 §6 表裡的「自己的卡」（[核准與提問](https://github.com/DemianLi/nexus-agent/issues/376#issuecomment-5709355235)）。

## 結論速查表

| 問題 | 結論 | 證據在 |
| --- | --- | --- |
| 有沒有一套能直接照單全收的？ | **沒有。** 沒有任何一家的形狀對得上 `@nexus/wire` 的 `ConversationEntry`，也沒有任何一家替你做好頁面層的 RWD | §4、§5 |
| RWD 誰負責？ | **頁面骨架（側欄、抽屜）靠 shadcn 官方的 `sidebar`**（`useIsMobile` → 手機改成 Sheet）；訊息層元件幾乎都**不帶斷點**，只是不擋你。RWD 是我們自己的工作 | §5 |
| 推薦（**已被推翻**，見開頭「後續決議」） | **分三層取用，全部走 registry 複製原始碼**：① shadcn 官方 chat 元件（`message-scroller`／`message`／`bubble`／`attachment`／`marker`）＋`sidebar` 當骨架；② AI Elements 取 agent 專用件（`tool`、`reasoning`、`plan`、`task`、`queue`、`chain-of-thought`、`code-block`、`question`）；③ 對不上的（整批核准）留我們自己的卡 | §6 |
| 不推薦 | **assistant-ui 的 runtime 那一層**（`*.aui.tsx`＋`AssistantRuntimeProvider`）：會跟 `@nexus/wire` 搶狀態擁有權；它的 LangGraph adapter 講的是 LangGraph Server SDK 的串流，不是我們的線 | §3.2 |
| 子代理初稿的主要錯誤 | 把「示範站是 Next.js」當成「元件需要 Next.js」、把 AI Elements 有的核准卡與提問卡寫成沒有、捏造 API 名 `BranchPickerOKCancelButton`、dsh SHA 與 AI Elements 授權寫錯、完全漏掉 shadcn 官方 2026 年新出的 chat 元件 | §1 |
| dsh 標準怎麼說 | dsh **有** web 前端，但是 React 18 ＋ CSS Modules ＋ 自家 `packages/client/ui-*`，**沒有 shadcn／Tailwind**。能抄的是**行為**（1024px 以下側欄自動收起、核准卡與工具卡分開），不是元件庫 | §2 |

## 1. 來源與可信度

所有 repo 都 `git clone --depth 1` 到 scratchpad 讀原始碼，SHA 如下。

| 來源 | SHA／版本（commit 日期） | 核對方式 |
| --- | --- | --- |
| [vercel/ai-elements](https://github.com/vercel/ai-elements) | `6a9d5b1`（2026-08-21） | 主代理讀 `packages/elements/src/*.tsx` 的 import 與 props、`apps/docs/app/api/registry/[component]/route.ts` |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | `c2beb1e`（2026-09-16） | 主代理讀 `apps/registry/src/registry.ts`、`packages/ui/.../elements/`、`packages/react-langgraph/` |
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | `f5bb039`（2026-09-16） | 主代理 sparse checkout `apps/v4/registry/new-york-v4/ui`、`apps/v4/registry/bases/radix/ui`；changelog 頁用 WebFetch 讀（摘要，非逐字） |
| [ibelick/prompt-kit](https://github.com/ibelick/prompt-kit) | `de80375`（2026-03-12） | 主代理讀 `components/prompt-kit/*.tsx` 的 import |
| [langchain-ai/agent-chat-ui](https://github.com/langchain-ai/agent-chat-ui) | `41926d8`（2026-09-14） | 主代理讀 `package.json`、`src/components/thread/index.tsx` |
| [run-llama/chat-ui](https://github.com/run-llama/chat-ui) | `a514498`（2025-12-16） | 子代理讀；主代理只回核 `packages/chat-ui/package.json` |
| [Blazity/shadcn-chatbot-kit](https://github.com/Blazity/shadcn-chatbot-kit) | `fe32b92`（2026-02-27） | 主代理讀 `apps/www/package.json`、`apps/www/registry/default/ui/` |
| dsh（本機 `references/deepseek-harness`） | `e459e32`（2026-09-15） | 主代理讀 `apps/web/package.json`、`packages/client/*` |
| nexus 自己 | develop `8262bc0` | 主代理讀 `apps/web/*`、`packages/nexus-wire/src/conversation.ts` |

**這份筆記是重寫的。** 第一版由子代理起草，主代理回核時推翻了它的結論，逐條如下（留著是因為這些錯正是這類調研最容易犯的）：

| 初稿宣稱 | 實際 | 怎麼查的 |
| --- | --- | --- |
| AI Elements、prompt-kit、shadcn-chatbot-kit「必須 Next.js，Vite 無法用」 | AI Elements `packages/elements/src` 與 prompt-kit `components/prompt-kit` **沒有任何** `next`／`next/*` import（搜了 `from "next`、`next/`、`require("next`、`import("next`）。Next.js 是它們**文件站**的相依。`"use client"` 在 Vite 下只是一行無作用的字串 | grep 元件原始碼，不是讀 repo 根的 `package.json` |
| AI Elements「❌ 無人類核准卡、❌ 無提問卡」 | 有 `confirmation.tsx`、`question.tsx`，另有 `plan`、`task`、`queue`、`checkpoint`、`chain-of-thought` | `ls packages/elements/src` |
| assistant-ui 有 `<BranchPickerOKCancelButton>` 核准元件 | **全 repo 不存在這個名字**（排除 node_modules 的全文 grep 零筆）。它真正的核准件是 `elements/approval-card.tsx` 與 `tool-fallback.aui.tsx` 裡的 approval 路徑 | grep |
| dsh SHA `0d1f500`；dsh 用 CSS Modules | SHA 實為 `e459e32`；CSS Modules 屬實（`packages/client` 下 141 個 `.css`） | `git rev-parse` |
| AI Elements 授權 MIT | **Apache-2.0**（`LICENSE`） | 讀檔 |
| 每一家 RWD 都 ✅ | 見 §5：訊息層元件幾乎都沒有斷點 class | grep 斷點 |
| 「139 個 shadcn 相容元件」「Y Combinator 背書」 | 找不到出處，刪除 | — |
| （漏掉）| shadcn 官方 2026-06 出了 chat 元件、2026-08 出了 `questionnaire` | changelog |

## 2. dsh 標準怎麼做

依 [AGENTS.md](../AGENTS.md)「技術實現標準」先查 dsh。

- **dsh 有 web 前端**：`apps/web`（`@deepseek-ai/dsh-web-frontend`）是 `vite build` 包一層 `@deepseek-ai/dsh-client-web`，React `^18.2.0`、Vite `^6`（`apps/web/package.json`）。
- **樣式是 CSS Modules，沒有 shadcn、沒有 Tailwind**：`packages/client` 下 141 個 `.css`；全 repo 的 `package.json` 搜 `tailwindcss|shadcn|@radix-ui` 零筆，`pnpm-lock.yaml` 搜 `tailwindcss|@radix-ui` 也是零筆。
- **UI 按功能拆成插件套件**：`packages/client/ui-approval`、`ui-tool`、`ui-plan`、`ui-subagent`、`ui-user-questions`、`ui-message-feedback`、`ui-session`、`ui-layout`、`ui-sidebar`……跨套件靠 slot 與 Cordis service（`packages/client/AGENTS.md` 第 36 行）。
- **窄螢幕行為**：`ui-layout/src/client/columns.ts:23` `SIDEBAR_AUTO_COLLAPSE = 1024`；`AppFrame.tsx:160–168` 在 viewport 小於它時自動收起左側欄，用 `narrowExpanded` 另記「窄螢幕下手動展開」。其餘是零星的 `@media (max-width: 560px)`、`@container`、`@media (pointer: coarse)` 把觸控目標撐到 44px（`ui-deliverables/.../Deliverables.module.css:35`）。

**所以標準沒有「shadcn 元件庫」這個選項可抄。** 元件庫選型屬於 dsh 沒有的東西，但 UI **行為**仍照 dsh：1024px 斷點收側欄、觸控目標 44px、核准由獨立的核准卡表示而不是工具卡的一格狀態（這條 nexus 已在 [#317](https://github.com/DemianLi/nexus-agent/issues/317) 照做，見 `packages/nexus-wire/src/conversation.ts` `ToolEntry.status` 的註解）。

**偏離標註**（AGENTS.md「技術實現標準」）：
- **規則**：技術實現以 dsh 的實際做法為準。
- **dsh 那側**：UI 是 CSS Modules ＋ 自家 `packages/client/ui-*` 插件套件，沒有 shadcn、沒有 Tailwind，也不是能單獨拿出來用的元件庫（跨套件靠 Cordis service 與 slot）。
- **退到**：shadcn registry 元件。這是 README 既有的技術棧決定，本筆記沒有重新評估；這裡只把「dsh 沒有 shadcn」這件事第一次寫清楚。
- **仍照 dsh 的**：1024px 收側欄、觸控目標 44px、核准獨立成卡。

## 3. 候選逐一分析

### nexus 這邊的約束（讀 repo 確認過）

- `apps/web/package.json`：Vite 7、React 19.2、Tailwind v4（`@tailwindcss/vite`）、lucide；`components.json`：`style: new-york`、`baseColor: neutral`、`cssVariables: true`、`rsc: false`。
- 目前 `components/ui/` 只有 `button.tsx`；agent 介面全是自建：`transcript`、`approval-card`、`question-card`、`thread-list`、`status-line`、`feedback-dialog`。
- **目前整個 `apps/web/src` 的 `.tsx` 只有 `button.tsx` 出現斷點 class** —— RWD 等於從零開始。
- 資料形狀：`@nexus/wire` 的 `ConversationEntry = HumanEntry | AiEntry | ToolEntry | DecisionEntry | AnswerEntry`（`conversation.ts:147`）。要注意的三個形狀：
  - `ToolEntry.status` 只有 `running | suspended | done | failed` 四格，`input` 是原樣 JSON 字串；
  - `DecisionEntry` 是**一個決定套到一顆中斷的全部 `actions`，全有全無**（`conversation.ts:104–121`），不是逐顆工具呼叫各自核准；
  - `AnswerEntry` 逐題 `selected[]`＋`custom`，另有 `cancelled`（放棄整組）。
  - 另有 `Attribution`（子代理歸屬）。

### 3.1 AI Elements（Vercel）

- **形式**：shadcn registry。`npx ai-elements@latest` 或 `npx shadcn@latest add https://elements.ai-sdk.dev/api/registry/all.json`（`README.md` 第 15、18 行）。複製進專案後原始碼歸我們。
- **授權**：Apache-2.0（`LICENSE`）。
- **元件（`packages/elements/src/`）**：`conversation`、`message`、`prompt-input`、`tool`、`reasoning`、`chain-of-thought`、`confirmation`、`question`、`plan`、`task`、`queue`、`checkpoint`、`code-block`、`terminal`、`sources`、`inline-citation`、`attachments`、`context`、`model-selector`、`agent`、`artifact`、`file-tree`、`stack-trace`、`test-results` 等（另有 `canvas`／`node`／`edge` 工作流圖）。
- **框架**：元件原始碼零個 `next` import（§1）。41 個檔案有 `"use client"`，Vite 下無作用。
- **資料層耦合 —— 型別層級**：
  - `from "ai"` 全部是 `import type`（`UIMessage`、`ToolUIPart`、`ChatStatus`、`FileUIPart`……），沒有值匯入。
  - 但 **registry 會替每個元件都加上 `ai`、`@ai-sdk/react`、`zod` 相依**（`apps/docs/app/api/registry/[component]/route.ts:60–63` 註解寫「auto-add ai sdk」），加上各元件實際 import 的套件。
  - `tool.tsx` 的 `ToolHeader` 吃 `ToolUIPart["state"]`，七格：`input-streaming`、`input-available`、`approval-requested`、`approval-responded`、`output-available`、`output-error`、`output-denied`（`tool.tsx:47–54`）。nexus 的四格要映射過去：`running→input-available`、`done→output-available`、`failed→output-error`，`suspended` 沒有對應格（要自己加 label 或改用 `approval-requested` 的樣子，後者會牴觸 #317）。
  - `confirmation.tsx` 是**掛在單一工具呼叫上**（`approval: { id, approved?, reason? }` ＋ `state`），對不上 `DecisionEntry` 的整批語意，而且把核准畫成工具卡內的狀態，**與 #317 照 dsh 的「核准卡獨立」相反**。
  - `question.tsx` **不 import `ai`**：`selectionMode: "single" | "multiple"`、`onSubmit(response: { selectedValues, text? })`，是純 props，形狀接近 `AnswerEntry` 的單題（沒有「跳過」「放棄整組」）。
  - `reasoning`、`plan`、`task`、`queue`、`chain-of-thought`、`code-block` 都不 import `ai`。
- **依賴重量（逐檔 import）**：`message`、`reasoning` 帶 `streamdown` ＋ `@streamdown/{cjk,code,math,mermaid}`；`code-block` 帶 `shiki`；`conversation` 帶 `use-stick-to-bottom`；`prompt-input` 帶 `nanoid` 與 `command`／`dropdown-menu`／`hover-card`／`input-group`／`select`／`spinner`／`tooltip` 等 shadcn 元件。`motion`、`@xyflow/react`、`@rive-app/react-webgl2` 只在沒用到的元件裡。
- **RWD**：`packages/elements/src/*.tsx` 搜 `sm:|md:|lg:` **零筆**。元件以 `className` 透傳、flex 撐滿容器，不擋 RWD 也不提供 RWD。

### 3.2 assistant-ui

- **形式：兩層，要分開看。**
  - **runtime 層**：npm 套件 `@assistant-ui/react`（核心、`AssistantRuntimeProvider`、zustand store）。registry 裡的 `thread`、`thread-list`、`tool-fallback`、`reasoning`、`markdown-text` 都是 `*.aui.tsx`，`dependencies: ["@assistant-ui/react", ...]`（`apps/registry/src/registry.ts:1053–1080`、`1508–1526`）。
  - **elements 層**：`createElementRegistryItem` 產生的 `elements-*`（`registry.ts:56–68`，共 109 個 slug），例如 `approval-card`、`agent-plan`、`elicitation-form`、`task-card`、`agent-handoff`、`feedback-dialog`。多數只相依 `lucide-react`，**純 props**。
- **授權**：MIT。
- **LangGraph adapter 講的不是我們的線**：`@assistant-ui/react-langgraph@0.14.28` peer 相依 `@langchain/langgraph-sdk`（`package.json` 第 45 行）；`useLangGraphRuntime` 要一個 `stream: LangGraphStreamCallback<LangChainMessage>`（`useLangGraphRuntime.ts:343`），期待的是 LangGraph Server SDK 的事件與 `LangChainMessage`。nexus 前端收的是 `@nexus/wire` 折疊過的 `ConversationEntry`，所以**「LangGraph 一級支援」對我們不成立**，接上去等於在前端重做一次 thread-pump。
- **另一條路** `useExternalStoreRuntime`（`packages/react/src/index.ts:157`）可以把外部狀態餵給它，但仍然是它的 runtime 在管 thread／message 生命週期。nexus 的狀態擁有者已經是 `App.tsx` ＋ `@nexus/wire`，再疊一層是兩個擁有者。**未實測** adapter 的實際工作量。
- **`elements-approval-card`**：`state: "request" | "running" | "done" | "denied"`、單一 `command: string`、`onAllowOnce`／`onAlwaysAllow`／`onDeny`（`elements/approval-card.tsx:8–38`）。一張卡一個命令，同樣對不上整批 `actions`，但它是**獨立的卡**，方向與 #317 一致，可以當樣式參考。
- **RWD**：`elements/` 目錄只有少數檔案出現斷點（`thread.aui.tsx:227` 的 `md:pb-6`、`canvas-split`、`file`、`image` 等各一兩處）；側欄 `threadlist-sidebar` 相依 shadcn `sidebar`（`registry.ts:1664–1667`），行動版行為來自 shadcn。
- **樣式注意**：elements 層 import `./surfaces`（自家的 `paper`／`inkButton`／`field` 樣式常數），不是 shadcn new-york 的樣子，混用會有兩套視覺語言。

### 3.3 shadcn/ui 官方 chat 元件（2026 新出）

- **來源**：changelog [2026-06 Components for Chat Interfaces](https://ui.shadcn.com/docs/changelog/2026-06-chat-components)、[2026-08 Questionnaire](https://ui.shadcn.com/docs/changelog/2026-08-questionnaire)、[2026-07 @shadcn/helpers](https://ui.shadcn.com/docs/changelog/2026-07-helpers)、[2026-08 Human in the Loop](https://ui.shadcn.com/docs/changelog/2026-08-helpers-human-in-the-loop)（WebFetch 摘要）；原始碼 `shadcn-ui/ui@f5bb039`。
- **元件**：`message-scroller`、`message`、`bubble`、`attachment`、`marker`（`pnpm dlx shadcn@latest add message-scroller message bubble attachment marker`）；`questionnaire`（單選／多選／自由文字／跳過／上一步下一步）。
- **資料層耦合：零。** changelog 說 `MessageScroller` "owns that behavior without owning your messages, AI state, transport, persistence, or model state"。原始碼核對：`new-york-v4/ui/message.tsx` 只 import `react` 與 `cn`；`bubble.tsx` 加 `radix-ui`、`class-variance-authority`。
- **但不全是純複製原始碼**：`message-scroller.tsx` import `@shadcn/react/message-scroller`，`questionnaire.tsx` import `@shadcn/react/questionnaire`。`@shadcn/react` 是**公開的 npm 套件**（`packages/react/package.json`：`0.3.1`，沒有 `private`，peer 只有 `react >=19`），裝這兩個會多一個 runtime 相依。它是 headless 的捲動／表單行為，不管 thread 或訊息的生命週期，所以不牽涉狀態擁有權；但這兩個元件的行為邏輯在套件裡，不在複製進來的檔案裡。
- **`@shadcn/helpers`** 是 npm 套件，AI SDK `useChat` 的 transport 與 TanStack AI 的 connection，定位是開發／示範輔助，元件不需要它。對 nexus 沒用。
- **RWD**：`message`、`bubble`、`message-scroller` 斷點零筆；`questionnaire`（`bases/radix/ui/questionnaire.tsx:180,234,259,284,309`）用 `min-h-11 ... sm:min-h-0` —— **手機上觸控目標 44px、`sm` 以上才縮**，與 dsh 的 `pointer: coarse` 44px 同一個意思。
- **`sidebar`**（`new-york-v4/ui/sidebar.tsx:9,69,93`）：`useIsMobile()` 判斷後，手機走 `openMobile`（Sheet 抽屜）、桌面走可收合側欄 —— **這是整個方案裡真正提供頁面層 RWD 的元件**。
- ⚠️ `questionnaire` 在 `new-york-v4/ui/` 下**找不到**，只在 `bases/{radix,base,aria}/ui/`。nexus 的 `components.json` 是 `style: new-york`，`shadcn add questionnaire` 會不會解析到可用的版本**未核實**（`bases/radix` 版本 import 了 `@/app/(create)/components/icon-placeholder`，看起來要經 registry build 轉換）。

### 3.4 prompt-kit

- **形式**：shadcn registry，`npx shadcn@latest add prompt-kit/[component]`（`README.md:20`），產物在 `public/c/*.json`。MIT。
- **元件**：`chat-container`、`message`、`markdown`、`prompt-input`、`reasoning`、`chain-of-thought`、`steps`、`tool`、`thinking-bar`、`feedback-bar`、`system-message`、`source`、`code-block`、`file-upload`……
- **資料層耦合：零。** `components/prompt-kit/*.tsx` 沒有 `ai`／`@ai-sdk` import（repo 根 `package.json` 的 `ai@5` 是示範站用的）。外部相依只有 `use-stick-to-bottom`、`shiki`、`react-markdown`／`remark-gfm`／`marked`、`react-jsx-parser`。
- **沒有**核准、提問、計劃元件。
- **RWD**：元件內零斷點 class。`loader.tsx` 裡的 `sm:`／`md:`／`lg:` 是尺寸變體物件的鍵（`sm: "size-4"`，第 33–35、59–67 行），不是 Tailwind 斷點；其餘檔案零筆。
- **維護**：最近 commit 2026-03-12，約半年沒動。

### 3.5 LangChain agent-chat-ui

- **是一個 Next.js 應用，不是元件庫**：`next ^16.3.4`、`react ^19.3.0`、`tailwindcss ^4.3.3`、`@langchain/langgraph-sdk ^1.10.2`（`package.json`）；用 SDK 的 `useStream` 連 LangGraph Server（`src/providers/Stream.tsx`）。
- **值得抄的是 RWD 做法**：`src/components/thread/index.tsx:139` `useMediaQuery("(min-width: 1024px)")`，第 260 行歷史側欄 `hidden lg:flex`，小螢幕改成覆蓋式。斷點同樣是 1024，與 dsh 一致。
- 有 `agent-inbox/`，`types.ts` 處理 `Interrupt<HITLRequest>[]`（human-in-the-loop 的呈現，元件本身沒讀），可以當互動參考。

### 3.6 LlamaIndex chat-ui

- npm 套件 `@llamaindex/chat-ui@0.6.1`，peer `react ^18.2.0 || ^19`。相依很重：`@codemirror/*`、`@uiw/react-codemirror`、`@mdxeditor/editor`、`@llamaindex/pdf-viewer`、`highlight.js`、`katex`、`vaul`（`packages/chat-ui/package.json`）。
- 最近 commit 2025-12-16，**九個月沒動**。
- 元件覆蓋、資料層耦合、RWD 只有子代理讀過，**主代理未回核**。以相依重量與維護狀態就足以排除，沒有再追。

### 3.7 shadcn-chatbot-kit（Blazity）

- `apps/www` 是 `next 14.2.35`、`tailwindcss 3.4.6`、`ai ^4.3.16`（`apps/www/package.json`）。
- registry 元件在 `apps/www/registry/default/ui/`：`chat`、`chat-message`、`message-list`、`message-input`、`typing-indicator`、`interrupt-prompt`、`markdown-renderer`、`file-preview`、`audio-visualizer`……
- **排除理由是 Tailwind v3 與 AI SDK v4 時代**，不是 Next.js（元件本身有沒有 `next` import 沒逐檔查）。

### 3.8 沒查的

- **Kibo UI** 的 AI 元件、**CopilotKit**、**Tambo**：沒 clone、沒讀，不下結論。

## 4. 對照總表

「耦合」指要接 `@nexus/wire` 時元件本身要求什麼資料形狀。

| | 形式 | 耦合 | 工具卡 | 核准 | 提問 | 計劃／todo | 元件內斷點 | 授權 | 最近 commit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| shadcn 官方 | registry | 無 | — | — | `questionnaire`（new-york 可用性未核實） | — | `questionnaire` 有（44px 觸控）；其餘零 | MIT | 2026-09-16 |
| AI Elements | registry | 型別（`ai` 的 `ToolUIPart` 等）；`question`／`plan`／`task`／`reasoning` 無 | `tool`（七格狀態） | `confirmation`（逐顆、卡內） | `question`（單題） | `plan`、`task`、`queue` | 零 | Apache-2.0 | 2026-08-21 |
| assistant-ui runtime 層 | npm＋registry | **強**：要它的 runtime | `tool-fallback` | `tool-fallback` 內 | `tool-fallback` 內 | — | 少量 | MIT | 2026-09-16 |
| assistant-ui elements 層 | registry | 無（自家 surfaces 樣式） | — | `approval-card`（逐命令、獨立卡） | `elicitation-form`（未讀） | `agent-plan`、`task-card` | 少量 | MIT | 2026-09-16 |
| prompt-kit | registry | 無 | `tool` | — | — | `steps` | 零 | MIT | 2026-03-12 |
| agent-chat-ui | Next.js 應用 | LangGraph Server SDK | 有 | `agent-inbox` | — | — | **有**（1024 斷點） | MIT | 2026-09-14 |
| LlamaIndex chat-ui | npm | 未核實 | 未核實 | 未核實 | 未核實 | 未核實 | 未核實 | MIT | 2025-12-16 |
| shadcn-chatbot-kit | registry | 未逐檔查 | — | `interrupt-prompt`（未讀） | — | — | 未查 | MIT | 2026-02-27 |

## 5. RWD：實際上誰在做

量法：對各家元件原始碼搜 `sm:|md:|lg:`（shadcn 風格的斷點前綴）。

- **訊息層元件幾乎都不帶斷點**：AI Elements 零、prompt-kit 零、shadcn 官方 `message`／`bubble`／`message-scroller` 零、assistant-ui elements 只有少數幾處。這不是缺陷，它們的設計是「撐滿容器、`className` 透傳」，把版面交給頁面。
- **頁面層 RWD 的載體是 shadcn 官方 `sidebar`**（`useIsMobile` → 手機 Sheet）。assistant-ui 的 `threadlist-sidebar` 也是直接相依它。
- **斷點與觸控目標有兩個一致的外部參考**：
  - 1024px 收側欄 —— dsh `SIDEBAR_AUTO_COLLAPSE = 1024`、agent-chat-ui `min-width: 1024px`；
  - 44px 觸控目標 —— dsh `pointer: coarse` 44px、shadcn `questionnaire` `min-h-11 sm:min-h-0`。
- **所以不管選哪家，RWD 都是 nexus 自己的工作項**：會話列表抽屜、輸入框在小螢幕的高度與鍵盤、工具卡的 JSON／程式碼區塊橫向捲動（`overflow-x-auto`＋`min-w-0`）、核准卡按鈕在窄寬換行。選型只決定「不會擋路」。

## 6. 推薦

> **已被推翻**：見開頭「後續決議」。這一節保留當時的推論，不代表現在的做法。

### 做法：registry 分層取用，資料層不讓出去

nexus 已經擁有傳輸（`@nexus/wire`）、狀態（`App.tsx`）與事件模型（`ConversationEntry`），缺的是**呈現**。registry 複製原始碼、不帶管狀態的 runtime，裝完檔案就是我們的，跟現在 `components/` 的六個自建元件是同一種東西；它也直接落在既有的 `components.json`（new-york／neutral／lucide）。

| 層 | 取什麼 | 為什麼 |
| --- | --- | --- |
| 骨架 | shadcn 官方 `sidebar`、`sheet`、`message`、`bubble`、`attachment`、`marker`；`message-scroller` 會多裝 `@shadcn/react`（headless，見 §3.3） | 不碰資料層；`sidebar` 是唯一內建行動版行為的元件 |
| agent 件 | AI Elements `tool`、`reasoning`、`chain-of-thought`、`plan`、`task`、`queue`、`code-block`、`question` | 覆蓋最完整；除 `tool` 外都不碰 `ai` 型別 |
| 自己的 | 核准卡（整批 `actions`）、提問卡的「跳過／放棄整組」、子代理歸屬標示、回饋 | 沒有任何一家的形狀對得上；#317 規定核准獨立成卡 |

接法是在 `apps/web/src/lib/` 寫**純函式映射**（`ToolEntry → ToolHeader props` 之類），元件只收 props；不引入任何 runtime provider。

### 要先知道的代價與風險

1. **AI Elements 的 `tool` 綁 `ai` 的型別**。registry 會裝 `ai`、`@ai-sdk/react`、`zod`（只用到型別，打包不會進 bundle，但 `package.json` 會多三個相依）。替代：複製進來後把 `ToolUIPart["state"]` 換成 nexus 自己的四格 union，順手移掉相依 —— 原始碼是我們的，這樣改合法，但之後就不能無腦 `shadcn add` 更新。
2. **`confirmation` 不要用**。逐顆、卡內的核准與 `DecisionEntry` 的整批語意、#317 的獨立卡都衝突。
3. **兩家的視覺語言要統一**。AI Elements 用 shadcn 基礎元件，與 new-york 一致；assistant-ui elements 用自家 `surfaces`，不建議混進來，只當互動參考。
4. **`questionnaire` 在 new-york 風格下能不能裝，未核實**；裝不上就用 AI Elements `question` 或保留現有 `question-card.tsx`。
5. **Apache-2.0**（AI Elements）複製原始碼進 repo 要保留授權聲明。
6. **依賴**：`message`／`reasoning` 會帶進 `streamdown` 與四個外掛（含 mermaid），`code-block` 帶 `shiki`。只取需要的元件，別用 `all.json`。

### 不推薦的，以及理由

- **assistant-ui runtime 層**：搶狀態擁有權；LangGraph adapter 講 Server SDK 的串流不是我們的線（§3.2）。
- **agent-chat-ui**：Next.js 應用，不能當元件用；但 RWD 與 interrupt 的互動值得開著看。
- **LlamaIndex chat-ui**：相依重、九個月沒動。
- **shadcn-chatbot-kit**：Tailwind v3、AI SDK v4 時代。
- **prompt-kit**：零耦合是優點，但缺核准／提問／計劃，且半年沒動；AI Elements 已涵蓋它有的東西。

## 7. 未核實事項

- `shadcn add questionnaire` 在 `style: new-york` 的 `components.json` 下會不會成功、裝到的是哪個版本。
- AI Elements 元件在 Vite 7 ＋ Tailwind v4 的 nexus 裡實際 `shadcn add` 並 build —— **沒有實跑**，相容性是從 import 推的。要結案就在分支上跑一次 `shadcn add` 一個 `tool` 再 `pnpm --filter @nexus/web build`。
- `useExternalStoreRuntime` 接 `@nexus/wire` 的實際工作量（只讀了匯出位置）。
- assistant-ui `elicitation-form`、shadcn-chatbot-kit `interrupt-prompt` 的 props 形狀。
- LlamaIndex chat-ui 的元件覆蓋與耦合（只有子代理讀過）。
- shadcn changelog 各頁內容是 WebFetch 的摘要，不是逐字；原始碼核對只做了 `message`、`bubble`、`message-scroller`、`questionnaire`、`sidebar`。
- Kibo UI、CopilotKit、Tambo 沒查。
- 各家暗色模式沒逐檔查（nexus 的 `cssVariables: true` 理論上相容 shadcn 風格的元件）。
