/**
 * serve 的伺服器日誌出口：把一顆 `logger-console` exporter 掛到 Cordis 根的 logger 上（[#1534](https://github.com/DemianLi/nexus-agent/issues/1534)）。
 *
 * ## 形狀
 *
 * serve 自己的行與樹上的話（插件 dispose 拋的錯、Loader 的警告…）都進根 logger，同一組 exporter、同一個門檻。
 * exporter 是 vendor 的 `ConsoleExporter`（`vendor/logger-console`，照 dsh 的 `render` 印文字），本檔多做三件事：
 *
 * 1. **輸出口可注入**：寫到 `write`，serve 交進來的是 `options.log ?? console.log`，所以既有測試抓得到、systemd 底下進 stdout。
 * 2. **`format: 'json'`**：一行一個 JSON 物件（`ts`、`level`、`logger`、`msg`、可選 `thread_id`），訊息裡的換行留在 `msg` 字串裡。偏離登記見 `settings/logger-console.ts` 偏離二。
 * 3. **回放**：exporter 比第一行日誌晚掛上（要讀完清單才知道設定），所以掛上時先把根 logger 緩衝裡已有的話依門檻印一遍，之後才登記、改印即時的。
 *    照 dsh：`apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts:52-53`。緩衝上限 1000 則（`LoggerService.bufferSize`），
 *    超過的最舊的話已經被擠掉——啟動前段不會有那麼多。
 *
 * ## 等級順序（承重）
 *
 * vendor 的 `LoggerLevel` 是 `const enum`，跨檔案取不到；它的順序是上游 rc.11 的 `ERROR 0、WARN 1、INFO 2、DEBUG 3`，**與 dsh 的 fork 不同**
 * （`ERROR 0、INFO 1、WARN 2、DEBUG 3`），所以設定寫名稱、換算在 {@link LOG_LEVEL_NUMBERS}，`server-log.test.ts` 用 vendor 實際的門檻行為把這張表釘住。
 *
 * @module
 */

import { Logger } from '@nexus/cordis';
import type { Context, Message } from '@nexus/cordis';
import { ConsoleExporter } from '@nexus/cordis-plugin-logger-console';

import { DEFAULT_SHOW_TIME, loggerConsoleConfigSchema } from './settings/logger-console.js';
import type { LogLevelName, LoggerConsoleConfig } from './settings/logger-console.js';

/** 等級名稱換成 vendor `LoggerLevel` 的數字，見檔頭「等級順序」。 */
export const LOG_LEVEL_NUMBERS: Readonly<Record<LogLevelName, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/** serve 自己的行用的 logger 名。 */
export const SERVE_LOGGER_NAME = 'serve';

/** 沒有任何門檻設定時 vendor 的預設：`INFO`。 */
const DEFAULT_THRESHOLD = LOG_LEVEL_NUMBERS.info;

/** 一行輸出。 */
export type LogWrite = (line: string) => void;

/** 把設定裡的等級名稱換成數字。 */
export function resolveLevelNumbers(
  levels: Readonly<Record<string, LogLevelName>>,
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const [name, level] of Object.entries(levels)) resolved[name] = LOG_LEVEL_NUMBERS[level];
  return resolved;
}

/** 掛 exporter 時用的出廠設定：設定列壞了、起不來時也用它把緩衝裡的話印出來。 */
export function defaultLoggerConsoleConfig(): LoggerConsoleConfig {
  return loggerConsoleConfigSchema.parse({});
}

/** 帶 thread 的訊息可以在 `meta` 放這一格（#1536 決定填法），JSON 會多一個 `thread_id`。 */
type ThreadedMessage = Message & { thread_id?: unknown };

/**
 * vendor 的 `ConsoleExporter` 建構子會 `ctx.logger.exporter(this)`，登記跟著**根的 fiber** 走。我們不要那一條（見 {@link mountServerLog}），
 * 所以建構時交一個什麼都不登記的 ctx，登記由我們自己做。
 */
const NO_REGISTRATION = { logger: { exporter: () => undefined } } as unknown as Context;

class ServerLogExporter extends ConsoleExporter {
  readonly #format: LoggerConsoleConfig['format'];
  readonly #write: LogWrite;

  constructor(config: LoggerConsoleConfig, write: LogWrite) {
    super(NO_REGISTRATION, {
      // JSON 不上色：ANSI 序列進了 `msg` 日誌平台會拆不開。
      colors: config.format === 'json' ? false : config.colors,
      showTime: config.showTime,
      levels: resolveLevelNumbers(config.levels),
      ...(config.maxLength !== undefined && { maxLength: config.maxLength }),
    });
    this.#format = config.format;
    this.#write = write;
  }

  /** 這一則過不過門檻：和 `Logger._method` 同一條式子（少了 logger 自己的 `level`，我們不用那一格）。 */
  passes(message: Message): boolean {
    const target = this.levels?.[message.name] ?? this.levels?.['default'] ?? DEFAULT_THRESHOLD;
    return target >= message.level;
  }

  override export(message: Message): void {
    this.#write(this.#format === 'json' ? this.renderJson(message) : this.render(message));
  }

  /** 一則 → 一行 JSON。`JSON.stringify` 把 `\n` 轉成 `\\n`，所以換行留在 `msg` 裡、不會多出一行。 */
  renderJson(message: Message): string {
    const threadId = (message as ThreadedMessage).thread_id;
    return JSON.stringify({
      ts: new Date(message.ts).toISOString(),
      level: message.type,
      logger: message.name,
      msg: Logger.format(this, message),
      ...(typeof threadId === 'string' && { thread_id: threadId }),
    });
  }
}

/**
 * 把 console exporter 掛到根上：**先回放緩衝、再登記**（照 dsh，見檔頭）。
 *
 * **登記不跟著根的 fiber 走，這是承重的。** `ctx.logger.exporter()` 是一個 `ctx.effect`，根卸載時它會和樹上其他 fiber 的 disposer 同時被收掉；
 * 而 Cordis 在 fiber 的 `_unload` 裡把 disposer 拋的錯記成 `ctx.logger.error`——那一刻 exporter 常常已經被收了，錯誤只進緩衝（實測：
 * `server-log.test.ts` 的「樹上的錯誤印得出來」在 exporter 走 effect 時是紅的）。所以直接放進 logger 服務的 `exporters` 表，
 * 活到整個 logger 服務（也就是整棵樹）結束；樹收掉之後沒有人再叫 logger，不會有洩漏。
 *
 * @param ctx - Cordis 的根 context（`PluginTree.context()`）。
 * @param config - 驗過的設定；`defaultLoggerConsoleConfig()` 是設定列起不來時的退路。
 * @param write - 一行的出口。
 */
export function mountServerLog(ctx: Context, config: LoggerConsoleConfig, write: LogWrite): void {
  const exporter = new ServerLogExporter(config, write);
  for (const message of ctx.logger.buffer.slice()) {
    if (exporter.passes(message)) exporter.export(message);
  }
  ctx.logger.exporters.set(++ctx.logger._snExporter, exporter);
}

/** serve 在一次執行裡用的伺服器日誌：說話的 logger，與「什麼時候把 exporter 掛上」。 */
export interface ServerLog {
  /** `serve` 這個名字的 logger；serve 自己的行一律從這裡講，等級照 `error`／`warn`／`info`。 */
  readonly serve: Logger;
  /** 別的名字的 logger（例如 `invariant`）：門檻可以在清單的 `levels` 裡以名字單獨設。 */
  logger(name: string): Logger;
  /**
   * 用讀完清單的設定掛 exporter 並回放緩衝。**只有第一次有效**：已經掛過（例如更早的失敗路徑用了出廠設定）就不再掛第二顆，
   * 否則同一則話會印兩次。
   */
  mount(config: LoggerConsoleConfig): void;
  /**
   * 清單還沒讀完（或讀不出來）就起不來時，用出廠設定掛上，讓緩衝裡的話與接下來收尾的話印得出來。已經掛過就什麼都不做。
   * **起不來的每一條路在 dispose 根之前都要叫它**：沒掛 exporter 的根，dispose 時 `_unload` 記的錯只進緩衝。
   */
  mountDefault(): void;
}

/**
 * 在根上開 `serve` logger，exporter 先不掛。
 *
 * @param ctx - 根 context。
 * @param write - 一行的出口；serve 交進來的是 `options.log ?? console.log`。
 */
export function createServerLog(ctx: Context, write: LogWrite): ServerLog {
  let mounted = false;
  const mount = (config: LoggerConsoleConfig): void => {
    if (mounted) return;
    mounted = true;
    mountServerLog(ctx, config, write);
  };
  return {
    serve: ctx.logger(SERVE_LOGGER_NAME),
    logger: (name) => ctx.logger(name),
    mount,
    mountDefault: () => {
      mount(defaultLoggerConsoleConfig());
    },
  };
}

export { DEFAULT_SHOW_TIME };
