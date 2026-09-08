# 核准扇出調研：標準的形狀與基座表達得出什麼

2026-09-08。為了替「同一輪多顆核准中斷時卡片只顯示最後一顆」這個缺陷選修法而做。
**結論：取 (丙) 一顆中斷一張卡**，依據是 §三 的偏離判定。

**這份只放一手證據。** 缺陷本身、射程、與重開條件由
[`plugin-architecture-gap-survey.md`](plugin-architecture-gap-survey.md) §五第 7 條那一列持有
（「**「同一輪有兩顆中斷」不算**，那個 2026-09-08 就量到了，而它不會讓折疊器看到 n>1」），
不在這裡重述。

三條候選修法，全文沿用這組代號：

- **(甲) 閘門改整批問** — `approval.ts` 把同一輪的 gated 呼叫攢起來一次 `interrupt()`。
- **(乙) pump 併成一顆 frame** — 中斷仍逐顆生，`thread-pump.ts` 合併後只發一顆 `input.requested`。
- **(丙) 一顆中斷一張卡** — 折疊器同時持有多顆 pending，每顆仍恆長度 1。

---

## 一、dsh 那側的形狀

`references/deepseek-harness` @ `d347e703908d0406b7a7ef80e3a0e594d86b2215`（2026-09-04）。
**這份 clone 落後遠端**（`git ls-remote origin HEAD` → `c389f96b`），下面引的路徑沒有跟遠端逐一對過，
要以此為據前先照 `dsh-clone-goes-stale` 的做法同步後 diff 這幾個路徑。

### 1.1 攔截點：pre-execute waterfall，逐顆工具

`packages/core/tools/src/index.ts:1466-1472`：

```ts
const gate = await this.ctx.waterfall(
  carrier, 'tools/pre-execute', exec,
  () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
)
const askResolution: ToolAskResolution = gate.kind === 'ask'
  ? await this.serviceAsk(exec, gate)
```

`:1697-1703` 在單顆工具呼叫的執行路徑內各自呼叫 `approval.request({ agent, toolName, callId, … })`。

**我們的 `packages/nexus-core/src/approval.ts` 今天已經是這個形狀**（`wrapToolCall` 上的
pre-execute waterfall、逐次呼叫各自 `interrupt()`）。缺陷不在閘門那一層。

### 1.2 一個 request 一個 id 一個決定

`packages/interaction/user-approval/src/types.ts:13-26`：

> Pairs one `approval/asked` audit event with its `approval/decided`.
> Service-issued (one fresh id per `ApprovalService.request` call).

`src/index.ts:216-224` 每次呼叫 `randomUUID()` 生一個新 id，配一對審計事件。
`docs/subsystems/approval.zh.md` 寫「第一個應答占據唯一的決策槽位」。

### 1.3 **有多顆並存的載體，但形狀是索引不是批次**

這一條推翻了「dsh 沒有待核准載體」的說法。
`packages/extensions/cordis-host-runner/src/registry.ts:143`：

```ts
/** Registry, identity mints, and pending approval index. */
export class DynamicCordisRegistry {
  private readonly pendingRequests = new Map<ApprovalRequestId, DynamicCordisPendingRequest>()
```

介面是 `armRequest(id, pending)`／`peekRequest(id)`／`claimRequest(id)`（JSDoc：
「Claim one pending approval; **first answer wins**」）／`disarmRequest(id)`。

**多顆可以同時待決，各自用自己的 id 被認領，一顆一個決定。**
沒有任何地方是「一個決定套到一批上」——`grep -rniE "batchApproval|approvalQueue"` 空手而回。

（這支在 `cordis-host-runner`，不是核心核准服務。照 `standard-may-hold-two-policies`，
它證明的是「dsh 需要同時持有多顆待決時長這樣」，不是整份 dsh 只有這一條政策。）

### 1.4 呈現：一顆待決一次提問

`packages/acp/acp/src/index.ts:155-173` 的 `approval/request` 應答者，每次送一個
`RequestPermissionRequest`，帶**一個** `toolCall: { toolCallId: callId }`，收回**一個** `outcome`。

---

## 二、基座那側（實讀原始碼，不是型別檔）

`@langchain/langgraph@1.4.12`。以下兩節推翻了「基座沒有 interrupt 索引」「一次 resume 只能解一顆」
這兩個推論。

### 2.1 同一個 task 內多次 `interrupt()`：有索引

`dist/interrupt.js`（原始碼取自 sourcemap 的 `sourcesContent`，`src/interrupt.ts`）：

```ts
// Track interrupt index
const scratchpad: PregelScratchpad = conf[CONFIG_KEY_SCRATCHPAD];
scratchpad.interruptCounter += 1;
const idx = scratchpad.interruptCounter;

// Find previous resume values
if (scratchpad.resume.length > 0 && idx < scratchpad.resume.length) {
  conf[CONFIG_KEY_SEND]?.([[RESUME, scratchpad.resume] as PendingWrite]);
  return scratchpad.resume[idx] as R;
}
```

`dist/pregel/algo.js:761-770` 的 `_scratchpad()` 初始化為 `interruptCounter: -1`，
`resume` 是一個**陣列**。函式 JSDoc 明說：

> Multiple interrupts can be called within a single node, and each will be handled sequentially.

### 2.2 **一次 resume 可以逐 id 派給多顆待決的 interrupt**

這是本次調研最關鍵的一條，也是子代理答錯的那一條。

`interrupt()` 拋出的是 `new GraphInterrupt([{ id, value }])`，其中
`const id = ns ? XXH3(ns.join(CHECKPOINT_NAMESPACE_SEPARATOR)) : undefined`。
`dist/hash.js:251` 的 `hexDigest` 是 `padStart(32, "0")`，所以 id 是 **32 個十六進位字元**，
而 `isXXH3 = /^[0-9a-f]{32}$/`（`dist/hash.js:258`）。

`dist/pregel/io.js` 的 `mapCommand()`：

```ts
if (cmd.resume) if (typeof cmd.resume === "object" && Object.keys(cmd.resume).length
    && Object.keys(cmd.resume).every(isXXH3)) for (const [tid, resume] of Object.entries(cmd.resume)) {
  … yield [tid, RESUME, existing];
}
else yield [NULL_TASK_ID, RESUME, cmd.resume];
```

`dist/pregel/loop.js:652-656` 同一個條件下把它存成 `CONFIG_KEY_RESUME_MAP`，
`algo.js:766-769` 在建 scratchpad 時 `if (resumeMap != null && namespaceHash in resumeMap)
result.push(resumeMap[namespaceHash])`。

**結論：`new Command({ resume: { [interruptId]: 決定, … } })` 是基座原生支援的**——
鍵全是 32-hex 時走逐 id 派送，否則走 `NULL_TASK_ID`。

### 2.3 今天的缺陷機制，這裡順便解釋清楚了

我們今天送的是 `new Command({ resume: input.response })`（`apps/harness/src/thread-pump.ts:349`），
而 `input.response` 的鍵是 `decisions`，**不是 32-hex**，所以走 `NULL_TASK_ID` 那一支：
同一顆值被寫進 `nullResume`，**每一個待決 task 各自的 scratchpad 都讀得到它**
（`algo.js:762` 那個 `writeTaskId === "000…0"` 的 find）。

這正是 #227／#228 量到的「每次呼叫各自去讀同一個 resume 物件的 `decisions[0]`」，
現在有機制解釋了：不是巧合，是 `NULL_TASK_ID` 廣播。

`apps/harness/src/thread-pump.ts:383-384` 的 `entry.id` 就是上面那顆 `XXH3(ns)`
（會話日誌裡的 `interrupt/raised {"interruptId":"cdb052574493c1100d8180a7176206db"}` 是 32 hex，對得上）。
**也就是說：派送要用的鑰匙，我們早就一路傳到線上了。**

### 2.4 實跑：resume map 真的逐 id 派送（2026-09-08）

§2.2 是讀原始碼讀出來的，所以另外跑了一條探針（`interrupt.test.ts` 那套間諜工具＋
`ScriptedChatModel`，一輪叫兩個工具、兩個都 gated）。**印出的值，不只是斷言**：

```
【中斷清單】 [ { "id": "bd0f5963fd655f21563637086f4caf7c", "tool": "ok_tool" },
              { "id": "7d483ec329a0ebaeb2c726ec58f4eba4", "tool": "bad_tool" } ]
【只答這一顆】 bd0f5963fd655f21563637086f4caf7c → ok_tool   32-hex? true
【答完之後】跑過的 = ["ok_tool"]
            還剩的中斷 = [{"id":"7d483ec329a0ebaeb2c726ec58f4eba4","tool":"bad_tool"}]
```

**只答第一顆 → 只有第一顆的工具跑掉，第二顆帶著原本那顆 id 再度中斷。**

對照組已經在樹上綠著：`interrupt.test.ts:227` 那條用裸 `resume`（鍵是 `decisions`，非 32-hex），
同樣兩顆中斷，結果是 `ran === ['ok_tool', 'bad_tool']`——**兩顆都被同一個決定套到**。
兩條唯一的差別就是 resume 的鍵長什麼樣。這就是 §2.3 那個 `NULL_TASK_ID` 廣播的直接證據，
也是 (丙) 那條必要條件的直接證據。

探針本身沒有進版控（它問的是基座的行為，不是我們的驗收句）。真要留的話它屬於
`interrupt.test.ts` 檔頭寫的「基座絆索」那一類。

---

## 三、AGENTS.md 的偏離判定

規則：一律照 dsh 的實際做法，**只有當現有基礎建設表達不出來時**才退，且要標註哪一條、為什麼、退到什麼。

| | dsh 的實際做法 | 基座表達得出來嗎 |
| --- | --- | --- |
| 攔截點 | 逐顆工具的 pre-execute waterfall（§1.1） | ✅ 我們已經是 |
| 多顆並存 | `Map<ApprovalRequestId, pending>`，逐 id 認領（§1.3） | ✅ 折疊器改成逐 id 持有 |
| 決定粒度 | 一個 request 一個決定（§1.2、§1.4） | ✅ `actionRequests` 恆長度 1，今天就是 |
| 一次答多顆 | 逐 id 認領，first answer wins | ✅ resume map，原生且**已實跑**（§2.2、§2.4） |

**(丙) 就是 dsh 的形狀，而且基座四格全部表達得出來。**
所以 (甲)(乙) 沒有可用的偏離條款——它們偏離的不是「表達不出來」，是「我們想換個形狀」。

**2026-09-08 定案：取 (丙)。** 落地的範圍寫在那張卡上，不在這裡。

補一句 (丙) 的必要條件，它正好是 §2.2 那條發現：
**逐張卡回答時上行必須走 resume map**（`{ [interrupt_id]: 決定 }`），
不能沿用今天的裸 resume——否則答第一張卡的那顆值會經 `NULL_TASK_ID` 廣播給第二顆待決的中斷，
就是今天這個缺陷換一個穿法。而 `packages/nexus-wire/src/client.ts:88` 的 `inputRespond`
**簽名裡已經有 `interrupt_id`**，協定形狀不用新開。

---

## 四、(丙) 之下，那些 n>1 邏輯怎麼算

`plugin-architecture-gap-survey.md` §五第 7 條那一列的重開條件 (1) 是
「一顆 `input.requested` 的 `actionRequests` 長度 > 1」。**(丙) 不觸發它**：每顆 frame 仍恆長度 1。

所以那一列**維持現狀**——既不重開，也不因此該刪。那一列自己寫著不排的理由是
「刪掉會一起賠掉『基座改主意時會紅』」，(丙) 沒有改變這個算式。

- `intersectDecisions()`（`conversation.ts:458`）：(丙) 下每顆 pending 只有一筆 config，
  交集退化成恆等。**留著**，理由同上。
- `uniformDecisions()` 的 `pending.actions.map()`（`conversation.ts:186`）：同上，恆產出長度 1。
- `approval-card.tsx:51-55` 那句 rendered 警告：`pending.actions.length > 1` 分支在 (丙) 下
  **依然到不了**。這句話是 3b 裡唯一一處**使用者看得到**的過期宣稱。
  **三條修法沒有一條救得回它**：(甲) 會讓那個分支真的顯示出來，但句子的**內容**
  （「被核准的那幾筆也不會執行，而且不會留下任何痕跡」）在 #112 之後不論怎麼問都是假的——
  那個批次抹除語義已經不存在了。(甲) 讓它從「到不了的假話」變成「看得到的假話」，
  是更糟不是更好。無論選哪條，這句都得重寫或刪掉。

---

## 五、沒查清楚的

1. **dsh clone 落後遠端**（§1 開頭），引到的四個路徑沒有跟 `c389f96b` diff 過。
2. **`hitl-wire.test.ts` 那三條基座絆索在 (丙) 下會不會紅**，我只有推論沒有跑：
   它自己用 `createDeepAgent({ interruptOn })` 繞過我們的閘門，理當不受折疊層改動影響——
   但那是「理當」，不是量到的。
3. **`mapCommand` 用 `tid` 當 pending write 的鍵，`_scratchpad` 用 `namespaceHash` 查 `resumeMap`。**
   §2.4 證明了整條路走得通，但沒有分辨是哪一支讓它走通的。要改 `thread-pump` 時如果行為
   跟預期不符，這是第一個該拆開看的地方。

---

## 附：兩份子代理報告的錯處

留檔以免下次再信同一句。兩份原文在 scratchpad
（`research-dsh-approval-fanout.md`、`research-tree-nplus1-and-3b.md`）。

- 「LangGraph **沒有** interrupt index 或 counter，靠呼叫棧位置區分」——**錯**，見 §2.1。
  報告自己註明那節是從 `.d.ts` 推論的。
- 「一次 resume **只能**解一個 node 的一個 `interrupt()`」——**錯**，見 §2.2。
- 「dsh **沒有**『一批待核准』的載體」——**半錯**：批次載體確實沒有，但**多顆並存的索引有**（§1.3），
  而那正好是 (丙) 的形狀。這條否定宣稱附的 grep 只掃了 `pending: [` 這類批次寫法，
  掃不到 `Map<Id, …>`。
