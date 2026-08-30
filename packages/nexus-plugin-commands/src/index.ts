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
 *    沒有那個 `(?=$|[\t\n\r ])`，`/planning` 會被解析成 `/plan` 加上 `ning`。
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
import type { CommandRegistrationPoint, CommandResult, SessionLog } from '@nexus/core';

/** 語法上是命令、但還沒查過註冊表的一行。 */
export interface ParsedCommand {
  /** 不帶斜線的命令名。 */
  readonly name: string;
  /** 命令名之後的原文，**含分隔的空白**。 */
  readonly rawInput: string;
}

/** 一次落定的執行：配對 id 加上正規化過的結果。 */
export interface CommandExecution {
  readonly commandId: string;
  readonly result: CommandResult;
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
}

/** 一個發派面。**一個 REPL 一個**，配對 id 的計數器活在它裡面。 */
export interface CommandExecutor {
  /**
   * 解析並執行一行。**認得的才記日誌**。
   *
   * @param line - 完整的候選命令行。
   * @param signal - 發派它的那次請求擁有的取消訊號。
   * @returns 落定的執行，或語法／名字不認得時的 `undefined`。
   * @throws handler 自己拋的錯誤，或執行前後被中止。**兩種都已經在日誌裡落定成
   *   `kind: 'error'`** 才往外拋。
   */
  execute(line: string, signal: AbortSignal): Promise<CommandExecution | undefined>;
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
  function settle(commandId: string, result: CommandResult): CommandExecution {
    sessionLog.append('command/done', {
      commandId,
      kind: result.kind,
      // `text` 沒有的時候要整個不放這個 key——日誌對 `undefined` 是當場拋的。
      ...(result.text === undefined ? {} : { text: result.text }),
    });
    return Object.freeze({ commandId, result });
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
    async execute(line, signal) {
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
        args: parsed.rawInput,
        source: { kind: 'user' },
      });

      let result: CommandResult;
      try {
        const returned = definition.handler({ commandId, rawInput: parsed.rawInput, signal });
        result = normalizeResult(parsed.name, await withAbort(Promise.resolve(returned), signal));
      } catch (error: unknown) {
        settleThrown(commandId, parsed.name, error);
        throw error;
      }
      return settle(commandId, result);
    },
  };
}
