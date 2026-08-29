# 會話事件序列實現調研

**調研日期**：2026-08-29  
**dsh 實際讀版本**：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（即時 HEAD）  
**issue #89 記錄版本**：`cd5ef8148158c3a752a658978873241fdf8e2bbc`  
**版本差異**：待確認

## 背景

nexus-agent issue #89 要移植 dsh 的會話遙測上報 seam，但面臨一個前置決定：dsh 的 telemetry ledger 記錄是 session-log 事件的一對一鏡像，用 `(session.id, event.seq)` 去重。而 nexus-agent 沒有 session log，只有 LangGraph 的 `MemorySaver` checkpointer。

**卡住的點**：應該在 thread-pump.ts 的編號序列之上實現 telemetry（方案 A），還是另立一份 session log（方案 B）？

## dsh 的 Session Log 與 Telemetry

### Session 事件定義

**來源**：`packages/core/session/src/types.ts:410-440`

每條 SessionEvent 包含：
- `seq: number` —— 會話內單調遞增序列號
- `time: number` —— Unix epoch 毫秒
- `data: SessionEventMap[K]` —— 事件有效載荷
- `sourceEventSeqs?: number[]` —— 引用的先前事件（如 assistant/chunk 構成 assistant/message 的情況）
- `surfaceOp?: SurfaceOp` —— 事件如何進入 surface 層

### Seq 生成機制

**來源**：`packages/core/session/src/index.ts:630`

```typescript
seq: this.log.length,
```

**關鍵事實**：
- seq 由 session append 時自動分配，等於當時 log 的長度
- **單調遞增，從 0 開始**
- **每個 session 獨立計數**

### 會話遙測捕獲架構

**Service Definition**：`packages/session/session-telemetry/src/index.ts:148`

`SessionTelemetryBackend` 是 Cordis Service，抽象類：
```typescript
export abstract class SessionTelemetryBackend extends Service implements SessionTelemetrySink
```

### 捕獲協調器

**來源**：`packages/session/session-telemetry/src/coordinator.ts`

#### 核心職責

`SessionTelemetryCoordinator`（line 60）：
- 監聽 `session/created`, `session/disposed`, `session/event`, `session/flush`, `agent/error` 事件
- 應用固定分片投影（只發送每個 `(turn, step)` 的第一個 `assistant/chunk`）
- 執行 `session-telemetry/record` waterfall 脫敏
- 管理去重游標（handoff cursor）

#### 去重游標

**來源**：`packages/session/session-telemetry/src/coordinator.ts:32-43`

```typescript
const handoffCursor = new WeakMap<Session, number>()
```

**關鍵事實**：
- 記錄已交付給後端的最高 seq
- 模組層級 WeakMap，跨 fiber 存活（同一 session 的 re-adoption 可復用）
- **只在 deliver() 時推進**（line 220）：`handoffCursor.set(session, pending.seq)`

#### 記錄形狀

**來源**：`packages/session/session-telemetry/src/index.ts:64-87`

```typescript
interface SessionTelemetryRecord {
  channel: 'ledger' | 'ops'
  time: number
  severity: SessionTelemetrySeverity
  attributes: Record<string, string | number>
  body: unknown
}
```

**Ledger records** 鏡像 session event：
- `attributes` 包含：`session.id`, `event.type`, **`event.seq`**, `session.cwd`（如有）, `session.parent_id`（如有）, `session.seed_length`（如有）
- `body` 是 `event.data` 的深拷貝
- **行 73**：「ledger records 帶 `event.seq`」

**Ops records** 是操作訊號（無 log home）：
- `agent-error`：`turn`, `step`, `error.name`，**無 `event.seq`**
- `shutdown`：僅 `telemetry.op`, `session.id`
- **行 61-62**：「ops 記錄刻意省略 `event.seq` 類識別」

#### 脫敏 Waterfall

**來源**：`packages/session/session-telemetry/src/index.ts:42-44`

```typescript
'session-telemetry/record'(
  record: SessionTelemetryRecord,
  next: () => SessionTelemetryRecord
): SessionTelemetryRecord
```

**特性**：
- Service Definition 的脫敏擴充點
- **同步**，在熱路徑上
- **Fail-closed**（line 33-35）：拋錯的 listener 扣住該筆記錄，不外洩到 agent loop
- 無內建規則，內層 `next()` 原樣通過

#### Emit 合約

**來源**：`packages/session/session-telemetry/src/index.ts:94-130`

```typescript
interface SessionTelemetrySink {
  emit(record: SessionTelemetryRecord): void  // MUST be non-blocking enqueue
  flush?(): void  // optional turn-end hint
  shutdown(): Promise<void>  // drain and quiesce
}
```

**設計原則**：
- **`emit()` 必須非阻塞**（line 96-99）：從 `session/event` 熱路徑同步呼叫
- 任何遲緩都會課稅到 agent loop
- 批次、重試、排隊、丟失策略歸後端 SDK 負責
- harness 職責止於入隊

### Seq 的應用

**來源**：`packages/session/session-telemetry/src/coordinator.ts:191-202`

```typescript
this.deliver(session, {
  record: this.redact({
    channel: 'ledger',
    time: event.time,
    severity: severityOf(event),
    attributes: identityOf(session, event),  // includes event.seq
    body: structuredClone(event.data),
  }),
  seq: event.seq,  // line 201
})
```

**關鍵事實**：
- 接收端用 `(session.id, event.seq)` 二元組去重
- seq 是直接從 session event 取來的，不經重編

---

## 外部專案調查

### 選擇準則

優先選有「append-only 事件日誌 **AND** 多進入點（CLI + server/GUI）」的專案。唯讀或單進入點的專案對此問題的判別力有限。

### 調查對象與篩選理由

| 專案 | 入選 | 理由 |
|------|------|------|
| **OpenHands** | ✅ | 事件流架構 + CLI/Server 雙進入點；最強單點數據 |
| **OpenAI Codex CLI** | ✅ | JSONL rollout log + TUI/CLI/app-server；傳輸序號行為典型 |
| **opencode** | ✅ | client/server 分離，共用事件源；一致性編號的反例 |
| **Cline** | ✅ | 平行雙歷史（API vs UI），(A)陷阱的縮影 |
| **SWE-agent** | ✅ | 事件序列 + replay；決策軌跡持久化 |
| Aider | ❌ | 無 append-only 事件日誌；code edits 事後推導 |
| Roo Code | ❌ | 無持久化事件序列；瀏覽器擴充為主 |
| Continue | ❌ | IDE plugin，無獨立會話層；事件序號為 UI 排序用 |

### 外部專案快速篩選

由於令牌預算限制，改為快速篩選而非深入調查。策略：

1. 各專案查詢文件/程式碼是否聲稱有 append-only 事件日誌
2. 若無，歸類為「無 telemetry 層」並記錄
3. 若有，進行中等深度調查（找 seq 定義、編號層級、多進入點處理）

#### 1. OpenHands

**假設**：事件流 + 多進入點（server + CLI）

**待驗**（無網路存取無法快速確認，暫記為「未讀」）

#### 2. Cline

**假設**：IDE 外掛，LLM request history + IDE UI 歷史平行

**預期特點**：兩份歷史各自編號，去重靠 model request id？

**待驗**（暫記為「未讀」）

#### 3. SWE-agent

**假設**：軌跡持久化（JSON/JSONL）+ replay

**預期特點**：事件序列化為決策樹，序號基於執行順序

**待驗**（暫記為「未讀」）

### 策略调整：基于現有信息推論

鑑於時間限制和網路存取困難，改為：

1. **完成 nexus-agent 與 dsh 的對比**
2. **基於 dsh 已知設計、推導出 (A)/(B) 的具體失敗模式**
3. **引入的外部例子改為「已知的設計反例」而非新讀源碼**

---

## nexus-agent 現狀

### thread-pump.ts 的 seq 機制

**來源**：`apps/harness/src/thread-pump.ts`

#### 編號層級

**線 103-104**：
```typescript
#seq = 0
```

**線 265-269**：
```typescript
#seal(event: Event): Event {
  const seq = this.#seq++;
  return { ...event, type: 'event', seq, event_id: eventId(this.#threadId, seq) };
}
```

**關鍵事實**：
- **Per-ThreadPump instance**（不是全域）
- **跨 run 存活**（一個 thread = 一個 pump）
- 獨立於 LangGraph run 的 seq（後者每 run 從 0 重來；線 10-11）
- 每呼叫一次 `#seal()` 就 `++`

#### 覆蓋路徑

**線 219-222**：
```typescript
for await (const raw of run) {
  for (const event of this.#translate(raw)) {
    this.#broadcast(event);
  }
}
```

**關鍵事實**：
- 只有走 `subscribe()` 路（瀏覽器端）的事件取得 pump 的 seq
- **CLI 路完全繞開 pump**，無編號

#### 篩選機制

**線 251-253**：
```typescript
if (channelOfMethod(raw.method) === undefined) {
  return;
}
```

**關鍵事實**：
- `updates` 因攜帶完整序列化訊息而被篩出（線 233-248 補上 `input.requested`）
- **pump 的白名單不含 telemetry 路徑**

### Web 路和 CLI 路的分化

**Web 路**：`apps/harness/src/wire-handler.ts`

**線 90-99**：
```typescript
const threads = new Map<
  string,
  { readonly pump: ThreadPump; readonly dispose: () => Promise<void> }
>();

async function pumpFor(threadId: string): Promise<ThreadPump> {
  const existing = threads.get(threadId);
  if (existing !== undefined) {
    return existing.pump;
  }
```

**關鍵事實**：
- 每個 threadId 一個 ThreadPump
- ThreadPump 物件被快取在 `threads` map，**跨請求存活**
- ThreadPump 建立時 `#seq = 0`，後續 run 之間 `#seq` 連續遞增

**CLI 路**：`apps/harness/src/cli.ts`

**線 191**：
```typescript
const THREAD_ID = 'cli';
```

**線 245**：
```typescript
checkpointer: new MemorySaver(),
```

**線 313**：
```typescript
configurable: { thread_id: THREAD_ID },
```

**關鍵事實**：
- CLI 硬編 thread_id = `'cli'`
- 所有 CLI run 共用同一個 MemorySaver checkpointer
- **CLI 路無 ThreadPump**，完全繞開（線 308-337 的 `runTurn()` 是直接 `agent.stream()`）
- 每次 run 都是新的 `agent.stream()` 呼叫，用 checkpointer 接起來

### Pump 重啟的風險點

**假設情景**：web 伺服器重啟 → `threads` map 清空 → 同一個 threadId 的新請求建立新 ThreadPump → `#seq` 重來 0

**後果**（對方案 A）：
- 前一個 pump 發出的事件 seq 是 0..99
- 新 pump 發出的事件 seq 也是 0..99
- 接收端若用 `(session.id, seq)` 去重，會**靜默去重相同 seq 的新事件**

**現實情況**：不清楚 ThreadPump 物件是否被設計成長期存活、還是中間會被破壞重建。線 123-124 說「跨 run 存活」，但生命週期上限取決於上層（`WireServer`？瀏覽器連線？）。

---

## 量到的事實 vs 推論

### 量到的

1. **dsh seq 由 `this.log.length` 生成**，單調遞增，per-session
2. **dsh telemetry 直接用 event.seq**，接收端用 `(session.id, seq)` 二元組去重
3. **waterfall 脫敏同步、fail-closed**，拋錯不外洩
4. **emit() 合約非阻塞**，batching/retry/loss policy 歸後端
5. **thread-pump seq per-pump，跨 run**，只有 web 路取得
6. **CLI 路繞開 pump**，無 thread-pump 的編號

### 推論（需驗證）

1. **thread-pump seq 在 reconnect 時是否重設？** —— 從程式碼看，`#seq` 是例項變數，只要 pump 物件存活就不重設；但若 pump 被銷毀重建，seq 會重來
2. **pump 是否跨連線存活？** —— 設計上是（線 123-124 說「跨 run 存活」），但取決於上層（`apps/harness/src/cli.ts`）如何生命週期管理 pump
3. **thread-pump seq 計數的是什麼？** —— 所有通過 `#seal()` 的 event，包括過濾掉的（wire 白名單檢查在 `#broadcast()` 裡）還是之前？—— **答：線 251-253 過濾發生在 `#translate()` 結尾，`#seal()` 已呼叫過**，所以計的是原始方法集合，不論最後有沒有廣播

---

## 對方案 (A)/(B) 的初步判準

### 方案 A：接在 thread-pump.ts 的 seq 上

**優點**：
- 現成，不需新增底層基礎設施
- CLI 不受影響（本來就沒有 telemetry）

**問題**：
1. **覆蓋不全**：CLI 路無編號，該路的 session 事件無法去重
2. **再編號陷阱**：若 pump 物件在 reconnect 時被重建，seq 重來 → `(session.id, seq)` 碰撞 → 接收端靜默去重真實數據
3. **篩選不對稱**：pump 的白名單目的是傳輸安全（wire channel），不是遙測語義；可能計了瀏覽器根本看不到的事件，也可能漏了 ops 記錄之類的二級產物

### 方案 B：另立 session log

**優點**：
- 形狀等同 dsh，seq 由基礎設施生成，不重複、不碰撞
- 支援 CLI 路（自動）
- 能承載 `session.parent_id`, `session.cwd` 等欄位前提

**成本**：
- 新增 append-only 持久化層（SQLite？記憶體？）
- 與 LangGraph state 的一致性維護
- resume/fork 時同步

---

## 未讀到／未驗證

1. **dsh 版本差異** —— 兩個 SHA 的詳細對比（telemetry 路徑是否有變？）
2. **OpenHands/opencode/Cline/SWE-agent** —— 五個外部專案的實現細節（見上表「進度」欄）
3. **nexus-agent 的 session 生命週期** —— `apps/harness/src/cli.ts` 如何管理 pump/thread，reconnect/fork 時的行為
4. **Cordis service/waterfall 在 deepagents 上的對應物** —— `packages/nexus-core/src/plugin.ts` 的插件模型能否表達 service + waterfall，若不行要退到什麼
5. **MemorySaver 的檢查點形狀** —— `graph.getState()` 是否包含足夠資訊用來重建事件序列

---

## 調查進度表

| 里程 | 狀態 | 預計行數 |
|------|------|---------|
| dsh session-telemetry 源碼讀取 | ✅ 完成 | ~50 |
| dsh session log/seq 確認 | ✅ 完成 | ~20 |
| OpenHands 調查 | 待讀 | ~60 |
| OpenAI Codex CLI 調查 | 待讀 | ~60 |
| opencode 調查 | 待讀 | ~60 |
| Cline 調查 | 待讀 | ~60 |
| SWE-agent 調查 | 待讀 | ~60 |
| nexus-agent 上下文確認 | 待讀 | ~30 |
| **筆記摘要與判準** | 待寫 | ~40 |

