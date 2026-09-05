/**
 * 人的命令——**使用者打的斜線指令**的詞彙。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-commands`
 * （`references/deepseek-harness/packages/interaction/commands/src/`，對讀版本
 * `cd5ef8148158c3a752a658978873241fdf8e2bbc`）：`name` / `description` / `input` /
 * `handler`，handler 回一個 `CommandResult`，由**發派的 UI 直接呈現**——命令不進模型。
 *
 * **這一層與工具是兩件事，不要合併。** 工具是模型呼叫的，命令是人打的；工具的結果回
 * 到 transcript 裡影響下一次推理，命令的結果只印給人看。dsh 兩者分屬不同子系統，
 * 我們照做。
 *
 * **`agent` 與 `attachments` 這兩格我們沒有。** dsh 的 `CommandInvocation` 帶
 * `agent`（它的註冊表跨 agent，要靠它決定作用在誰身上）與 `attachments`（圖片附件經
 * attachment store 收下之後交給 handler）。attachment store 還不存在，**那一格是缺，
 * 不是省略**。
 *
 * **`agent` 這一格的理由在 [#126](https://github.com/DemianLi/nexus-agent/issues/126)
 * 之後換過一次，結論沒換。** 原本寫的是「我們一次 `createNexusAgent` 一個 registry，
 * 『作用在誰身上』沒有指涉對象」——`/goal` 是第一個真的需要一個作用對象的命令
 * （它變更的是會話日誌上的耐久狀態），所以那個指涉對象現在存在了，只是它不是 agent
 * **而是會話日誌**。而 handler 找得到它，靠的不是這裡多一格：`load.ts` 一次組裝呼叫
 * 一次 `apply`，接線那一層一份 registry 接一份日誌，所以逐次 `apply` 的閉包就把兩者
 * 對上了。**「一份 registry 只接一份日誌」是這條推論的前提**，而它是可證偽的——
 * `@nexus/plugin-goal` 的命令在接了不只一份時當場回一句錯誤，那條線有測試釘著。
 *
 * @see [#118](https://github.com/DemianLi/nexus-agent/issues/118)
 */

/** 命令名的形狀。**正則照抄 dsh**——小寫開頭，其後小寫、數字、底線、連字號。 */
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;

/** 命令的自由輸入怎麼提示。 */
export interface CommandInputDescriptor {
  /** 使用者還沒打字時顯示的佔位字串。 */
  readonly hint: string;
}

/**
 * handler 的結果，**由發派它的那一側直接呈現**。
 *
 * `success` 的 `text` 可以省略——有些命令做完就沒話說。`error` 的 `text` 是必填的：
 * 報錯而不說為什麼，等於沒報。
 *
 * dsh 的 `success` 還有一格 `sourceEventSeq`（指向某顆更早的權威事件，讓客戶端自己
 * 算出更豐富的呈現）。
 *
 * **「我們沒有那種『權威 domain 事件』」這句話從
 * [#126](https://github.com/DemianLi/nexus-agent/issues/126) 起不成立了**——`goal/change`
 * 就是第一顆：它記的不是「發生過什麼」而是「現在的狀態是什麼」，帶著整份快照。
 *
 * **那一格仍然留白，換成另一個理由：沒有消費者。** dsh 的 `/goal` 靠它讓客戶端自己去讀
 * 那顆事件、算出更豐富的呈現；我們的命令面照 dsh 是 handler 自己把完整狀態渲染成
 * `text` 的，客戶端不必回頭讀日誌。補上這一格要一路穿過 wire 協定到瀏覽器，而另一端
 * 沒有人要它。
 *
 * **這一段是絆索：哪天有客戶端真的需要從命令結果回頭找那顆事件，就是補它的時候。**
 */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string };

/** 一次命令執行交給 handler 的東西。 */
export interface CommandInvocation {
  /** 這一次執行的配對 id，已經寫進它的 `command/run` 事件裡。 */
  readonly commandId: string;
  /**
   * 命令名之後的原文，**含分隔的空白**。
   *
   * 不做 trim：要不要 trim 是 handler 自己的文法決定的，這一層先把原文原樣交出去。
   */
  readonly rawInput: string;
  /** 發派它的那次請求擁有的取消訊號。 */
  readonly signal: AbortSignal;
}

/** 一筆命令註冊。 */
export interface CommandDefinition {
  /** 不帶斜線的小寫命令名。 */
  readonly name: string;
  /** 給人看的一句話，探索清單用。 */
  readonly description: string;
  /** 有自由輸入時的提示。 */
  readonly input?: CommandInputDescriptor;
  /**
   * 執行。**不把命令送給模型**——命令是人對工具說的話，不是對模型說的話。
   *
   * @param invocation - 這一次執行的原文、配對 id 與取消訊號。
   * @returns 直接呈現給人的結果。
   */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}

/** 不帶 handler 的命令視圖，給探索清單用。 */
export interface CommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly input?: CommandInputDescriptor;
}

/**
 * 註冊當下就驗，**壞掉的中繼資料進不了註冊表**。
 *
 * 照 dsh 的 `normalizeDefinition`：驗完凍起來，descriptor 是另一顆凍過的物件——
 * 交出去的清單改不動，也帶不出 handler。
 *
 * @param definition - 未經檢查的註冊。
 * @returns 凍過的定義與它對應的 descriptor。
 * @throws 名字不合 {@link COMMAND_NAME_PATTERN}、描述不是非空字串、handler 不是
 *   函式、或 `input.hint` 不是非空字串。
 */
export function normalizeCommandDefinition(definition: CommandDefinition): {
  readonly definition: CommandDefinition;
  readonly descriptor: CommandDescriptor;
} {
  if (!COMMAND_NAME_PATTERN.test(definition.name)) {
    throw new TypeError(
      `命令名 "${definition.name}" 不合 ${String(COMMAND_NAME_PATTERN)}——` +
        `小寫開頭，其後只收小寫、數字、底線與連字號。`,
    );
  }
  if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
    throw new TypeError(`命令 "${definition.name}" 的 description 要是非空字串。`);
  }
  if (typeof definition.handler !== 'function') {
    throw new TypeError(`命令 "${definition.name}" 的 handler 要是函式。`);
  }
  let input: CommandInputDescriptor | undefined;
  if (definition.input !== undefined) {
    const hint: unknown = definition.input.hint;
    if (typeof hint !== 'string' || hint.trim().length === 0) {
      throw new TypeError(`命令 "${definition.name}" 的 input.hint 要是非空字串。`);
    }
    input = Object.freeze({ hint });
  }
  const normalized: CommandDefinition = Object.freeze({
    name: definition.name,
    description: definition.description,
    ...(input === undefined ? {} : { input }),
    handler: definition.handler,
  });
  const descriptor: CommandDescriptor = Object.freeze({
    name: normalized.name,
    description: normalized.description,
    ...(input === undefined ? {} : { input }),
  });
  return { definition: normalized, descriptor };
}
