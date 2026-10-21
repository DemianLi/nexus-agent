/**
 * MCP 那一列的核准宣告（[#1622](https://github.com/DemianLi/nexus-agent/issues/1622)）：哪些工具要先讓人看過。
 *
 * 宣告寫在那一列的 `approval`，由一位 pre-execute listener 讀，經 `registry.approvals.gate()` 登記進核准 waterfall。
 * 閘門**只回 `ask` 或 `next()`**；回 `ask` 之後的事（政策 never、沒有管道、背景子代理、人按不允許）全在 core 的
 * `nexusApprovalGate` 中介層，碼也沿用那裡的 `APPROVAL_*`。**絕不回 `allow`**：不呼叫 `next()` 的 `allow` 會把排在後面的
 * 閘門整條吃掉（`apps/harness/src/approval-gate-order.test.ts` 釘著）。
 *
 * ## 形狀
 *
 * - `default`：`ask`（預設）這台的工具都要人核准；`allow` 都不問。
 * - `exempt`：`default: ask` 時免問的工具，寫 **server 自己公告的名字（raw name）**，只收精確名字。
 *
 * **失敗的方向都是多問**：`exempt` 打錯字，那一支照樣被問；server 下一次組裝多出新工具，新工具照 `default` 被問。反過來的形狀
 * （列「要問」的工具）在這兩種情況都會靜靜放行寫入，所以不採用（#1622 Q1 (a)）。比對用 raw name：模型看到的 public name 可能被
 * 換字、補指紋（`names.ts`），寫設定的人對不上。
 *
 * ## 偏離 dsh
 *
 * **偏離 2（理由 2，產品需求超出 dsh 的射程）**：dsh 的 mcp-client 沒有核准宣告，MCP 工具沒有人回 `ask`。我們的產品是企業內部的
 * 業務輔助機器人，內部系統的寫入全走 MCP，「哪台、哪幾支要人看過」是部署方的業務判斷，要能寫在設定裡。最接近的 dsh 做法是
 * `hooks-claude-code`（每次呼叫起一支外部指令、比對模型面的工具名、行程級一份設定），不照搬，理由見 #1622。**補了什麼**：宣告寫在
 * MCP 那一列、用 raw name 比對；閘門只回 `ask` 或 `next()`，其餘全走現成的 waterfall 與中介層。日後要比對樣式，語意照抄 dsh 的
 * matcher（Q4）。
 *
 * **偏離 3（理由 2，#1622 Q2 (a)）**：沒寫 `approval` 等同 `default: ask`，整台都問。dsh 的 MCP 工具預設一律放行（鏈底 `allow`）。
 * 寫入全走 MCP，部署方忘了寫宣告時，結果應該是多問一次，不是寫入沒經過人。唯讀的 server 明寫 `approval: { default: allow }`，
 * 就回到 dsh 的行為。
 *
 * **機制本身不算偏離**：MCP 還在相容層，閘門直接掛 `registry.approvals.gate()`，這條 waterfall 的形狀照 dsh 的
 * `tools/pre-execute`（core `approval.ts` 檔頭）。遷上樹之後改用 `tools.gate()`，宣告形狀不變。
 *
 * **不讀 MCP 的 tool annotations**（Q3 (a)）：SDK 說明寫明那些只是 hint，client 不該依不受信任的 server 給的 annotations 做決定。
 *
 * @module
 */

import type { PreToolListener } from '@nexus/core';
import { z } from 'zod';

/** 這一列的核准宣告。 */
export const mcpApprovalSchema = z
  .strictObject({
    /** `ask`：這台的工具都要人核准；`allow`：都不問。省略即 `ask`（#1622 Q2 (a)）。 */
    default: z.enum(['ask', 'allow']).default('ask'),
    /** `default: ask` 時免問的工具：server 自己公告的名字，精確比對。 */
    exempt: z.array(z.string().min(1)).optional(),
  })
  .superRefine((approval, ctx) => {
    // 寫了就算，空陣列也算：這組寫法沒有意義，而且看起來像「只問這幾支」，會讓人以為有在擋。
    if (approval.default === 'allow' && approval.exempt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['exempt'],
        message:
          'default 是 allow 時不能寫 exempt：allow 已經整台都不問。要「只問這幾支」做不到，請改成 default: ask，再把不用問的列進 exempt',
      });
    }
  });

/** 驗過的核准宣告。 */
export type McpApproval = z.infer<typeof mcpApprovalSchema>;

/**
 * 建這一列的閘門。
 *
 * @param serverName - 這一台 server 的命名空間，進 `reason`。
 * @param approval - 驗過的宣告。
 * @param rawNameOf - 這一列註冊的工具：public name → raw name。不在表上的工具不是這一列的，一律 `next()`。
 * @returns 要登記的 listener；`default: allow`、或 `tools/list` 一支都沒列出時是 `undefined`（不登記：沒有工具可擋）。
 */
export function mcpApprovalGate(
  serverName: string,
  approval: McpApproval,
  rawNameOf: ReadonlyMap<string, string>,
): PreToolListener | undefined {
  if (approval.default === 'allow' || rawNameOf.size === 0) return undefined;
  const exempt = new Set(approval.exempt ?? []);
  return (exec, next) => {
    const rawName = rawNameOf.get(exec.name);
    if (rawName === undefined || exempt.has(rawName)) return next();
    return { kind: 'ask', reason: approvalReason(serverName, rawName) };
  };
}

/**
 * 給人看的理由：寫 server 名與 raw name。被補了指紋的 public name 人看不懂。
 *
 * @param serverName - server 的命名空間。
 * @param rawName - server 自己公告的工具名。
 * @returns 進 `approval/asked` 與回絕文字的那一句。
 */
export function approvalReason(serverName: string, rawName: string): string {
  return `MCP server ${serverName} 的工具 ${rawName} 要先讓人看過（設定 approval）`;
}

/**
 * `exempt` 裡 `tools/list` 沒列出的名字。只拿來警告：server 換版本後工具清單本來就會變，而這個錯的方向是多問。
 *
 * @param approval - 驗過的宣告。
 * @param rawNames - 這一次 `tools/list` 列出的 raw name。
 * @returns 沒對到的名字，照宣告順序。
 */
export function unknownExempt(approval: McpApproval, rawNames: Iterable<string>): string[] {
  const listed = new Set(rawNames);
  return (approval.exempt ?? []).filter((name) => !listed.has(name));
}
