/**
 * 那顆**切得動**的圍堵格子，與切它的入口 `/sandbox`。
 *
 * ## 這一刀補的是什麼
 *
 * [#238](https://github.com/DemianLi/nexus-agent/issues/238) 第 0 項定案「照標準」，而標準
 * （dsh）的答案不是「維持現狀」，是**「這是部署方的選擇」**——那句話要成立，選擇就得真的
 * 切得動。上一刀（[#240](https://github.com/DemianLi/nexus-agent/pull/240)）讓 fence 與提示
 * 逐次去問一顆來源，但那顆來源是 closure 住 `--sandbox` 的**常數**：機制備好了，沒有人切
 * 得動。這個檔案就是那顆常數的替代品。
 *
 * ## 照 dsh 的三條，與明著不照的一條
 *
 * 1. **淨變化為零不寫事件。** 切到已經生效的那一格什麼都不發生
 *    （`permission-presets/README.zh.md`：「净变化为零的选择不追加任何内容」）。
 * 2. **掛上去的當下就把起始值釘進日誌。** dsh 挂载时固定所有存活与未来的会话。不釘的話，
 *    一份從頭到尾沒人切過的日誌**答不出政策是哪一格**——而那是最常見的那一份。
 * 3. **切換走的是各自的權威 setter。** dsh 的 preset 只改真的不同的那顆旋鈕，兩顆旋鈕各自
 *    保留自己的值。我們這裡只有一顆旋鈕，所以「權威 setter」就是 {@link SandboxModeController.switchTo}
 *    ——**fence 與提示句都跟它讀同一顆**，不各存快照。
 * 4. **不做具名 preset，而這是「還沒做」不是「做不到」。** dsh 把沙箱模式與核准政策捆成
 *    `workspace-write` / `danger-full-access` 兩個具名 preset 給人選。我們今天捆不起來，因為
 *    **另一顆旋鈕還不是逐次解析的**：`ApprovalPolicy.enabled` 在 fold 當下就被
 *    `deriveApprovalChannel` 算成一顆 `ApprovalChannel`，扣進 `createApprovalGateMiddleware`
 *    的閉包（`packages/nexus-core/src/approval.ts`）。今天發一個 preset 出去，它會**只搬得動
 *    自己的一半旋鈕而另一半靜靜不動**——一個承諾了捆綁卻只捆了一邊的選擇器。
 *    把核准那顆也變成來源是**同一個一行的把戲**（傳來源不傳值），所以這是排序不是障礙。
 *
 * ## 這顆格子的壽命是「一次組裝」，而那剛好就是一條 thread
 *
 * 它由 `createCliAgent` 建，而 `serve.ts` 是**一條 thread 呼叫一次 `createCliAgent`**
 * （「一個 thread 一個 agent——各自的 checkpointer、各自的虛擬檔案系統」）。所以兩條 thread
 * 不會共用同一格。**放進模組層或工廠閉包就會串台**，同 `@nexus/plugin-goal` 那段註解記的
 * 事故形狀：一條 thread 的 `/sandbox read-only` 收緊到另一條 thread 的檔案工具上。
 *
 * ## 子代理照委派那一刻的那一格
 *
 * [#326](https://github.com/DemianLi/nexus-agent/issues/326)，照 dsh `captureDelegatedPolicyOverrides`
 * （`packages/subagent/subagent/src/child-agent.ts`，SHA `0d1f500`）：委派那一刻拍下 root 那一格，root 之後
 * 再切是 root 的未來，不是這個子代理的；一次性 grant 一律不給子代理。
 *
 * **拍的是 {@link SandboxModeController.current}，不分「明確設過」與部署預設。** dsh 分得出來，但它的
 * 產品 bundle 組了 `permission-presets`，每一條 session 建立時就把部署值釘進日誌
 * （`permission-presets/src/index.ts` 的 `pinInitialPermission`），所以產品路徑上每一條都有覆寫可拍。
 * 我們的 {@link SandboxModeController.attach} 就是那一步。
 *
 * **偏離（登記）：快照放在 ALS，不是從子代理自己的日誌折。** dsh 子代理的 fence 從子代理的日誌折出模式；
 * 我們子代理的檔案工具是基座拿 root 那一份 backend 建的，方法簽名裡沒有呼叫者，表達不出「逐 session
 * 折」。所以本套件的 `index.ts` 用 ALS 包住 `task` 那一次呼叫（{@link SandboxModeController.delegate}），
 * 在裡面讀這顆控制器的一律拿到快照；日誌只是審計面，同 root。子代理的摘要器 offload 也在 `task` 那一次
 * 呼叫裡跑，所以同樣照快照判——基礎建設的寫入不會繞過它（`uploadFiles` 本來就不認領 grant）。
 *
 * ## 跨重啟
 *
 * 切換寫得進日誌，**CLI 的 `--resume <run 目錄>` 與 serve 碰到以前寫過的 thread 都讀得回來**：最後一顆 `sandbox/mode` 就是
 * 起始那一格（{@link recordedSandboxMode}，[#251](https://github.com/DemianLi/nexus-agent/issues/251)
 * 的門 A）。續接不收 `--sandbox`——兩個來源不管誰贏，另一個都是靜靜被丟掉；接起來之後要換
 * 就用 `/sandbox`，那一次會記進日誌。**驗收在 `sandbox-mode.test.ts` 最後一組**，由原本釘住
 * 「`SessionStore` 只有 `create`」的那條絆索翻面而來。
 *
 * serve 那一半在 `serve-session-log.test.ts` 的「重開 server 之後接得回同一條 thread」：上一次
 * 切成 `read-only`，重開之後 `/sandbox` 報的還是它；日誌記著模式而這一次沒給 `--workspace` 就
 * 擋下，同 CLI。web 那端把 thread id 記在瀏覽器裡，所以重新整理之後接的是同一條（`apps/web/src/lib/remembered-thread.ts`）。
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  SandboxDenial,
  SandboxGrant,
  SandboxGrantLedger,
  SandboxMode,
  SandboxModeSource,
  SessionEvent,
  SessionLog,
} from '@nexus/core';
import { isSandboxMode, SANDBOX_MODES } from '@nexus/core';

/** `/sandbox` 的命令名，不帶斜線。 */
export const SANDBOX_COMMAND_NAME = 'sandbox';

/** `/sandbox` 在探索清單裡的那一句。 */
export const SANDBOX_COMMAND_DESCRIPTION = '看或切換這個會話的檔案效果政策';

/** `/sandbox` 的輸入提示。 */
export const SANDBOX_COMMAND_HINT = `[${SANDBOX_MODES.join('｜')}]`;

/**
 * 一份日誌上**最後一顆** `sandbox/mode` 記的那一格，一顆都沒有時是 `undefined`。
 *
 * 續接（[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）拿它當起始那一格：
 * `sandbox/mode` 每一筆帶整個值，所以最後一顆就是答案，不必折疊。`undefined` 是那一次跑
 * 沒有 fence——沒給 `--workspace` 就一顆都不寫（見 `SessionEventMap['sandbox/mode']`），
 * 續接那一次照常從預設起算。
 *
 * @param events - 讀回來的那一份日誌。
 * @returns 最後一顆記的模式，或 `undefined`。
 */
export function recordedSandboxMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event?.type === 'sandbox/mode') return event.data.mode;
  }
  return undefined;
}

/** 一次切換的結局。 */
export type SandboxSwitchOutcome =
  /** 真的換了一格，日誌上多了一顆 `sandbox/mode`。 */
  | { readonly kind: 'switched'; readonly from: SandboxMode; readonly to: SandboxMode }
  /** 目標就是現在這一格。**什麼都沒發生，日誌上一顆都沒加**。 */
  | { readonly kind: 'unchanged'; readonly mode: SandboxMode };

/**
 * 這個組裝的檔案效果政策現在是哪一格，以及切它的權威入口。
 *
 * **fence（`@nexus/harness` 的 `ContainedFilesystemBackend`）與提示句（本套件的 `index.ts`）都跟這一顆讀**，
 * 各自透過 {@link SandboxModeController.source}。兩邊各存一份快照的話，切換那天畫面上講的
 * 與實際擋的會是兩格，而**沒有任何測試會紅**——那正是這個 class 只有一格狀態的原因。
 */
export class SandboxModeController implements SandboxGrantLedger {
  #mode: SandboxMode;

  /**
   * 待消費的那一顆升級 grant（見 `SandboxGrant`）。
   *
   * **一次最多一顆**：新核准的蓋掉舊的，舊的就再也認領不到——少一顆是 fail-closed 的方向。
   * **不進日誌**，理由同核准本身那條（[#220](https://github.com/DemianLi/nexus-agent/issues/220)：
   * 核准在日誌上一顆事件都沒有，是認帳不做）。
   */
  #grant: SandboxGrant | undefined;

  /**
   * 最近一次被 fence 擋下的變更，升級工具發 grant 時綁它（見 `SandboxGrant`）。
   *
   * **一次只留一顆**，同 grant：同一輪兩顆變更都被擋、模型只升級其中一顆的話，綁到的是後擋
   * 下的那一顆，另一顆的重試認領不到——少一顆是 fail-closed 的方向。不進日誌，理由同 grant。
   */
  #denial: SandboxDenial | undefined;

  /** 見 {@link SandboxModeController.escalationHint}。 */
  #escalationHint: string | undefined;

  /**
   * 委派那一刻拍下的那一格（見模組註解「子代理照委派那一刻的那一格」）。有值就是這一次呼叫在某個
   * 子代理裡。**一顆控制器一份**，同控制器本身一條 thread 一格的理由：模組層一份的話，兩條 thread 的
   * 快照雖然不會串（ALS 逐次 `run`），但誰在讀哪一顆控制器的委派就講不清楚了。
   */
  readonly #delegated = new AsyncLocalStorage<{ readonly mode: SandboxMode }>();

  /**
   * 接著的 root 日誌，**依接線順序**。
   *
   * 是陣列不是單一格，理由同 `@nexus/plugin-goal`：「剛好一份」是一個假設，`attachSession`
   * 是組裝點自己呼叫的一步，沒有東西攔得住它被呼叫兩次。**多於一份時每一份都寫**——
   * 與 goal 不同，這裡的狀態不住在日誌上，日誌只是審計面；兩份 root 日誌共用的是同一道
   * fence，所以兩份都該記得下它換過哪幾格。
   */
  readonly #logs: SessionLog[] = [];

  /**
   * @param initial - 起始那一格，通常來自 `--sandbox`。省略即 `workspace-write`——
   *   預設要是設防的那一個，同 fence 自己的預設。
   */
  constructor(initial: SandboxMode = 'workspace-write') {
    this.#mode = initial;
  }

  /**
   * 這一刻是哪一格。**在子代理裡是委派那一刻拍下的那一格**，root 之後的切換影響不到它。
   * fence（經 {@link SandboxModeController.source}）與升級閘門都讀這裡，所以兩邊一起跟著委派走。
   */
  get current(): SandboxMode {
    return this.#delegated.getStore()?.mode ?? this.#mode;
  }

  /** 委派那一刻拍下的那一格；不在任何一次委派裡時為 `undefined`。子代理的日誌開啟時讀它。 */
  get delegatedMode(): SandboxMode | undefined {
    return this.#delegated.getStore()?.mode;
  }

  /**
   * 在一次委派裡跑 `run`：**進去之前同步拍下 {@link SandboxModeController.current}**，`run` 裡（含它
   * await 的一切）讀這顆控制器的都拿到那一格，也碰不到 root 的 grant 與 denial。
   *
   * 拍的是 `current` 不是 root 那格：子代理再委派時，內層拿到的是它的父代理那一格，同 dsh。
   *
   * @param run - 委派工具那一次呼叫的本體。
   * @returns `run` 的回傳值，原樣。
   */
  delegate<T>(run: () => T): T {
    return this.#delegated.run({ mode: this.current }, run);
  }

  /** 這一次呼叫是不是在某個子代理裡。 */
  get #inDelegation(): boolean {
    return this.#delegated.getStore() !== undefined;
  }

  /**
   * 現在接著幾份日誌。
   *
   * `/sandbox` 讀它是為了**在零份的時候把「這次切換沒留痕跡」講出來**——一次悄悄沒進
   * 日誌的切換與一次進了日誌的切換，在畫面上長得一模一樣。
   */
  get attachedCount(): number {
    return this.#logs.length;
  }

  /**
   * 交給 fence 與提示句的那顆來源。
   *
   * **是欄位不是方法**，這樣拿去傳給別人時不必再 bind——傳一個沒 bind 的方法出去會在
   * 呼叫端變成 `this` 是 `undefined`，而那個錯要到第一次工具呼叫才炸。
   */
  readonly source: SandboxModeSource = () => this.current;

  /**
   * 被擋下時接在拒絕後面的升級指引。**只有真的掛了升級工具才有**——由掛它的那一步
   * （{@link SandboxModeController.enableEscalation}）寫進來，所以 fence 與工具對「這個組裝
   * 有沒有升級」讀的是同一個事實，不會一邊公告一邊沒有。
   */
  get escalationHint(): string | undefined {
    return this.#escalationHint;
  }

  /**
   * 掛上升級工具的那一步呼叫它。
   * @param hint - 被擋下時要接在拒絕後面的那句話。
   */
  enableEscalation(hint: string): void {
    this.#escalationHint = hint;
  }

  /**
   * 發一顆 grant：**只蓋一個目標、只蓋一次**。
   *
   * **在子代理裡什麼都不做**，下面四個同一條：一次性 grant 一律不給子代理（照 dsh），而 grant 與
   * denial 各只有一格、是 root 的。子代理的升級今天在閘門就被拒（`policy-never`），走不到這裡；
   * 擋在這裡是 fail-closed 的那一層。
   *
   * @param grant - 核准來的模式與模型指名的那個檔。
   */
  grant(grant: SandboxGrant): void {
    if (this.#inDelegation) return;
    this.#grant = grant;
  }

  /** @returns 現在待消費的那一顆；只看，不消費。**在子代理裡一律 `undefined`**：root 那顆認領不到。 */
  peekGrant(): SandboxGrant | undefined {
    return this.#inDelegation ? undefined : this.#grant;
  }

  /**
   * 消費**這一顆**。
   * @param grant - 先前 peek 到的那一顆。
   * @returns 它還是待消費的那一顆時為真；在子代理裡一律為假。
   */
  takeGrant(grant: SandboxGrant): boolean {
    if (this.#inDelegation || this.#grant !== grant) return false;
    this.#grant = undefined;
    return true;
  }

  /**
   * fence 擋下一次變更時記下它，蓋掉前一顆。
   *
   * **在子代理裡不記**：記了會蓋掉 root 剛被擋的那一次，root 接著叫升級時 grant 綁到的是子代理那一次，
   * root 的重試就對不上（#326）。
   *
   * @param denial - 這一次被擋下的變更。
   */
  recordDenial(denial: SandboxDenial): void {
    if (this.#inDelegation) return;
    this.#denial = denial;
  }

  /** @returns 最近一次被擋下的變更；還沒擋過、或在子代理裡時為 `undefined`。 */
  get lastDenial(): SandboxDenial | undefined {
    return this.#inDelegation ? undefined : this.#denial;
  }

  /**
   * 接一份 root 會話日誌，**並且當場把起始值釘進去**。
   *
   * 釘起始值是照 dsh 的挂载固定：不釘的話，一份沒有人切過的日誌答不出政策是哪一格。
   *
   * @param log - 要記帳的日誌。
   * @returns 收掉這次接線的函式。
   */
  attach(log: SessionLog): () => void {
    this.#logs.push(log);
    log.append('sandbox/mode', { mode: this.#mode });
    return () => {
      const at = this.#logs.indexOf(log);
      if (at >= 0) this.#logs.splice(at, 1);
    };
  }

  /**
   * 切到某一格。**淨變化為零時什麼都不做**，照 dsh。
   *
   * @param next - 目標那一格。
   * @returns 這次切換的結局；`unchanged` 代表日誌上一顆都沒加。
   */
  switchTo(next: SandboxMode): SandboxSwitchOutcome {
    const from = this.#mode;
    if (from === next) return { kind: 'unchanged', mode: from };
    this.#mode = next;
    for (const log of this.#logs) log.append('sandbox/mode', { mode: next });
    return { kind: 'switched', from, to: next };
  }
}

/** 沒接上任何日誌時，`/sandbox` 的回覆會多的那一句。 */
export const SANDBOX_UNRECORDED_NOTE = '（這次切換沒有記進任何會話日誌——沒有日誌接在上面。）';

/**
 * 跑一次 `/sandbox`。
 *
 * 三條路：沒有引數就報告現況與可切的那幾格；引數是認得的模式就切；認不得就回一則說得出
 * 認得哪幾個的錯誤。**認不得的那一條回 `kind: 'error'`**——一個把打錯字靜靜當成「看一下
 * 現況」的命令，會讓人以為自己切過了。
 *
 * @param controller - 這次組裝那一格。
 * @param rootDir - 可寫根，報告時指名它。
 * @param rawInput - 命令名之後的原文，含分隔的空白。
 * @returns 直接呈現給人的結果。
 */
export function executeSandboxCommand(
  controller: SandboxModeController,
  rootDir: string,
  rawInput: string,
): { readonly kind: 'success' | 'error'; readonly text: string } {
  const argument = rawInput.trim();
  const table = SANDBOX_MODES.join('、');
  if (argument.length === 0) {
    return {
      kind: 'success',
      text:
        `目前的檔案政策：${controller.current}（可寫根 ${JSON.stringify(rootDir)}）。\n` +
        `切得過去的：${table}。`,
    };
  }
  if (!isSandboxMode(argument)) {
    return { kind: 'error', text: `/sandbox 認不得 "${argument}"。認得的是 ${table}。` };
  }
  const outcome = controller.switchTo(argument);
  if (outcome.kind === 'unchanged') {
    return { kind: 'success', text: `本來就是 ${outcome.mode}，沒有變。` };
  }
  const note = controller.attachedCount === 0 ? `\n${SANDBOX_UNRECORDED_NOTE}` : '';
  return {
    kind: 'success',
    text: `檔案政策從 ${outcome.from} 換成 ${outcome.to}。${note}`,
  };
}
