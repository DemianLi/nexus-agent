# apps/web 的程式結構

`src/` 按功能切成切片（Vertical Slice）：一個功能的畫面、狀態、轉換邏輯與測試放在同一個資料夾。目的是幾個人同時改不同功能時不會改到同一批檔，往上加程式也不必先讀懂整個前端。詞的定義見 [`GLOSSARY.md`](GLOSSARY.md)，元件怎麼加見 [`COMPONENTS.md`](COMPONENTS.md)。

## 三層

```
src/
├── app/                 組裝層：只把切片接起來
│   ├── App.tsx
│   ├── embed/           嵌入版 <nexus-chat> 的進入點
│   └── right-sidebar/   右側欄的殼：它要認得每一個分頁
├── features/<切片>/      切片：一個功能一個資料夾
└── shared/              共用層：兩個以上切片都要用的
    ├── blocks/          積木
    ├── connection/      連線核心：會話的狀態、協定、重連
    ├── lib/             不屬於任何一個功能的純邏輯
    ├── markdown/        markdown 的渲染
    └── right-sidebar/   分頁共用的 context 與版面計算
```

下面這些也算共用層，位置不變：`components/ui/`（registry 元件）、`styles/`、`vendor/`、`test/`，以及被 vendor 檔或 `.github` 釘住路徑的 `lib/utils.ts`、`lib/portal-container.ts`、`lib/theme.ts`、`hooks/use-mobile.ts`。`main.tsx` 算組裝層。

## 切片

| 切片          | 管什麼                                 |
| ------------- | -------------------------------------- |
| `transcript`  | 對話區：訊息、工具那一段、重試、往前翻 |
| `composer`    | 輸入框與「/」「@」選單                 |
| `submit`      | 送出：鎖、草稿放回、請求編號、失敗回報 |
| `attachments` | 附件的挑選、上傳與已送出的顯示         |
| `queue`       | 排隊中的訊息與插話                     |
| `approval`    | 核准卡                                 |
| `question`    | 提問面板                               |
| `plan`        | 計劃的審閱、預覽分頁與狀態標籤         |
| `goal`        | 目標列                                 |
| `tool`        | 工具卡、工具步驟、子代理、待辦         |
| `trace`       | 觀測分頁                               |
| `cost`        | 成本分頁與用量                         |
| `changes`     | 變更卡與變更審閱分頁                   |
| `deliverable` | 交付卡與交付物預覽                     |
| `feedback`    | 回饋與評分                             |
| `seats`       | 模型、權限這類座位的選擇               |
| `threads`     | 左側欄的會話清單與會話管理             |
| `status`      | 狀態列與等待中的提示                   |

切片裡平放元件、hook、純邏輯與測試，測試跟它測的檔同名、放旁邊。切片長大了再自己加子資料夾。

## 規則

這幾條只管產品碼。測試檔與 `src/test/` 不受限，因為有些測試要整個畫面一起渲染。

1. **方向只能往下**：組裝層 → 切片 → 共用層。共用層不 import 切片或組裝層，切片不 import 組裝層。`import type` 也算。
2. **切片外面只走公開入口**：別的切片或組裝層要用切片 X 的東西，只能 `import … from '@/features/X'`，不能指到 X 裡面的檔。
3. **公開入口是 `features/X/index.ts`**：只有具名的 re-export，不放邏輯，只匯出外面實際用到的名字。切片裡的檔不 import 自己的 `index.ts`。
4. **切片之間不准循環**。A 用 B、B 又用 A 時，把兩邊都要的那一塊下沉到共用層。
5. **檔名不重複資料夾名**：`features/tool/card.tsx`，不是 `features/tool/tool-card.tsx`。去掉前綴後沒有名字可用的保留原名（`composer/composer.tsx`）。
6. **不拿整個 `Conversation`**：`features/` 與 `shared/` 的產品碼只用分組型別（`ConversationLink`、`ConversationPending` 等）、`Pick<Conversation, …>` 或 `Conversation['成員']`。整個物件只有組裝層拿。

`src/architecture.test.ts` 擋第 1 到 4 條與第 6 條，`src/styles/naming-deprecation.test.ts` 擋第 5 條。

### 例外

兩處共用層的檔還在 import 切片，登記在 `src/architecture.test.ts` 的例外清單。清單只能變短，列了卻沒命中會紅。

| 檔                                                              | 為什麼                                               | 什麼時候拿掉                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `shared/connection/use-conversation.ts`                         | 連線核心還拉著兩條錯誤文案（送出被拒、暫停目標失敗） | [#2883](https://github.com/DemianLi/nexus-agent/issues/2883) 的「下行錯誤碼轉文案收成一個 module」 |
| `shared/right-sidebar/api.ts`、`shared/right-sidebar/layout.ts` | 分頁要的資料來源集中在一個型別裡，用到各分頁的型別   | [#2883](https://github.com/DemianLi/nexus-agent/issues/2883) 的「右側欄分頁登記」                  |

## 新東西放哪

- **只有一個功能用**：放那個切片。
- **第二個切片也要用**：下沉到 `shared/`（元件放 `blocks/`，純邏輯放 `lib/`），不要從切片 A 深層 import，也不要為了它讓兩個切片互相 import。
- **新功能**：開新切片 `features/<名字>/`，加 `index.ts`，在 `app/` 接上。
- **要認得好幾個切片才寫得出來的**：那是組裝，放 `app/`。
