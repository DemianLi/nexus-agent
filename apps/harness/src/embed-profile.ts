/**
 * 嵌入版設定檔（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)，地圖 #2365 第 2、3、10 點）：從 `<nexus-chat>` 來的連線
 * 只能做普通對話。
 *
 * - **怎麼認**：路徑前綴 `EMBED_PATH_PREFIX`（`/embed/threads/…`、`/embed/threads/mux`）。反向代理可以只轉這個前綴。
 * - **綁在 thread 上**：從嵌入版開的 thread 不管之後誰開都照嵌入版組；嵌入連線碰到不是嵌入版開的 thread 一律拒（`thread_not_embedded`）。
 * - **能打的路由與命令是白名單**（{@link EMBED_ROUTE_KINDS}、{@link EMBED_COMMAND_METHODS}）：協定日後多一支命令，嵌入版預設打不到。
 * - **組裝**：不掛子代理（前景的 `task` 與背景的那幾支都不掛），沒有斜線命令，工具照 {@link embedApprovalGate} 要核准。
 *
 * @module
 */

import { EMBED_PATH_PREFIX, THREADS_PATH } from '@nexus/wire';
import type { RpcMethod } from '@nexus/wire';
import type { PreToolListener } from '@nexus/core';

/** 一條 thread 照哪一份設定檔組。`full` 是獨立頁面那一份。 */
export type ThreadProfile = 'full' | 'embed';

/** `/threads` 那一族的路徑。 */
export function isThreadsPath(pathname: string): boolean {
  return pathname === THREADS_PATH || pathname.startsWith(`${THREADS_PATH}/`);
}

/**
 * 去掉嵌入版的前綴。
 *
 * @returns 去掉之後的路徑；不是嵌入版的路徑回 `undefined`。
 */
export function withoutEmbedPrefix(pathname: string): string | undefined {
  return pathname.startsWith(`${EMBED_PATH_PREFIX}/`)
    ? pathname.slice(EMBED_PATH_PREFIX.length)
    : undefined;
}

/** 嵌入版打得到的 thread 路由（`wire-handler.ts` 的 `parsePath` 的 `kind`）。列表、搜尋、全域下行都沒有。 */
export const EMBED_ROUTE_KINDS: ReadonlySet<string> = new Set([
  'stream',
  'history',
  'attachment',
  'command',
]);

/**
 * 嵌入版打得到的命令。對話框只有對話紀錄、輸入框與停止、核准卡與反問、回饋鈕（#2365 第 12 點）。
 *
 * `slash.list`、`skill.list` 在名單上但回空清單：共用的輸入框元件會問，回錯會畫成一則錯誤。`slash.run` 不在，回 `not_supported`。
 */
export const EMBED_COMMAND_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'run.start',
  'run.cancel',
  'input.respond',
  'slash.list',
  'skill.list',
  'feedback.put',
  'feedback.delete',
  'feedback.list',
  'deliverable.read',
  'deliverable.readBytes',
]);

/**
 * 嵌入版不必核准的工具：只讀東西、或只動這條對話自己的狀態，不改對話以外的任何東西。
 *
 * `create_goal`、`update_goal` 不在這裡：目標會讓這條對話自己接著跑下一輪。
 */
export const EMBED_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'ls',
  'read_file',
  'glob',
  'grep',
  'get_goal',
  'todo_write',
  'present',
]);

/** 工具本體自己就會停下來問人的那幾支：再多回一次 `ask`，同一次呼叫會先出核准卡、再出它自己的那張。 */
export const ASKS_THE_HUMAN_ITSELF: ReadonlySet<string> = new Set([
  'ask_user_question',
  'exit_plan_mode',
  'request_sandbox_escalation',
]);

/** 回 `ask` 時給人看的那一句。 */
export function embedApprovalReason(toolName: string): string {
  return `嵌入的對話框裡，工具 ${toolName} 沒標唯讀，要先讓人看過`;
}

/**
 * 嵌入版的核准閘門：沒標唯讀的工具都要人核准（#2365 第 10 點）。**失敗的方向是多問**：唯讀是白名單，日後新增的工具預設被問。
 *
 * MCP 工具交給那一列自己的 `approval`（#1622，D171）：沒寫就整台都問，寫了 `default: allow` 或 `exempt` 就是那一列替自己的工具標了唯讀。
 * 這位不覆蓋它，所以也不放寬它。
 *
 * 只回 `ask` 或 `next()`，**絕不回 `allow`**：不呼叫 `next()` 的 `allow` 會把排在後面的閘門整條吃掉（`approval-gate-order.test.ts`）。
 *
 * @param isMcpTool - 這個工具名是不是 MCP 那一列註冊的。
 */
export function embedApprovalGate(isMcpTool: (name: string) => boolean): PreToolListener {
  return (exec, next) => {
    if (EMBED_READ_ONLY_TOOLS.has(exec.name)) return next();
    if (ASKS_THE_HUMAN_ITSELF.has(exec.name)) return next();
    if (isMcpTool(exec.name)) return next();
    return { kind: 'ask', reason: embedApprovalReason(exec.name) };
  };
}
