/**
 * 主機端的插拔寫入口（[#1412](https://github.com/DemianLi/nexus-agent/issues/1412)）。
 *
 * ```
 * pnpm --filter @nexus/harness plugin disable <id>
 * pnpm --filter @nexus/harness plugin enable <id>
 * pnpm --filter @nexus/harness plugin config set <id> --file <設定檔|->
 * pnpm --filter @nexus/harness plugin config reset <id>
 * ```
 *
 * **獨立入口，不放進 `cli.ts`**：`cli.ts` 的位置參數就是「要說的話」，在第一個字認 `plugin` 會讓
 * 「plugin 是什麼」這種提問被吃掉。語意與驗證在 `plugin-change.ts`，這裡只管命令列與輸出。
 *
 * ## 命令參數不收設定值（加 6）
 *
 * 新設定**只從檔案或標準輸入讀**（`--file <path>`、`--file -`）。寫在命令參數裡，共用主機上的其他人用 `ps` 看得到，
 * shell 歷史也會留下。所以沒有 `--config '<json>'` 這種旗標，多給的位置參數一律拒絕。
 *
 * ## 輸出不印設定值（加 7）
 *
 * 只印哪幾個欄位變了。紀錄檔裡才有前後值（明文，0600）。
 *
 * ## `--patch`
 *
 * 要跟 serve 帶**同一組** `--patch`：寫入口是另一個行程，只能從命令列知道那一層。不給的話偵測不到被蓋掉
 * （開關回報不了 `overridden`，改設定也不會被預先拒絕）。
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parse as parseYaml } from 'yaml';

import { changePlugin, PluginChangeRejected } from './plugin-change.js';
import type { PluginChange, PluginChangeResult } from './plugin-change.js';

export const PLUGIN_CLI_USAGE = `用法：plugin <命令> [選項]

命令：
  disable <id>              停用清單上的一列
  enable <id>               啟用清單上的一列
  config set <id> --file <路徑|->
                            整份替換一列的 config（新設定從檔案或標準輸入讀，YAML 或 JSON，要是一張表）
  config reset <id>         恢復成繼承值（拿掉那一列的 config 覆蓋）

選項：
  --patch <file>            serve 帶的 --patch（可多次，照同樣的順序）。不給就偵測不到被它蓋掉
  --file <路徑|->           config set 的新設定；- 是標準輸入
  --help                    印這段話

每一次變更追加一筆進 $NEXUS_AGENT_HOME/plugin-journal.jsonl（沒設就是 ~/.nexus-agent）；
驗不過被拒絕的變更也記一筆 rejected（不帶要寫入的值），清單不因它改變。
命令參數不收設定值：寫在命令列上，共用主機上的其他人用 ps 看得到。
要新增或移除一列，今天只有 --patch 一條路（不在這個命令的範圍）。`;

/** 輸出的兩個出口。 */
export interface PluginCliPrinter {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/** {@link runPluginCli} 的輸入。 */
export interface PluginCliOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** `--file -` 讀它，省略即 `process.stdin`。 */
  readonly stdin?: () => string | Promise<string>;
  readonly printer?: PluginCliPrinter;
  readonly now?: () => Date;
}

const consolePrinter: PluginCliPrinter = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

class UsageError extends Error {}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface Parsed {
  readonly change:
    PluginChange | { readonly op: 'config-set'; readonly id: string; readonly file: string };
  readonly patches: readonly string[];
}

function parse(argv: readonly string[]): Parsed | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        patch: { type: 'string', multiple: true },
        file: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(
      `${reason}\n命令參數不收設定值：新設定從 --file <路徑|-> 讀。\n\n${PLUGIN_CLI_USAGE}`,
    );
  }
  const { values, positionals } = parsed;
  if (values.help === true) return 'help';
  const patches = values.patch ?? [];
  if (patches.some((patch) => patch.trim() === '')) {
    throw new UsageError(`--patch 要給一個檔案路徑。\n\n${PLUGIN_CLI_USAGE}`);
  }
  const [command, ...rest] = positionals;
  const only = (expected: number, what: string): string[] => {
    if (rest.length !== expected) {
      throw new UsageError(
        `${what} 要給 ${String(expected)} 個位置參數（多給的不收：設定值不能寫在命令列上）。\n\n${PLUGIN_CLI_USAGE}`,
      );
    }
    return rest;
  };
  if (command === 'disable' || command === 'enable') {
    if (values.file !== undefined) {
      throw new UsageError(`--file 只有 config set 用。\n\n${PLUGIN_CLI_USAGE}`);
    }
    const [id] = only(1, command);
    return { change: { op: command, id: id as string }, patches };
  }
  if (command === 'config') {
    const [sub, ...args] = rest;
    if (sub === 'set') {
      if (args.length !== 1) {
        throw new UsageError(
          'config set 要給一個 id（多給的不收：設定值不能寫在命令列上，用 --file <路徑|->）。\n\n' +
            PLUGIN_CLI_USAGE,
        );
      }
      if (values.file === undefined || values.file === '') {
        throw new UsageError(`config set 要用 --file <路徑|-> 給新設定。\n\n${PLUGIN_CLI_USAGE}`);
      }
      return { change: { op: 'config-set', id: args[0] as string, file: values.file }, patches };
    }
    if (sub === 'reset') {
      if (args.length !== 1) {
        throw new UsageError(`config reset 要給一個 id。\n\n${PLUGIN_CLI_USAGE}`);
      }
      if (values.file !== undefined) {
        throw new UsageError(`--file 只有 config set 用。\n\n${PLUGIN_CLI_USAGE}`);
      }
      return { change: { op: 'config-reset', id: args[0] as string }, patches };
    }
  }
  throw new UsageError(`不認得的命令。\n\n${PLUGIN_CLI_USAGE}`);
}

/** 把 `--file` 讀成一張表。 */
async function readConfig(
  file: string,
  stdin: () => string | Promise<string>,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = file === '-' ? await stdin() : readFileSync(file, 'utf8');
  } catch (error) {
    throw new UsageError(`讀不到新設定 ${file}：${String(error)}`);
  }
  let value: unknown;
  try {
    value = parseYaml(text) as unknown;
  } catch (error) {
    // 訊息不帶檔案內容：解析器的錯誤可能引用那一行。
    throw new UsageError(
      `新設定不是合法的 YAML／JSON（${error instanceof Error ? error.name : '解析失敗'}）。`,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError('新設定要是一張表（YAML／JSON 物件），不是純量或陣列。');
  }
  return value as Record<string, unknown>;
}

function describeEffect(result: PluginChangeResult): string {
  switch (result.effect) {
    case 'next-thread':
      return '新對話生效（下一條 thread 起）；開著的對話不變';
    case 'restart':
      return '已儲存，待重啟：這一列在啟動時讀一次，要重啟 serve 才生效';
    case 'overridden':
      return '被 --patch 蓋掉：紀錄已寫入，但清單上的效果不變';
    case undefined:
      return '';
  }
}

/**
 * 跑一次寫入口。
 *
 * @param options - argv、env、輸出。
 * @returns 退出碼：0 成功（含沒有改變任何東西）、1 驗不過或寫不了、2 用法錯。
 */
export async function runPluginCli(options: PluginCliOptions): Promise<number> {
  const printer = options.printer ?? consolePrinter;
  let parsed: Parsed | 'help';
  try {
    parsed = parse(options.argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    printer.error(error.message);
    return 2;
  }
  if (parsed === 'help') {
    printer.log(PLUGIN_CLI_USAGE);
    return 0;
  }
  try {
    const change: PluginChange =
      'file' in parsed.change
        ? {
            op: 'config-set',
            id: parsed.change.id,
            config: await readConfig(parsed.change.file, options.stdin ?? readStdin),
          }
        : parsed.change;
    const result = await changePlugin(change, {
      ...(options.env !== undefined && { env: options.env }),
      ...(parsed.patches.length > 0 && { patches: parsed.patches }),
      ...(options.now !== undefined && { now: options.now }),
    });
    for (const warning of result.warnings) printer.error(`警告：${warning}`);
    if (result.outcome === 'unchanged') {
      printer.log(`沒有寫入：${result.notes.join(' ')}`);
      printer.log(`紀錄檔：${result.path}`);
      return 0;
    }
    const record = result.record;
    if (record === undefined) return 1;
    printer.log(`已寫入 ${result.path}`);
    printer.log(`  第 ${String(record.seq)} 筆  ${record.op}  ${'id' in record ? record.id : ''}`);
    if (record.actor.kind === 'host-account') {
      const { effective, invoker, invokerSource } = record.actor;
      printer.log(
        `  操作者：${effective}` +
          (invoker === null
            ? ''
            : `（sudo 前自報為 ${invoker}，取自環境變數 ${invokerSource ?? '?'}；不是身分認證）`),
      );
    }
    printer.log(
      `  改了：${result.fields.length === 0 ? '（沒有欄位變動）' : result.fields.join('、')}`,
    );
    for (const note of result.notes) printer.log(`  註：${note}`);
    printer.log(`  生效：${describeEffect(result)}`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      printer.error(error.message);
      return 2;
    }
    if (error instanceof PluginChangeRejected) {
      printer.error(`拒絕：${error.message}`);
      printer.error(
        error.seq === undefined
          ? '紀錄沒有動。'
          : `已記成第 ${String(error.seq)} 筆 rejected（操作者、操作、列 id、原因；不含要寫入的值）。清單不變。`,
      );
      return 1;
    }
    printer.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPluginCli({ argv: process.argv.slice(2) });
}
