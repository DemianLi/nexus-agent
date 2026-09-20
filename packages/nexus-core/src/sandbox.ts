/**
 * 沙箱模式的**詞彙，加上 fence 與政策之間的合約**。域分住兩個套件：那道 fence 是
 * `@nexus/harness` 的 `contained-backend.ts`，那顆會被切的格子是
 * `@nexus/plugin-sandbox-policy` 的 `SandboxModeController`。
 *
 * ## 為什麼詞彙非搬到 core 不可
 *
 * 同 {@link ./commands.ts | CommandDefinition} 與 {@link ./goal.ts | GoalChangeMeta} 那一條：
 * **會話事件的酬載型別全部在 {@link ./session-log.ts | SessionEventMap} 上宣告**，而那張表
 * 住在 core。`sandbox/mode` 這一顆要帶的是模式本身，所以模式的聯集也得在 core——留在
 * harness 的話，酬載只能寫成 `string`，於是「哪三個字串合法」在寫入端與讀取端各有一份，
 * **而分岔的樣子是日誌裡出現一個沒有人認得的模式名，沒有任何測試會紅**。
 *
 * ## 名字為什麼不叫 `ContainmentMode`
 *
 * core 已經有一個 {@link ./containment.ts | containment}，它講的是**工具拋錯不要炸掉整場
 * run**——完全另一件事。兩個東西同名同一個套件裡，讀的人只能靠 import 路徑分辨。
 * 這裡改用 dsh 自己的字（`SandboxMode`，`packages/sandbox/sandbox-policy/src/index.ts`），
 * 而 `--sandbox` 這個旗標名本來就已經是這個字了。
 *
 * @module
 */

/**
 * 檔案效果政策：這個組裝的檔案工具**改得動哪裡**。
 *
 * 三格照 dsh 的 `SandboxMode`。要注意它管的是**寫得到哪裡**，不是**要不要問人**——後者
 * 是另一顆旋鈕（{@link ./fold.ts | ApprovalPolicy}）。兩顆各自獨立，dsh 用具名 preset 把
 * 它們捆起來給人選；我們今天只切得動前者，理由見 `@nexus/plugin-sandbox-policy` 的 `sandbox-mode.ts`。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * 三個模式的完整清單。**宣告順序沒有語義**——它只用來驗證外面來的字串（旗標、`/sandbox`
 * 的引數、將來的設定檔）。照 dsh 的 `SANDBOX_MODES` 存在的理由：型別擋不住執行期字串。
 */
export const SANDBOX_MODES: readonly SandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

/**
 * 一個外面來的字串是不是認得的模式。
 *
 * @param raw - 未經檢查的字串。
 * @returns 是的話 narrow 成 {@link SandboxMode}。
 */
export function isSandboxMode(raw: string): raw is SandboxMode {
  return (SANDBOX_MODES as readonly string[]).includes(raw);
}

/**
 * 「這次組裝有工作區」的能力名。宣告它的是 `@nexus/plugin-sandbox-policy`——那顆只在給了
 * `--workspace`、有圍堵的時候才掛，所以它在不在就是工作區在不在。
 *
 * **要它是因為 backend 在不在答不了這一題**：沒有工作區時組裝點照樣墊一顆 `StateBackend`
 * （`apps/harness/src/agent-factory.ts`），`useWithBackend` 的工廠照樣被叫。dsh 對應的判準是會話 header
 * 的 `cwd`（`tool-present` 的 `present requires a workspace`）；我們的 header `cwd` 記的是行程的工作目錄，
 * 不是工作區根，所以不能照抄。第一個讀方是 `@nexus/plugin-present`（[#441](https://github.com/DemianLi/nexus-agent/issues/441)）。
 */
export const WORKSPACE_CAPABILITY = 'workspace';

/**
 * ## 升級協定為什麼也在這裡
 *
 * 下面四個型別（{@link SandboxModeSource}、{@link SandboxGrant}、{@link SandboxDenial}、
 * {@link SandboxGrantLedger}）是**那道 fence 與那顆會被切的格子之間的合約**：fence 住在
 * `@nexus/harness` 的 `contained-backend.ts`，格子住在 `@nexus/plugin-sandbox-policy` 的
 * `SandboxModeController`。兩邊分屬不同套件，合約就不能住在其中一邊。
 *
 * 這是 dsh 的分法，不是我們的發明：它的基底套件 `@deepseek-ai/dsh-sandbox` 出的就是
 * 詞彙**加上升級協定**（`packages/sandbox/sandbox/src/index.ts:20` 把 `escalation.ts` 的
 * `EscalationApproval` / `EscalationApprover` / `EscalationOutcome` / `EscalationRequest`
 * 一起轉出去，SHA `6b1808f`），而 `sandbox-policy` 與執行端的 `sandbox-local` 各自依賴它。
 *
 * **產生的那句話不在這裡**：`GRANT_MISMATCH_NOTE` 是 fence 自己講的措辭，只有它會產生，
 * 所以留在 `contained-backend.ts`。搬進來的是合約，不是輸出。
 */

/**
 * 圍堵強度的來源——**每一次變更呼叫問一次**，不是建構期釘死的一個值。
 *
 * ## 為什麼是函式而不是一個欄位
 *
 * 照 dsh：模式是**逐次呼叫從統一歸屬位置解析**的，不是提供方身上的一個固定值
 * （`references/deepseek-harness/packages/sandbox/sandbox/src/index.ts` 的 `SandboxPolicy`
 * 檔頭逐字寫著「carried PER CALL, not fixed on the provider」，理由是同一瞬間兩個消費者
 * 可以在不同政策底下跑）。釘死在建構子上的話，「換一格」就只能重建整個 backend——而
 * backend 是**兩個消費者共用的那一份**（`cli.ts` 那條註解：建兩個會讓 `submit_record` 與
 * `write_file` 寫到兩個地方，而且兩邊都成功、一條測試都不會紅）。
 *
 * ## 偏離登記
 *
 * dsh 把解析出來的 `SandboxPolicy` **當參數傳進那一次變更**，所以「檢查的」與「執行的」
 * 是同一顆值，連傳遞都不必經過共享狀態。我們傳不了：`BackendProtocolV2` 的
 * `write`／`edit`／`delete`／`uploadFiles` 簽章是基座定的，多不出一格。**退到「backend 自己
 * 去問一顆外面的來源」**——所以解析點在 fence 裡而不是在呼叫端。
 *
 * 代價是一次呼叫內部有 `await`（realpath、canonicalize），來源在那之間變了就會出現撕裂讀。
 * 因此 `checkedPath()` **在最上面解析一次**，整個判斷與拒絕訊息都用那一顆——這正是 dsh
 * 「一次呼叫一份政策」那條規矩在我們這個形狀底下的寫法。
 */
export type SandboxModeSource = () => SandboxMode;

/**
 * 一顆核准過的升級：**只蓋一個目標、只蓋一次**。
 *
 * ## 為什麼一定要綁目標
 *
 * dsh 的升級欄位騎在**那一次寫入**身上，核准來的模式直接蓋到那一次呼叫
 * （`references/deepseek-harness/packages/fs/tool-fs/src/sandbox.ts` 的 `resolvePolicy`），
 * 所以「一次核准蓋這一次呼叫」由編排順便保證。我們的升級是另一顆工具
 * （[#238](https://github.com/DemianLi/nexus-agent/issues/238) 的甲），請求與重試是**兩顆
 * 呼叫**，中間隔著這顆 grant。
 *
 * 不綁目標的話，**第一個被擋下的變更就會吃掉它——而那可能根本不是模型**：基座的摘要器
 * offload 對話歷史時第一次走 `write`、fallback 走 `edit`（`deepagents@1.13.1`，
 * `dist/langsmith-Ck9t7AGW.cjs` 的 `offloadToBackend`），在 `read-only` 之下它一樣會被擋。
 * 綁住 canonical 目標之後，那條路從結構上就碰不到這顆 grant；對不上的方向是**不認領**，
 * 也就是照常被擋——fail-closed。
 *
 * 附帶的好處是核准卡上看得到是哪一個檔。dsh 的人本來就看得到（欄位騎在那次寫入上），
 * 所以這一格不是新的偏離，是「兩顆呼叫」那條已登記的偏離把該付的價付清。
 *
 * ## 為什麼也綁被擋下的那一次
 *
 * 只綁目標的話，人核准的與實際執行的可以是兩份內容：升級卡上只有檔名與理由，重試寫什麼
 * 都會被放行，而 `write_file`／`edit_file` 的重試**一張卡都沒有**。dsh 不必比對——核准的那顆
 * 就是會執行的那顆（欄位騎在重試上，卡片靠 `callId` 貼在它身上）。我們拆成兩顆呼叫，所以把
 * 「被擋下的那一次」整個綁進來（[#254](https://github.com/DemianLi/nexus-agent/issues/254)）：
 * 操作、canonical 目標、內容摘要都對得上才認領。這是上面那筆價的另一半。
 *
 * 對不上的方向照舊是不認領、照常被擋；**但不消費**，模型照指引原樣重試還拿得到它。代價是
 * 模型修正內容之後要重新升級。
 *
 * 比的是**送進 fence 的那一份**，不是工具參數：`submit_record` 送進來的是 append 之後的整份
 * CSV，所以同一筆紀錄在檔案中途被改過時也對不上，要重新升級——fail-closed 的方向。
 */
export interface SandboxGrant {
  /** 核准來的模式，**只套用在消費它的那一次變更上**。 */
  readonly mode: SandboxMode;
  /** 模型指名的虛擬路徑。比對時兩邊都 canonicalize：經 symlink 的別名對得上，`..` 與 `~` 一律對不上。 */
  readonly target: string;
  /**
   * 發 grant 那一刻最近一次被擋下的變更。那時候沒有被擋過就是 `undefined`，這顆 grant
   * 就認領不到任何變更。
   */
  readonly denied: SandboxDenial | undefined;
}

/**
 * fence 擋下的一次變更，**只留比對要用的東西**。
 *
 * 留摘要不留原文：這一格住在記憶體裡、只拿來比「重試是不是同一次」，用不到內容本身。
 */
export interface SandboxDenial {
  /** canonicalize 之後的絕對路徑。 */
  readonly target: string;
  /**
   * 操作名連同這一次的參數（`write` 的內容；`edit` 的舊字串、新字串與是否全部取代）的
   * sha256。**操作名在摘要裡**，所以同一個檔上被擋的 `write` 與 `delete` 不會是同一次。
   */
  readonly digest: string;
}

/**
 * fence 向外面認領 grant 的介面。`SandboxModeController` 就是它的實作。
 *
 * **`escalationHint` 在場就等於「這個組裝有升級工具」**——那是掛上工具的那一步寫進去的
 * 同一個事實，所以 fence 不會對一個沒有那顆工具的模型講「可以升級」（照 dsh：
 * `escalationModes` 為空時不公告）。
 */
export interface SandboxGrantLedger {
  /** 被擋下時接在拒絕後面的升級指引；這個組裝沒有升級工具時為 `undefined`。 */
  readonly escalationHint: string | undefined;
  /** 現在待消費的那一顆。**只看，不消費。** */
  peekGrant(): SandboxGrant | undefined;
  /**
   * 消費**這一顆**。
   * @param grant - 先前 {@link SandboxGrantLedger.peekGrant} 看到的那一顆。
   * @returns 它還是待消費的那一顆時為真；已經被別人消費、或被新的一顆換掉時為假。
   */
  takeGrant(grant: SandboxGrant): boolean;
  /**
   * 記下被擋下的這一次。**一次只留最近的一顆**：升級工具發 grant 時綁的就是它。
   * @param denial - 這一次被擋下的變更。
   */
  recordDenial(denial: SandboxDenial): void;
}
