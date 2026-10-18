/**
 * nexus 層（#1682）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/tool-steps.tsx`），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」，這個檔有一條（第 60 條）：
 *
 * - 預設的字換成中文（§8）：明細框的標題（vendor 是 "Input"／"Output"／"Error"）與群組收著那一列（vendor 是
 *   "Running N steps"／"Ran N steps"）。只補預設值、不必複製上游標記，所以走包裝層（同第 26、45 條）；呼叫端給了就照用。
 *   群組那一列不用「·」接：它是純字串、會被報讀。
 *
 * 改 vendor 檔的有四條（第 56–59 條：`0016` strict-index、`0017` controlled-open、`0018` slots、`0019` output-focus），
 * 覆寫檔另有四條（第 61–64 條：執行中不閃、結果框的焦點外框、1024 以下 44px、減少動態時箭頭不轉場）。
 */
import type * as React from 'react';

import {
  StepGroup as VendorStepGroup,
  StepList as VendorStepList,
  StepRow as VendorStepRow,
} from '@/vendor/solid-glass/components/ui/tool-steps';

export { OutputBlock } from '@/vendor/solid-glass/components/ui/tool-steps';
export type { Step } from '@/vendor/solid-glass/components/ui/tool-steps';

/** 明細框的標題：呼叫端只給一部分時，其餘照這裡的。 */
export const STEP_LABELS = { detail: '參數', output: '結果', error: '錯誤' } as const;

/** 群組收著那一列的預設字。 */
export function stepGroupSummary(count: number, running: boolean): string {
  return running ? `${count} 個工具呼叫，執行中` : `${count} 個工具呼叫`;
}

function StepRow({ labels, ...props }: React.ComponentProps<typeof VendorStepRow>) {
  return <VendorStepRow labels={{ ...STEP_LABELS, ...labels }} {...props} />;
}

function StepList({ labels, ...props }: React.ComponentProps<typeof VendorStepList>) {
  return <VendorStepList labels={{ ...STEP_LABELS, ...labels }} {...props} />;
}

function StepGroup({ labels, summary, steps, ...props }: React.ComponentProps<typeof VendorStepGroup>) {
  const running = steps.some((step) => step.status === 'running');
  return (
    <VendorStepGroup
      steps={steps}
      labels={{ ...STEP_LABELS, ...labels }}
      summary={summary ?? stepGroupSummary(steps.length, running)}
      {...props}
    />
  );
}

export { StepGroup, StepList, StepRow };
