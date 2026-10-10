/**
 * 一輪裡連續完成的工具呼叫收成一列（[#1309](https://github.com/DemianLi/nexus-agent/issues/1309)，比對文件 C8）。
 *
 * 查多個內部系統時一輪會冒出一長串工具卡，人在意的是答案。**只收全部已完成的連續段**：
 *
 * - **可收的工具**：成功完成（`done`）。停在提問或核准點上被停止的卡是 `failed`（`question-view.ts` 的 `endedWithoutAnswer`），
 *   自然不收。以下幾種即使完成了也不收：
 *   - 計劃卡：另一種卡，計劃本身是要人看的。
 *   - 提問卡（[#1327](https://github.com/DemianLi/nexus-agent/issues/1327)）：本地那一則答案 `transcriptItems` 拿掉了，人選了什麼
 *     只寫在這張卡上，收起來等於把人說的話藏進折疊裡。MCP server 的反問（elicitation，#1098）走提問面板、掛在 MCP 工具上，
 *     答案不畫在任何一張卡上（`pairAnswers` 只配 `ask_user_question`），沒有同樣的問題。
 *   - 背景委派卡：工具早就 `done`，子代理還在跑，卡上有對它說話與停止。
 *   - 交付卡（`present`）：卡上列的是交給人的檔案，收起來等於把交付物藏起來。工具結果在卡上畫圖片或附件的，查過目前沒有
 *     （`tool/card.tsx`、`tool/result.tsx` 沒有 `<img>`）。
 *
 *   **不收不等於跳過**：它們跟執行中的卡一樣，把前後切成兩段。
 * - **透明的**：只有思考、沒有正文的那一步（推理模型每一步工具前都有一列思考，算切斷的話永遠收不起來——真模型一輪八顆工具，
 *   列表是「思考、工具」交替八次）。它跟著收進去，但不算工具數。答案條目在 `transcriptItems` 就拿掉了，不會夾在中間。
 * - **其餘一律切開**：有字的回覆、串流中的、停止或出錯的回覆、人的話、核准決定、通知，以及執行中、等你回答、失敗、停止的卡
 *   （帶邊框光的那顆一定是執行中的）。
 * - 段首的思考留在段內（它是第一顆工具那一步的思考）；段尾的透明條目剪掉、留在段外（例如接著失敗那一步的思考）。
 * - 工具不到 {@link MIN_TOOLS} 顆不收。
 *
 * 判斷全在這一檔，規則要改只改這裡。
 *
 * @module
 */

import type { ConversationEntry, ToolEntry } from '@nexus/wire';
import { DELEGATION_TOOL_NAMES, isBackgroundSubagentMeta } from '@nexus/wire';

import type { TranscriptItem } from '@/lib/deliverables-view';
import { EXIT_PLAN_MODE } from '@/lib/plan-review';
import { PRESENT } from '@/lib/present-view';
import { ASK_USER_QUESTION } from '@/lib/question-view';
import { toolTitle } from '@/lib/tool-view';

/** 一段至少幾顆工具才收。 */
export const MIN_TOOLS = 2;

/** 收起來的一段。`id` 不沿用條目 id：段裡每一則還是用自己的 id 登記捲動與定位。 */
export interface ToolRunItem {
  readonly kind: 'tool-run';
  readonly id: string;
  readonly entries: readonly ConversationEntry[];
  readonly tools: readonly ToolEntry[];
}

export type GroupedItem = TranscriptItem | ToolRunItem;

/** 群組 id：`tools:<段首條目的 id>`。 */
export function toolRunId(firstEntryId: string): string {
  return `tools:${firstEntryId}`;
}

function collapsibleTool(entry: ToolEntry): boolean {
  if (entry.status !== 'done') return false;
  if (entry.name === EXIT_PLAN_MODE || entry.name === PRESENT || entry.name === ASK_USER_QUESTION) {
    return false;
  }
  if (DELEGATION_TOOL_NAMES.includes(entry.name) && isBackgroundSubagentMeta(entry.meta)) {
    return false;
  }
  return true;
}

/** 跟著收進去、但不算數的：只有思考的那一步。 */
function transparent(entry: ConversationEntry): boolean {
  return (
    entry.kind === 'ai' &&
    entry.text.trim() === '' &&
    !entry.streaming &&
    entry.stopped !== true &&
    entry.maxTokens !== true &&
    entry.error === undefined
  );
}

/** 把連續完成的工具（連同夾在中間的思考）收成 {@link ToolRunItem}；其餘原樣。 */
export function groupToolRuns(items: readonly TranscriptItem[]): GroupedItem[] {
  const out: GroupedItem[] = [];
  let run: TranscriptItem[] = [];
  const flush = () => {
    // 段尾的透明條目留在段外。
    let end = run.length;
    while (end > 0) {
      const last = run[end - 1]!;
      if (last.kind === 'entry' && last.entry.kind === 'tool') break;
      end -= 1;
    }
    const body = run.slice(0, end);
    const tools = body.flatMap((item) =>
      item.kind === 'entry' && item.entry.kind === 'tool' ? [item.entry] : [],
    );
    if (tools.length >= MIN_TOOLS) {
      out.push({
        kind: 'tool-run',
        id: toolRunId(body[0]!.id),
        entries: body.flatMap((item) => (item.kind === 'entry' ? [item.entry] : [])),
        tools,
      });
      out.push(...run.slice(end));
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const item of items) {
    const member =
      item.kind === 'entry' &&
      (item.entry.kind === 'tool' ? collapsibleTool(item.entry) : transparent(item.entry));
    if (member) {
      run.push(item);
    } else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

/** 收起來那一列的工具摘要：照第一次出現的順序，同名的併起來寫次數，例如「讀取 ×7、寫入檔案」。 */
export function toolRunSummary(tools: readonly ToolEntry[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const title = toolTitle(tool.name);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return [...counts]
    .map(([title, count]) => (count === 1 ? title : `${title} ×${count}`))
    .join('、');
}

/** 收起來那一列的主文字。 */
export function toolRunLabel(count: number): string {
  return `${count} 個工具呼叫`;
}

/** 這一則落在哪一段收起來的裡面；不在任何一段裡是 `undefined`。 */
export function toolRunOf(items: readonly GroupedItem[], entryId: string): string | undefined {
  for (const item of items) {
    if (item.kind === 'tool-run' && item.entries.some((entry) => entry.id === entryId)) {
      return item.id;
    }
  }
  return undefined;
}
