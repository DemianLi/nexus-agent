# 會話投影通道設計（#1026）

地圖 [#1015](https://github.com/DemianLi/nexus-agent/issues/1015) 的卡 [#1026](https://github.com/DemianLi/nexus-agent/issues/1026)。
前置：#679 第 4 步（詞彙開放，PR #1061、#1063）已合。標準是 dsh `5badb15` 的 `sessionProjections`＋`wire.view`；
下面「照 dsh」都指那個 SHA。

## 一句話

插件註冊一個**投影單元**（`key`、`stateVersion`、`init`、`apply`、`view`）；pump 的即時與歷史兩條路用**同一個折疊器**把 root 日誌折進每個單元，
把每個單元的 `view` 當成**整份值**經同一種 `custom` frame（名字 `projection`）送出；wire 端只有**一個**泛用槽
`ConversationState.projections[key]` 承接，新增一個投影不必動 `thread-pump.ts` 與 `conversation.ts` 的逐種分支。

## 為什麼不是現在的做法

今天每一種資料都要動三處寫死：pump 的 `#noteLogEvent` 一段 if/else、歷史路由 `conversation-history.ts` 的另一段、
wire 的 `CUSTOM_REDUCERS` 窮舉。觀測與成本（#1015 的其餘卡）每種資料都走這三處，違反「萬物皆可插件」。
`nexus-core/src/sessions.ts:36-38` 早就自承缺的後半就是這條通道。

## 介面

### core（`@nexus/core`）

```ts
interface ProjectionUnit<S, V> {
  readonly key: string; // 註冊表內唯一；小寫字母、數字、'-'，首字須為字母
  readonly stateVersion: number; // 非負整數，見「stateVersion」
  init(): S; // 純 JSON
  apply(state: S, event: SessionEvent): S; // 同步、純；不相干的事件回同一個參照
  view(state: S): V; // 純 JSON，給 web 的那一份（可以比 state 窄）
}
```

- 新的註冊點 `PluginRegistry.projections`（欄位數 17 → 18，正交通道 8 → 9）：`register(unit): () => void`、`list(): readonly ProjectionUnit[]`。
  形狀照 `commands`：`key` 重複在註冊時拋，undo 冪等。
- `createProjectionFold(units)`：**唯一**的折疊實作。
  - `fold(events)` → 歷史用：從 `init` 折完整串，回每個單元的 `{ key, version, view }`（照註冊順序）。
  - `session(seedEvents)` → 即時用：**先把已經在日誌裡的事件折進來、不發任何變更**（resume 一條舊 thread、或 server 重啟後 pump 才接上），
    回一個有狀態的折疊器，`push(event)` 回「這顆事件讓哪些單元的 view 變了」。照 pump 現有 `SessionTotals.seed`／`RootGoal.seed` 的時機
    （訂閱前同一個同步段）。dsh 同理：第一次碰單元時從完整的記憶體內日誌懶建（`buildCell`，`session-projection/src/index.ts:615-630`）。
  - 即時與歷史都經過同一個 `step`（`apply`＋圍堵＋變更判定），測試釘住「同一串事件，逐顆 push 與一次 fold 的最終 view 相同」。
- **變更判定**：`apply` 回同一個參照就零下游工作（照 dsh 的 `Object.is` 閘）；參照變了才算 `view`，`view` 結果與上次不同才算變更。
- **圍堵**（卡的第 5 條）：單元的 `apply`／`view` 拋錯 → 該單元在這份折疊器裡**停用**，不再折，記一次 warn，
  其他單元與產品路徑不受影響。**停用的單元不凍在最後一個好 view**（那會把過期的值當現值顯示，是靜靜錯），
  而是讓 `fold`／`push` 對它回一筆 `{ key, version, view: null, failed: true }`：即時與歷史走同一個 step，所以兩邊都長出同一格「失敗」，
  web 看到 `failed` 就藏起該面板。dsh 的註冊表本身沒有這層（拋錯只被事件派發層接住，之後同單元一直重拋、該會話的 snapshot 一直拋）；
  我們多這一層，是卡明寫的驗收；表達失敗的方式不同，記在偏離表。

### wire（`@nexus/wire`）

- 新的 `custom` frame 名字 `projection`，酬載 `{ key: string; version: number; view: unknown; failed?: true }`，**整份取代**，不是 diff（照 dsh：
  `{type:'projection', sessionId, key, value, seq}`，一種 frame、key 放酬載裡）。
- `ConversationState.projections: Readonly<Record<string, { version: number; view: unknown; failed?: true }>>`，一個 reducer、一格，
  之後所有插件投影共用。
- **對 #1018 Q1 A 的讀法**：卡文是「每種投影一個有名字的 `custom` frame，由插件宣告；pump 與 wire 走泛用的槽，不逐種寫分支」。
  我們讀成「每種投影有自己的 `key`（名字，逐種審），共用同一種 frame 與同一個槽」，因為「泛用的槽」＋「不必改 `conversation.ts` 逐種分支」
  的驗收只有這樣才成立（名字放進 `CUSTOM_REDUCERS` 的鍵就是逐種分支）。這是讀法，PR 內文要寫明，demian 不同意可改成
  `projection:<key>` 前綴名字、reducer 按前綴分派，改動只在 wire 一處。

### harness

- 組裝時把 `registry.projections.list()` 交給 pump 與歷史路由。
- **即時**：`#noteLogEvent` 對 root 日誌的每顆事件做一次 `projectionSession.push(event)`，每個變更的單元送一顆 `projection` frame。
  這是**一個**泛用呼叫，不是每種投影一個分支。pump 接上日誌時先 `session(entry.log.events)` seed（不送），與 `#totals`／`#goal` 同一個同步段。
- **歷史（= baseline）**：`historyPage` 的**最新一頁**（`end === window.length`，同 title／plan／goal）對**每個註冊的單元**送一顆 `projection` frame
  （包括 view 沒變過的、包括空日誌），所以重新整理後長出的狀態與即時一致，而且「有這個單元」本身就被表達出來
  （dsh 用 baseline 的鍵集合當 active key set）。即時**不**在 subscribe 時補 baseline：現有 totals／goal／title 全都是「值由歷史的最後一頁送，
  即時只送之後的變化」，投影照同一個分工；新開 thread 的 key 集合來自它的空歷史頁。測試要釘「空日誌的歷史頁每個單元都有 frame」。
- **單元清單從哪來**：`historyPage` 由 `wire-handler.ts` 呼叫、不經過 pump，所以清單要走 wire-handler 的選項（跟 `toolText` 一樣由組裝點傳入），
  不能只綁在某個 pump 上，否則冷 thread（server 重啟後第一次打開、還沒有 pump）的歷史沒有單元清單。PR3 開工前先追組裝點確認。
- 預設只折 **root** 日誌，同現有的 todos／goal／plan 等。**單元可以宣告 `children: true`**
  （[#1028](https://github.com/DemianLi/nexus-agent/issues/1028)）：這樣的單元也對每個子代理自己的日誌各折一份，
  值帶 `session`（子代理的 `runId`）送出，web 收進 `subagentProjections[runId][key]`。形狀照 dsh（投影格子按 session 分、
  一份日誌一份折疊，單元的 `apply` 不必知道在折誰）。子日誌的集合只有 pump 一份（`projectionChildren()`，活著的取記憶體、
  上一個行程留下的啟動時讀進來），即時與歷史讀同一份；細節見 `apps/harness/src/projection-children.ts`。
  沒有宣告 `children` 的單元一顆子代理事件都收不到。軌跡（#1070）與用量（#1028）都宣告了；軌跡連同它的請求快照一起展開，
  因為子代理的呼叫指的是它自己日誌的快照 `seq`。
- **輪中的 frame 合併**（[#1071](https://github.com/DemianLi/nexus-agent/issues/1071)）：整份取代讓下行量 ≈ 事件數 × view 大小，
  所以輪中同一個單元連續的變更合成一顆——單元第一次變更開一個 100 毫秒的視窗，視窗到了送**那一刻最新的**整份值，視窗內再變的
  只換掉待送的那份。照 dsh job-controller 的觀察串流（`streamJobRows`：等 wake、睡 `observeFlushMs`、醒來才讀現況）。
  **最後一顆一定是最終值**：root 的 `turn/end` 當場送掉所有待送的，收線丟掉（下行已無人聽）；root 輪外的變更（命令、接上時的
  baseline）不合併、當場送；子代理的投影一律走視窗。實作與理由見 `apps/harness/src/projection-coalescer.ts`。
- `disabled: true` 關掉插件 → 註冊表裡沒有那個單元 → 歷史與即時都不送 → web 的 `projections` 沒有那個 key。
  dsh 同樣**不推移除 frame**（mandatory-seam note 第 29 行：註冊表增減不跨串流廣播），靠下一份 baseline 反映。
- 圖自己發的 `custom` frame **照舊一律丟**（`thread-pump.ts` 的 `raw.method === 'custom'` 那條）。`projection` 只能由 pump 從日誌折出來，
  安全邊界不退。

## stateVersion 語意

dsh 的 `stateVersion` 是**持久化快取的失效版本**：序列化欄位或折疊語意變了就手動升，讓舊快取列被丟掉
（`session-projection/src/index.ts:86-92`、註冊時檢查非負整數 `:270-272`、同 key 不同版本第二次註冊拋 `:279-281`）。

我們**沒有**投影快取（歷史路由每次從日誌折），所以失效這個用途沒有消費者。定義如下，並用測試釘住：

1. `stateVersion` 是單元宣告的「折疊語意＋view 形狀」版本，非負整數，註冊時驗（不合格拋，帶 origin）。
2. 同一個 `key` 只能有一個單元（沒有 dsh 的 HMR 共用 refs：我們一次組裝一張註冊表、不熱換）。
3. 每顆 `projection` frame 帶 `version`，wire 端存下來：web 端的渲染器按 `(key, version)` 選，不認得的版本不渲染——
   折疊語意改了就升，讓舊 web 不會把新形狀當舊形狀讀。
4. 之後若加投影快取，`version` 就是它的失效鍵；今天沒有，**這是偏離 dsh 的一格，原因是我們沒有快取載體**（AGENTS.md「退到最接近的實作」，PR 內文標註）。

## 對 dsh 的偏離與差距（PR 內文要逐條寫）

| 項目 | dsh | 我們 | 類別 |
| --- | --- | --- | --- |
| 持久化快取、冷讀 hydrate | 有 | 沒有，歷史每次從日誌折 | 載體不存在 |
| `stateSchema`／`viewSchema` 驗證 | 有 | 沒有；`view` 只要求純 JSON，形狀由 web 渲染器自己驗 | 本次不做 |
| 獨立 host 全域 control 串流與 baseline／逐 key frame | 有 | 一條 `custom` channel；歷史補 baseline、即時送增量 | 載體不同 |
| 按 key 定址、帶 seq 的 client store | 有（seq 高者贏） | `projections[key]` 整份取代；frame 層已有單一 `lastSeq` 去重 | 載體不同 |
| 子代理自己的投影 | 有（每個 session 一份格子） | 有，單元宣告 `children: true` 才折；值落在 `subagentProjections[runId][key]` | 載體不同 |
| 單元拋錯 | 只在事件派發層圍堵；之後同單元一直重拋、snapshot 一直拋 | 逐單元圍堵，該 key 送 `failed: true`，不影響別的單元 | 卡的驗收，比 dsh 多一層 |
| 同 key 多方註冊（refs） | 有 | 重複即拋 | 沒有 HMR |
| 細節按需拉（#1083） | 投影只推有界的整份值；細節是增量事件加 seq 錨點分頁（`loadThrough(seq)`），客戶端自己折 | 單元的選填 `detail(events, query)`：伺服端從日誌重新折，host 以 `GET /threads/:id/trajectory/turn` 暴露 | 客戶端沒有折疊器，表達不出「客戶端折」，退到最接近的：同一個 `apply` 重放日誌 |

## 現有 16 種 `custom` frame 不動

`todos`、`goal`、`plan-mode`、`token-usage`…… 這十幾格是第一代的寫死做法，本卡**不遷移**。
`tokenUsageUnit` 等已經是同形狀的單元（`token-usage.ts`），之後要遷移是機械活，另開卡；本卡只提供通道並用一個測試用的玩具插件證明它端到端成立。

## PR 切法

1. **core**：`ProjectionUnit`、`projections` 註冊點、`createProjectionFold`、通道數絆索改寫（#195 的 `registry-channel-count.test.ts`，翻面：數字與散文一起改）。附本設計文件。
2. **wire**：`projection` frame 名字＋酬載型別＋`ConversationState.projections`＋reducer。與 core 互不依賴，可平行。
3. **harness**：pump 即時、歷史路由、組裝接線；玩具插件端到端驗收（即時與歷史同一份、`disabled` 全消失、圖發的 `custom` 仍被丟）。
   此外 `SESSION_LOG_FORMAT_VERSION` **不升**：沒有新日誌事件種類，日誌位元組不變。

## 驗收對照

| 卡上驗收 | 由誰釘 |
| --- | --- |
| 玩具插件端到端，即時與歷史長出同一份，且不為它改 `thread-pump.ts`／`conversation.ts` 的逐種分支 | PR3 的 e2e；PR3 的 diff 裡 `#noteLogEvent` 與 `CUSTOM_REDUCERS` 不能多出以該 key 命名的分支（e2e 用一個不在任何現有表上的 key） |
| `disabled: true` → 投影整個消失，產品路徑行為不變 | PR3 |
| `stateVersion` 語意有定義有測試 | PR1（註冊驗證）、PR2（frame 帶 version）、PR3（歷史與即時同 version） |
| 圖發的 `custom` 仍被丟 | PR3（對照組：圖發一顆名字叫 `projection` 的 custom，web 狀態不變） |
| 通道數測試已刻意改寫 | PR1 |
