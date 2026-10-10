/**
 * `@nexus/plugin-commands`——**人打的斜線命令**：解析、執行、記日誌。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-commands`
 * （`references/deepseek-harness/packages/interaction/commands/src/index.ts`，對讀版本
 * `cd5ef8148158c3a752a658978873241fdf8e2bbc`）。詞彙在 `@nexus/core` 的
 * {@link @nexus/core!CommandDefinition}，這裡是**執行那一半**。
 *
 * ## 兩件從 dsh 抄過來、看起來像細節其實是語意的事
 *
 * 1. **`parseCommand` 的 lookahead。** `/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u` ——
 *    名字後面要嘛是行尾、要嘛是空白，緊接著別的字元就整行不是命令。它擋的是**名字字元以外的
 *    非空白**：沒有那個 `(?=$|[\t\n\r ])`，`/usr/bin/env` 會被解析成 `usr` 加上 `/bin/env`，
 *    `/plan.md` 會被解析成 `plan` 加上 `.md`。**它不是在防 `/planning` 被截成 `/plan`**：名字的
 *    量詞是貪婪的，拿掉 lookahead 之後 `/planning` 照樣整個吃成 `planning`（2026-10-11 實測：
 *    拿掉之後 `index.test.ts` 的路徑、標點、冒號、大寫四條紅，`/planning` 那條照綠）。
 * 2. **收不下的行不記日誌。** 語法不符或名字不認得的，回 `undefined`、**日誌裡不留
 *    任何痕跡**（dsh 的原話：「Admission misses (syntax or unknown name) log nothing —
 *    they never entered a handler.」）。發派的那一側收到 `undefined` 就照原樣把那行
 *    送去該去的地方——在 CLI 就是送給模型，跟今天 `/foo` 的行為一樣。
 *
 * ## 這裡沒有偏離要標
 *
 * [#116](https://github.com/DemianLi/nexus-agent/issues/116) 的計劃模式退到
 * `stateSchema` ＋ checkpointer，是因為 **plugin** 拿不到 `SessionLog`。命令不一樣：
 * **產生者是進入點**（`runRepl` 手上就有那份日誌），所以 `command/run` / `command/done`
 * 走的就是 dsh 的形狀，沒有退。
 *
 * @see [#118](https://github.com/DemianLi/nexus-agent/issues/118)
 * @module
 */

import { randomUUID } from 'node:crypto';
import { isAttachmentRef } from '@nexus/core';
import type {
  AttachmentRef,
  CommandRegistrationPoint,
  CommandResult,
  SessionLog,
} from '@nexus/core';

/** 語法上是命令、但還沒查過註冊表的一行。 */
export interface ParsedCommand {
  /** 不帶斜線的命令名。 */
  readonly name: string;
  /** 命令名之後的原文，**含分隔的空白**。 */
  readonly rawInput: string;
}

/** 命令請宿主接著送的一句話：文字，加上它帶的附件參照（#732，沒有就不給這一格）。 */
export interface CommandSteer {
  readonly text: string;
  readonly attachments?: readonly AttachmentRef[];
}

/**
 * 宿主收附件時拒絕的理由（收據不存在、圖超過上限、目前的模型不收圖……）。**丟這個，執行器就把這次執行落定成 `error`**，訊息原樣
 * 當結果文字，handler 不會跑；丟別的錯誤則照 handler 拋錯處理（落定成 `error` 之後往外拋）。
 */
export class CommandAttachmentRejected extends Error {
  /** @param message - 直接呈現給人的理由。 */
  constructor(message: string) {
    super(message);
    this.name = 'CommandAttachmentRejected';
  }
}

/** 宿主收下附件的結果：參照，加上「這次執行沒成功時把收據放回去」。 */
export interface CommandAdmittedAttachments {
  /** 收下之後的參照，照選取順序。 */
  readonly attachments: readonly AttachmentRef[];
  /**
   * 命令落定成 `error`（回的或拋的）時呼叫，把用掉的收據放回去——輸入框留著草稿與附件，使用者不必重傳。
   * 成功時不呼叫（收據就此用掉）。
   */
  readonly rollback: () => void;
}

/** 一次執行帶來的、還沒收下的附件。 */
export interface CommandAttachmentSubmission {
  /**
   * 收下它們（驗形狀與上限、存檔、用掉收據）。**只有執行器確認命令宣告收附件之後才呼叫**——不收附件的命令，什麼都不該被寫。
   * 拒絕就丟 {@link CommandAttachmentRejected}。
   */
  readonly admit: () => Promise<CommandAdmittedAttachments>;
}

/** 一次落定的執行：配對 id、正規化過的結果，與命令請宿主接著送的話。 */
export interface CommandExecution {
  readonly commandId: string;
  readonly result: CommandResult;
  /**
   * 命令呼叫 `steer` 收下的話，**依呼叫順序**。`command/done` 寫完之後才交到宿主手上，宿主逐句當成人打的話送進對話。
   *
   * **結果是 `error` 時一律是空的**：命令失敗了，它半路說要送的話一起作廢。
   * **宿主不理這一格的話，那些話就靜靜沒有了**——所以兩個宿主（REPL 與 `serve`）都要讀它。
   */
  readonly steers: readonly CommandSteer[];
}

/**
 * 解析一行斜線命令，**不正規化它後面的輸入**。
 *
 * @param line - 完整的候選行。
 * @returns 解析結果，或這行根本不是命令時的 `undefined`。
 */
export function parseCommand(line: string): ParsedCommand | undefined {
  // lookahead 不是裝飾：少了它，`/planning` 會被當成 `/plan`。
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line);
  if (match === null) return undefined;
  const name = match[1];
  if (name === undefined) return undefined;
  return Object.freeze({ name, rawInput: line.slice(match[0].length) });
}

/** 把任意的中止理由收斂成一個穩定的 Error。 */
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(typeof signal.reason === 'string' ? signal.reason : '命令被中止了');
}

/** 印出任意被拋出來的東西，**不相信它的字串轉換**。 */
function renderThrown(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<印不出來的例外>';
  }
}

/** 發派它的請求一中止就不再等 handler——handler 不一定理會 signal。 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(
          error instanceof Error
            ? error
            : new Error(`命令 handler 拋了一個不是 Error 的東西：${renderThrown(error)}`, {
                cause: error,
              }),
        );
      },
    );
  });
}

/**
 * 在註冊表的邊界上驗 handler 的回傳值。
 *
 * **handler 是別人寫的**，回傳值進日誌之前要先確定它是那個形狀——`command/done` 的
 * `kind` 壞掉，配對不變量就檢查了一個不存在的東西。
 */
function normalizeResult(command: string, value: unknown): CommandResult {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new TypeError(`命令 "/${command}" 的 handler 要回一個 CommandResult。`);
  }
  const result = value as { kind?: unknown; text?: unknown };
  if (result.kind === 'success') {
    if (result.text !== undefined && typeof result.text !== 'string') {
      throw new TypeError(`命令 "/${command}" 成功時的 text 有給就要是字串。`);
    }
    return Object.freeze({
      kind: 'success',
      ...(result.text === undefined ? {} : { text: result.text }),
    });
  }
  if (result.kind === 'error') {
    if (typeof result.text !== 'string' || result.text.trim().length === 0) {
      throw new TypeError(`命令 "/${command}" 失敗時的 text 要是非空字串。`);
    }
    return Object.freeze({ kind: 'error', text: result.text });
  }
  throw new TypeError(`命令 "/${command}" 回了不認得的 kind "${renderThrown(result.kind)}"。`);
}

/** 建執行器要給的東西。 */
export interface CommandExecutorOptions {
  /** 命令從哪裡查。**只讀 `find`**——執行器不註冊任何東西。 */
  readonly commands: Pick<CommandRegistrationPoint, 'find'>;
  /** 生命週期事件記到哪一份日誌。 */
  readonly sessionLog: SessionLog;
  /**
   * `command/done` 在失敗路徑上又寫不進去時往哪裡講。省略即 `console.warn`。
   *
   * 這是一道縫而不是寫死 `console`，理由同 `SessionLog.onListenerError`：**圍堵成功
   * 的唯一外顯就是這一行**，沒有它，測試只能斷言「handler 的錯誤有往外拋」，斷言不到
   * 「第二個錯誤有被吞掉並記下來」。
   */
  readonly onWarn?: (message: string) => void;
  /**
   * 命令呼叫 `steer(text)` 時，宿主先驗一次這句話收不收。省略即都收。
   *
   * **拋出來的例外會從 handler 裡的 `steer` 冒出去**，所以 handler 只要在做任何有副作用的事之前呼叫，
   * 被拒收的命令什麼都沒改、`command/done` 落定成 `error`（例如 `@` 的會話引用不能用，#713）。
   */
  readonly acceptSteer?: (text: string) => void;
}

/** 一個發派面。**一個 REPL 一個**，配對 id 的計數器活在它裡面。 */
export interface CommandExecutor {
  /**
   * 解析並執行一行。**認得的才記日誌**。
   *
   * @param line - 完整的候選命令行。
   * @param signal - 發派它的那次請求擁有的取消訊號。
   * @param submission - 這一行帶的附件（#732），沒有就省略。**命令沒宣告 `input.attachments` 就落定成 `error`**（在 handler 與收下之前），
   *   照 dsh 的 `execute`：這一行已經記了 `command/run`。
   * @returns 落定的執行，或語法／名字不認得時的 `undefined`。
   * @throws handler 自己拋的錯誤，或執行前後被中止。**兩種都已經在日誌裡落定成
   *   `kind: 'error'`** 才往外拋。
   */
  execute(
    line: string,
    signal: AbortSignal,
    submission?: CommandAttachmentSubmission,
  ): Promise<CommandExecution | undefined>;
}

/**
 * 建一個命令發派面。
 *
 * **序列性是這個形狀的前提，也是不變量檢查的依據**：一個 REPL 一次只跑一個命令，
 * `execute` 回來之前不會有第二次。並行呼叫同一個執行器會讓兩次執行在日誌裡交錯，
 * 而 `@nexus/plugin-commands` 的配套入口會把那件事報成違規——那是對的，不是誤報。
 *
 * @param options - 命令來源、日誌、與圍堵的去處。
 * @returns 發派面。
 */
export function createCommandExecutor(options: CommandExecutorOptions): CommandExecutor {
  const { commands, sessionLog } = options;
  const warn = options.onWarn ?? ((message: string) => console.warn(message));
  // 實例 token ＋ 單調計數：同一份日誌被續上時，重啟前後的 id 不會撞。照 dsh 的
  // `cmd-${instanceToken}-${seq}`。
  const instanceToken = randomUUID().slice(0, 8);
  let seq = 0;

  /** 落定：先寫 `command/done`，再把結果交出去。 */
  function settle(
    commandId: string,
    result: CommandResult,
    steers: readonly CommandSteer[],
  ): CommandExecution {
    sessionLog.append('command/done', {
      commandId,
      kind: result.kind,
      // `text` 沒有的時候要整個不放這個 key——日誌對 `undefined` 是當場拋的。
      ...(result.text === undefined ? {} : { text: result.text }),
    });
    return Object.freeze({
      commandId,
      result,
      steers: Object.freeze(result.kind === 'success' ? [...steers] : []),
    });
  }

  /**
   * 拋錯路徑上的落定，**圍堵**。
   *
   * 這裡再拋一次的話，handler 原本的錯誤就會被一個寫日誌的錯誤蓋掉——而前者才是
   * 呼叫端要看的那個。
   */
  function settleThrown(commandId: string, name: string, error: unknown): void {
    try {
      sessionLog.append('command/done', {
        commandId,
        kind: 'error',
        text: error instanceof Error ? error.message : renderThrown(error),
      });
    } catch (appendError: unknown) {
      warn(`命令 "/${name}"：command/done 寫不進日誌——${renderThrown(appendError)}`);
    }
  }

  return {
    async execute(line, signal, submission) {
      const parsed = parseCommand(line);
      if (parsed === undefined) return undefined;
      const definition = commands.find(parsed.name);
      if (definition === undefined) return undefined;
      // 已經中止就不要開一次執行——開了就得記一對事件，而那一對描述的是沒發生的事。
      if (signal.aborted) throw abortError(signal);

      seq += 1;
      const commandId = `cmd-${instanceToken}-${String(seq)}`;
      sessionLog.append('command/run', {
        commandId,
        name: parsed.name,
        // 照 dsh：命令自己的 domain 事件帶著這段輸入時不再記一次（`session-log.ts` 的 `command/run`）。
        ...(definition.recordInput === false ? {} : { args: parsed.rawInput }),
        source: { kind: 'user' },
      });

      // 附件（#732）。照 dsh 的 `execute`：命令沒宣告收附件，就在收下之前、handler 之前落定成 `error`——沒有任何東西被寫。
      let admitted: CommandAdmittedAttachments | undefined;
      if (submission !== undefined) {
        if (definition.input?.attachments !== true) {
          return settle(
            commandId,
            { kind: 'error', text: `命令 "/${parsed.name}" 不收附件。` },
            [],
          );
        }
        try {
          const pending = submission.admit();
          // 發派它的請求中止時不再等：但收下可能已經用掉收據，所以晚到的結果要放回去。
          pending.then(
            (late) => {
              if (signal.aborted) late.rollback();
            },
            () => undefined,
          );
          admitted = await withAbort(pending, signal);
        } catch (error: unknown) {
          if (error instanceof CommandAttachmentRejected) {
            return settle(commandId, { kind: 'error', text: error.message }, []);
          }
          settleThrown(commandId, parsed.name, error);
          throw error;
        }
      }
      const attachments: readonly AttachmentRef[] = Object.freeze([
        ...(admitted?.attachments ?? []),
      ]);
      const admittedIds = new Set(attachments.map((ref) => ref.attachmentId));

      const steers: CommandSteer[] = [];
      let open = true;
      const steer = (text: string, steerAttachments?: readonly AttachmentRef[]): void => {
        // 命令結束後宿主已經不看這一格了：靜靜收下等於靜靜丟掉。
        if (!open) throw new Error(`命令 "/${parsed.name}" 已經結束，不能再 steer。`);
        if (typeof text !== 'string' || text.trim().length === 0) {
          throw new TypeError(`命令 "/${parsed.name}" 的 steer 要是非空字串。`);
        }
        // 帶附件的 steer 只能帶這次呼叫收下的那幾份：host 不替 handler 憑空造參照。
        if (steerAttachments !== undefined) {
          for (const ref of steerAttachments) {
            if (!isAttachmentRef(ref) || !admittedIds.has(ref.attachmentId)) {
              throw new TypeError(`命令 "/${parsed.name}" 的 steer 只能帶這次呼叫收下的附件。`);
            }
          }
        }
        options.acceptSteer?.(text);
        steers.push({
          text,
          ...(steerAttachments === undefined || steerAttachments.length === 0
            ? {}
            : { attachments: Object.freeze([...steerAttachments]) }),
        });
      };

      let result: CommandResult;
      try {
        const returned = definition.handler({
          commandId,
          rawInput: parsed.rawInput,
          attachments,
          signal,
          sessionLog,
          steer,
        });
        result = normalizeResult(parsed.name, await withAbort(Promise.resolve(returned), signal));
      } catch (error: unknown) {
        open = false;
        admitted?.rollback();
        settleThrown(commandId, parsed.name, error);
        throw error;
      }
      open = false;
      // 命令沒成功：收據放回去，輸入框的草稿與附件留著。
      if (result.kind === 'error') admitted?.rollback();
      return settle(commandId, result, steers);
    },
  };
}

declare module '@nexus/core' {
  interface SessionEventMap {
    /**
     * 一個解析得出來的斜線命令進了它的 handler。**只記日誌，永遠不進模型**。
     *
     * 與 `command/done` 靠 `commandId` 配對，形狀照 dsh 的 `tool/call`↔`tool/result`
     * （我們自己的那一對在下面，模型的工具呼叫記在那裡）。
     * `name` 與 `args` 是 `parseCommand` 自己的切分（命令名，以及**含分隔空白的原文**），
     * 所以讀日誌的人不必再解析一次。
     *
     * **收不下的行不記**：語法不符或名字不認得的，從來沒進過 handler，日誌裡不留痕跡。
     * 這一條照 dsh 的 `execute`：「Admission misses log nothing」。
     *
     * **`args` 是使用者原話，而它會原樣進遙測**——協調器一律鏡像每一顆事件（見
     * `session-telemetry-coordinator.ts`）。
     *
     * **命令宣告 `recordInput: false` 時整個不放 `args`**，照 dsh
     * （`packages/interaction/commands/src/index.ts:376`，`c291e79`）：那段輸入由命令自己的 domain 事件
     * 帶著，這裡再記一次就是同一段話在日誌裡出現兩次。今天只有 `/feedback` 這樣宣告
     * （[#278](https://github.com/DemianLi/nexus-agent/issues/278)）；v8 以前每一顆都帶這一格。
     */
    'command/run': {
      readonly commandId: string;
      readonly name: string;
      readonly args?: string;
      readonly source: { readonly kind: 'user' };
    };
    /**
     * 配對的那次執行落定了。handler 拋錯或被中止都落成 `kind: 'error'`。
     *
     * **`text` 沒話說的時候要整個不放這個 key，不能放 `undefined`**——`snapshotJsonValue`
     * 對 `undefined` 是當場拋的，而它拋的時候整筆不算，等於這次執行在日誌裡沒有落定。
     */
    'command/done': {
      readonly commandId: string;
      readonly kind: 'success' | 'error';
      readonly text?: string;
    };
  }
}
