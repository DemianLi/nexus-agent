/**
 * 離線掃會話日誌：逐份報出步數、最長的重複呼叫串、工具錯誤依種類各幾次，標出疑似打轉的那幾份。
 * [#268](https://github.com/DemianLi/nexus-agent/issues/268)。進入點是 `sessions-cli.ts` 的 `scan`。
 *
 * ## 為什麼是一支讀檔的腳本
 *
 * dsh 的 `session-stats` 只算次數與耗時（`packages/session/session-stats/src/projection.ts:31`，
 * SHA `c291e79`），**不算錯誤、不算重複**；它的執行期只有 `repeat-tool-reminder` 提醒、不停。
 * 地圖 #263 開圖時拍板：超出標準的評估只做在產品路徑外。所以這裡不是投影、不是 middleware，
 * 是一個讀本機 jsonl 的純函式加一支印報表的進入點。這個檔沒有副作用，進入點只接線——
 * 同 `cli-args.ts` 的理由：帶 top-level `await main()` 的檔 import 不得。
 *
 * ## 「同一個呼叫」只有一份判法
 *
 * 鍵與射程直接用提醒器匯出的 `repeatCallKey`／`repeatReminderTracks`
 * （`packages/nexus-core/src/repeat-reminder.ts`）。**日誌上的 `arguments` 是
 * `JSON.stringify(args)`，不是規範字串**，所以先解析再交給那個鍵——拿原字串比的話，只差屬性
 * 順序的兩次呼叫會被當成兩個。
 *
 * ## 鏈怎麼從事件重算，對到提醒器的哪一條
 *
 * 提醒器從 `state.messages` 推鏈；日誌上沒有訊息，只有事件。逐條對：
 *
 * - **人講話清零 → `turn/start` 的 `message` 與 `goal` 清零。** 續行輪次的頭在提醒器那側也是一則
 *   素的 `HumanMessage`，它清零（`repeat-reminder.ts` 的 `GOAL_WRAPUP_MARKER` 那段說這是對的）。
 * - **`resume` 不清零。** 回覆核准沒有新的人話，會話統計也把它併回前一輪。
 * - **`session/end-seed` 清零。** CLI 的 `--resume` 與 serve 重開之後對話從空的開始（門 B 沒開，
 *   `cli.ts` 的 `--resume` 說明），提醒器那時看到的鏈真的是新的。不清的話，兩個行程的日誌會拼出
 *   一條實際上沒有人看過的長串。
 * - **subagent 那份沒有 `turn/start`**，一份就是一次委派，鏈跨整份。
 * - **同一個 `callId` 第二次出現不推進鏈。** 被核准閘門中斷的那次，resume 之後以同一個 `callId`
 *   再記一顆 `tool/call`（`session-log.ts` 的 `tool/call` 那段）。提醒器數的是 `tool_calls`，那次
 *   呼叫在訊息裡只有一則——這裡不去重的話，每一次核准都會讓鏈多一格。
 *
 * **射程外的工具對鏈透明**（既不計數也不重置），同提醒器。
 *
 * ## 「疑似打轉」的門檻
 *
 * 讀提醒器設定的**第二道門檻**（今天是 5）：模型收過一次提醒還繼續。門檻只設一道的設定表達不出
 * 這句話，當場拋——預設有三道，產品路徑上碰不到。
 *
 * ## 照格式版本表態
 *
 * 見 {@link SESSION_LOG_FORMAT_VERSION} 那一串說明：v5 才有工具事件、v6 才有模型起訖。舊檔的那幾格
 * 是**沒記**不是 0，所以報成 `null`。比這一版新的檔照樣掃，認不得的事件略過並報數——這支腳本
 * 只讀不寫，讀懂多少報多少；續接那條（`SessionStore.resume`）要往下寫，所以它拒絕，兩邊不同是對的。
 *
 * **有一件事版本帶不出來**：#273 之前寫的日誌把 goal、todo、計劃模式、root-only 樁的拒絕記成
 * `isError: false`，而格式版本沒升（`session-log.ts` 的 `tool/result`）。那一段的錯誤數偏低，
 * 逐份分不出來，所以是報表底下每次都印的一句，不是某一份的標記。
 *
 * **另一件版本也帶不出來**：續接過的檔，header 在第一次續寫時被蓋成當時的版本，而續接之前那一段
 * 是舊版寫的。那一段的缺欄會被讀成 0。
 *
 * @module
 */

import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  deriveSessionStats,
  repeatCallKey,
  repeatReminderTracks,
  resolveRepeatReminderSettings,
  SESSION_LOG_FORMAT_VERSION,
} from '@nexus/core';
import type { RepeatReminderSettings, SessionEvent, SessionEventType } from '@nexus/core';
import { parseJsonlSessionBody } from '../jsonl-session-store.js';

/** 沒帶碼的錯誤結果落在這一格。dsh 只替帶碼的錯誤填 `error`，一般拋錯與核准被拒都在這裡。 */
export const UNCODED_ERROR = '無碼';

/** 工具事件從這一版開始記。見 `session-store.ts` 的版本 5。 */
const TOOL_EVENTS_SINCE = 5;
/** 模型起訖從這一版開始記。見 `session-store.ts` 的版本 6。 */
const MODEL_CALLS_SINCE = 6;

/**
 * 這一版認得的事件種類。
 *
 * **型別逼它完整**：詞彙加了一種而這裡沒跟上，typecheck 就紅。不這樣的話，新種類會被當成
 * 「認不得」，而一份完全正常的日誌會報出一串疑似壞檔。
 */
const KNOWN_EVENT_TYPES: Readonly<Record<SessionEventType, true>> = {
  'turn/start': true,
  'turn/end': true,
  'turn/failed': true,
  'interrupt/raised': true,
  'command/run': true,
  'command/done': true,
  'goal/change': true,
  'todo/write': true,
  'model/usage': true,
  'model/start': true,
  'model/end': true,
  'compaction/summary': true,
  'sandbox/mode': true,
  'plan/mode': true,
  'tool/call': true,
  'tool/result': true,
  'session/end-seed': true,
};

/** 一份日誌的身分：從 header 讀出來的那幾格。 */
export interface SessionLogHeader {
  readonly id: string;
  readonly version: number;
  readonly parentSession?: string;
}

/** 讀進來、還沒掃的一份。 */
export interface LoadedSessionLog {
  /** jsonl 的路徑。 */
  readonly file: string;
  readonly header: SessionLogHeader;
  readonly events: readonly SessionEvent[];
}

/** 一段連續的同工具同參數。 */
export interface RepeatRun {
  readonly tool: string;
  readonly count: number;
  /** 最後那一次在日誌上的 `arguments`，原樣。 */
  readonly arguments: string;
}

/** 一份日誌掃出來的東西。**`null` 是這一版格式沒記，不是 0。** */
export interface SessionScan {
  readonly file: string;
  readonly sessionId: string;
  readonly parentSession?: string;
  readonly version: number;
  /** 模型呼叫次數（`deriveSessionStats` 的 `steps`）。 */
  readonly steps: number | null;
  /** 工具呼叫次數，同一個 `callId` 只算一次。 */
  readonly toolCalls: number | null;
  /** 最長的那一段；一次受追蹤的呼叫都沒有時是 `null`。 */
  readonly longestRun: RepeatRun | null;
  /** 錯誤結果依碼分，沒碼的在 {@link UNCODED_ERROR}。 */
  readonly errors: Readonly<Record<string, number>> | null;
  /** 最長那段到了打轉門檻。工具事件沒記時是 `null`。 */
  readonly looping: boolean | null;
  /** 認不得而略過的事件顆數。 */
  readonly unknownEvents: number;
}

/** 讀得到但讀不懂的那一份。 */
export interface UnreadableSessionLog {
  readonly file: string;
  readonly reason: string;
}

/** 讀提醒器的第二道門檻。見檔頭「疑似打轉」的門檻。 */
export function loopingThreshold(settings: RepeatReminderSettings): number {
  const second = settings.thresholds[1];
  if (second === undefined) {
    throw new Error(
      `提醒器只設了一道門檻（${JSON.stringify(settings.thresholds)}），「收過一次提醒還繼續」` +
        '沒有第二道可讀。',
    );
  }
  return second;
}

/** 日誌上的 `arguments` 解回參數。解不動就原字串——生產者寫的是 `JSON.stringify`，碰不到。 */
function parseArguments(serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return serialized;
  }
}

/**
 * 掃一份。
 *
 * @param log - 讀進來的那一份。
 * @param override - 提醒器設定要蓋上去的格子，省略即產品路徑上的預設。
 * @returns 那一份的數字。
 * @throws 設定不合法，或只有一道門檻。
 */
export function scanSessionLog(
  log: LoadedSessionLog,
  override?: Partial<RepeatReminderSettings>,
): SessionScan {
  const settings = resolveRepeatReminderSettings(override);
  const threshold = loopingThreshold(settings);
  const tracks = repeatReminderTracks(settings);

  const known = log.events.filter((event) => Object.hasOwn(KNOWN_EVENT_TYPES, event.type));
  const seenCalls = new Set<string>();
  // 鍵是從檔上讀來的碼，不能有原型：`constructor` 這種碼會讀到繼承來的函式，數字變成字串。
  // 同 `session-stats.ts` 對 `callId` 的 `Object.hasOwn`。
  const errors = Object.create(null) as Record<string, number>;
  let toolCalls = 0;
  let chain: (RepeatRun & { readonly key: string }) | undefined;
  let longest: RepeatRun | null = null;

  for (const event of known) {
    switch (event.type) {
      case 'turn/start':
        if (event.data.kind !== 'resume') chain = undefined;
        break;
      case 'session/end-seed':
        chain = undefined;
        break;
      case 'tool/call': {
        const { callId, name } = event.data;
        if (seenCalls.has(callId)) break;
        seenCalls.add(callId);
        toolCalls += 1;
        if (!tracks(name)) break;
        const key = repeatCallKey(name, parseArguments(event.data.arguments));
        const count = chain?.key === key ? chain.count + 1 : 1;
        chain = { key, tool: name, count, arguments: event.data.arguments };
        if (longest === null || count > longest.count) {
          longest = { tool: name, count, arguments: event.data.arguments };
        }
        break;
      }
      case 'tool/result': {
        if (!event.data.isError) break;
        const kind = event.data.error?.code ?? UNCODED_ERROR;
        errors[kind] = (errors[kind] ?? 0) + 1;
        break;
      }
      default:
        break;
    }
  }

  const { version } = log.header;
  const hasToolEvents = version >= TOOL_EVENTS_SINCE;
  const finalLongest: RepeatRun | null = longest;
  return {
    file: log.file,
    sessionId: log.header.id,
    ...(log.header.parentSession !== undefined && { parentSession: log.header.parentSession }),
    version,
    steps: version >= MODEL_CALLS_SINCE ? deriveSessionStats(known).steps : null,
    toolCalls: hasToolEvents ? toolCalls : null,
    longestRun: hasToolEvents ? finalLongest : null,
    errors: hasToolEvents ? errors : null,
    looping: hasToolEvents ? finalLongest !== null && finalLongest.count >= threshold : null,
    unknownEvents: log.events.length - known.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 讀 header 裡掃描要的那幾格。**版本比這一版新不拒絕**，見檔頭「照格式版本表態」。 */
function parseHeader(text: string): SessionLogHeader | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'header 不是 JSON';
  }
  if (!isRecord(value)) return 'header 不是一個物件';
  const { id, version, parentSession } = value;
  if (typeof id !== 'string') return 'header 沒有 id';
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return `header 的 version 是 ${JSON.stringify(version)}`;
  }
  return {
    id,
    version,
    ...(typeof parentSession === 'string' && { parentSession }),
  };
}

const HEADER_SUFFIX = '.header.json';
const LOG_SUFFIX = '.jsonl';

/**
 * 從幾個根目錄往下找每一份日誌讀進來。**唯讀**：不拿租約、不截尾巴、不改 header。
 *
 * 認的是 JSONL 後端的檔名（`<base>.header.json` 配 `<base>.jsonl`，`jsonl-session-store.ts`），
 * 所以 CLI 的 run 目錄與 serve 的 `<根>/<projectKey>/` 都掃得到，給會話根就一次全掃。
 * 只有 header 沒有日誌的是「還沒寫第一筆就當了」，讀成零顆事件。
 *
 * @param roots - 會話根、run 目錄或 projectKey 那一格，都行。
 * @returns 讀得懂的，與讀得到但讀不懂的（壞行、缺號、header 壞了）。後者不擋其餘的。
 * @throws 某個根讀不到（不存在、不是目錄）。
 */
export async function readSessionLogs(roots: readonly string[]): Promise<{
  readonly logs: readonly LoadedSessionLog[];
  readonly unreadable: readonly UnreadableSessionLog[];
}> {
  const logs: LoadedSessionLog[] = [];
  const unreadable: UnreadableSessionLog[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(HEADER_SUFFIX)) continue;
      const file = `${path.slice(0, -HEADER_SUFFIX.length)}${LOG_SUFFIX}`;
      const header = parseHeader(await readFile(path, 'utf8'));
      if (typeof header === 'string') {
        unreadable.push({ file, reason: header });
        continue;
      }
      let body = '';
      try {
        body = await readFile(file, 'utf8');
      } catch (error: unknown) {
        if ((error as { code?: unknown } | null)?.code !== 'ENOENT') throw error;
      }
      try {
        logs.push({ file, header, events: parseJsonlSessionBody(header.id, body).events });
      } catch (error: unknown) {
        unreadable.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  for (const root of roots) await visit(root);
  return { logs, unreadable };
}

/** 報表上一個錯誤分佈的寫法。 */
function formatErrors(errors: Readonly<Record<string, number>>): string {
  const entries = Object.entries(errors).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? '0' : entries.map(([kind, n]) => `${kind}×${n}`).join(' ');
}

/** 引用參數的上限。報表是給人掃的，完整的參數在日誌裡。 */
const ARGUMENTS_PREVIEW = 80;

function preview(text: string): string {
  return text.length <= ARGUMENTS_PREVIEW ? text : `${text.slice(0, ARGUMENTS_PREVIEW)}…`;
}

/**
 * 印成給人看的報表。疑似打轉的排前面，其餘照路徑。
 *
 * @param scans - 每一份的結果。
 * @param unreadable - 讀不懂的那幾份。
 * @param options - `threshold` 印在標題上；`base` 給了就把它底下的路徑印成相對的，落在它外面的
 *   照印絕對路徑（一串 `../` 比絕對路徑難讀）。
 * @returns 整份報表，一行一個元素。
 */
export function formatScanReport(
  scans: readonly SessionScan[],
  unreadable: readonly UnreadableSessionLog[],
  options: { readonly threshold: number; readonly base?: string },
): readonly string[] {
  const shown = (file: string): string => {
    if (options.base === undefined) return file;
    const inside = relative(options.base, file);
    return inside.startsWith('..') || isAbsolute(inside) ? file : inside;
  };
  const ordered = [...scans].sort(
    (a, b) =>
      Number(b.looping === true) - Number(a.looping === true) || a.file.localeCompare(b.file),
  );
  const flagged = scans.filter((scan) => scan.looping === true).length;

  const lines: string[] = [
    `會話掃描：${scans.length} 份日誌，疑似打轉 ${flagged} 份` +
      `（同工具同參數連續 ${options.threshold} 次＝提醒器的第二道門檻）`,
  ];
  for (const scan of ordered) {
    const tag = scan.looping === true ? '[疑似打轉] ' : '';
    const parent = scan.parentSession === undefined ? '' : `（上層 ${scan.parentSession}）`;
    lines.push('', `${tag}${scan.sessionId}${parent}  ${shown(scan.file)}`);
    const run =
      scan.longestRun === null
        ? '—'
        : `${scan.longestRun.tool} × ${scan.longestRun.count} ${preview(scan.longestRun.arguments)}`;
    lines.push(
      `  步數 ${scan.steps ?? '—'} ｜工具呼叫 ${scan.toolCalls ?? '—'} ｜最長重複 ${run}`,
      `  工具錯誤 ${scan.errors === null ? '—' : formatErrors(scan.errors)}`,
    );
    if (scan.version < MODEL_CALLS_SINCE) {
      lines.push(
        `  格式版本 ${scan.version}：` +
          (scan.version < TOOL_EVENTS_SINCE
            ? `第 ${TOOL_EVENTS_SINCE} 版才記工具事件、第 ${MODEL_CALLS_SINCE} 版才記模型起訖，`
            : `第 ${MODEL_CALLS_SINCE} 版才記模型起訖，`) +
          '「—」是沒記，不是 0。',
      );
    }
    if (scan.unknownEvents > 0) {
      lines.push(
        scan.version > SESSION_LOG_FORMAT_VERSION
          ? `  格式版本 ${scan.version} 比這一版（${SESSION_LOG_FORMAT_VERSION}）新：` +
              `${scan.unknownEvents} 顆認不得的事件略過了，上面的數字可能不全。`
          : `  ${scan.unknownEvents} 顆認不得的事件略過了——格式版本 ${scan.version} 的詞彙` +
              '這一版都認得，檔案可能被別的東西寫過。',
      );
    }
  }
  if (unreadable.length > 0) {
    lines.push('', `讀不懂的 ${unreadable.length} 份（其餘照掃）：`);
    for (const entry of unreadable) lines.push(`  ${shown(entry.file)}：${entry.reason}`);
  }
  lines.push(
    '',
    '注意：步數與工具欄是逐份的，subagent 的在它自己那份。',
    '注意：#273（2026-09-12）之前寫的日誌把 goal、todo、計劃模式、root-only 樁的拒絕記成成功，' +
      '格式版本沒升、逐份分不出來——那一段的工具錯誤數偏低。',
  );
  return lines;
}
