/**
 * nexus 層（#1683）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/reasoning.tsx`），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」，這個檔有一條（第 69 條）：
 *
 * - 預設的字換成中文（§8）：vendor 是 "Thought process"／"Thinking…"，這裡是「思考過程」「思考中」。只補預設值、不必複製上游
 *   標記，所以走包裝層（同第 26、60 條）；呼叫端給了就照用。
 *
 * 改 vendor 檔的有兩條（第 67、68 條：`0020` node-children、`0021` trailing），覆寫檔擴了兩條（第 63 條 1024 以下 44px、
 * 第 64 條減少動態時箭頭不轉場）、新增一條（第 70 條：summary 不超出欄寬、標題不被長摘要擠到折行）。
 */
import type * as React from 'react';

import { Reasoning as VendorReasoning } from '@/vendor/solid-glass/components/ui/reasoning';

/** 標題的預設字：講完是 `label`，還在想是 `thinkingLabel`。 */
export const REASONING_LABELS = { label: '思考過程', thinkingLabel: '思考中' } as const;

function Reasoning({
  label = REASONING_LABELS.label,
  thinkingLabel = REASONING_LABELS.thinkingLabel,
  ...props
}: React.ComponentProps<typeof VendorReasoning>) {
  return <VendorReasoning label={label} thinkingLabel={thinkingLabel} {...props} />;
}

export { Reasoning };
