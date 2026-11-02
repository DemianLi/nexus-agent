import { useMemo } from 'react';
import type { ReactNode } from 'react';

import type { ConversationEntry } from '@nexus/wire';

import { MessageScrollerItem } from '@/components/ui/message-scroller';
import { StepGroup } from '@/components/ui/tool-steps';
import type { Step } from '@/components/ui/tool-steps';
import type { ToolRunItem } from '@/lib/tool-runs';
import { toolRunLabel, toolRunSummary } from '@/lib/tool-runs';
import { toolDiffView } from '@/lib/tool-diff';
import { toolTitle } from '@/lib/tool-view';

/**
 * 收起來的一段工具呼叫（[#1309](https://github.com/DemianLi/nexus-agent/issues/1309)）：SG 的 `StepGroup`（#1682，地圖 #1497 第 ④ 步）。
 * 收著是一列「N 個工具呼叫，讀取 ×7、寫入檔案」，點開才是原本的工具卡與夾在中間的思考，順序不變。哪些收、哪些切開見 `lib/tool-runs.ts`。
 *
 * - 收著那一列照 SG（`StepGroup` 的按鈕，帶 `aria-expanded`）。摘要是純字串、會被報讀，所以用「，」接、不用「·」。
 *   不開 live region：段長大時列上的數字跟著變，不唸。
 * - **展開由呼叫端控制**（patch `0017`）：從觀測分頁「在對話裡定位」進來時要同步打開（`transcript.tsx` 的 `flushSync`）。
 *   SG 沒有展開動效，所以定位進來的那一次也不必另外關掉動畫。
 * - **打開後的列由這裡給**（patch `0018`，`StepList` 的 children 各包一格）：**每一則照樣是一格 `MessageScrollerItem`**
 *   （巢在這一格裡），捲動與「在對話裡定位」都用條目 id（`data-message-id`）找，收進來之後照樣找得到；思考列照樣夾在原位。
 * - `steps` 只給 SG 數顆數、判斷有沒有在跑、算合計：段裡只收完成的工具（`lib/tool-runs.ts`），所以一律 `done`；摘要由這裡給，不用 SG 的字。
 *   寫檔／改檔帶 `patch`（#1685 B），SG 把整段的 +N −M 加總畫在收著那一列。patch 是 `toolDiffView` 以條目為鍵記住的那一個，跟段裡那張工具卡同一個實例。
 * - **SG 只有一步、沒在跑時退化成單獨一列，`children`、`trailing`、`open` 都不轉過去**：段至少兩顆（`MIN_TOOLS`，有測試釘住）。
 * - 只有思考、沒有思考文字的那一步畫出空的 item，SG 包的那一格照樣有 padding：由覆寫檔第 66 條藏掉（vendor README 本地修改）。
 */
export function ToolRun({
  run,
  open,
  onOpenChange,
  renderEntry,
}: {
  run: ToolRunItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  renderEntry: (entry: ConversationEntry) => ReactNode;
}) {
  const steps = useMemo(
    () =>
      run.tools.map((tool): Step => {
        const diff = toolDiffView(tool);
        return {
          id: tool.id,
          label: toolTitle(tool.name),
          status: 'done',
          ...(diff === undefined ? {} : { patch: diff.patch }),
        };
      }),
    [run.tools],
  );
  return (
    <div data-testid="tool-run">
      <StepGroup
        steps={steps}
        summary={`${toolRunLabel(run.tools.length)}，${toolRunSummary(run.tools)}`}
        open={open}
        onOpenChange={onOpenChange}
      >
        {run.entries.map((entry) => (
          <MessageScrollerItem key={entry.id} messageId={entry.id} className="empty:hidden">
            {renderEntry(entry)}
          </MessageScrollerItem>
        ))}
      </StepGroup>
    </div>
  );
}
