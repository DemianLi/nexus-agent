import type * as React from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The model's thinking, folded away by default: it explains an answer but is
 * not the answer. While the turn is still thinking with no answer yet, the
 * header says so, so the wait does not look like nothing is happening.
 */
function Reasoning({
  children,
  thinking = false,
  label = "Thought process",
  thinkingLabel = "Thinking…",
  defaultOpen = false,
  trailing,
  className,
}: {
  children: React.ReactNode
  thinking?: boolean
  label?: string
  thinkingLabel?: string
  defaultOpen?: boolean
  trailing?: React.ReactNode
  className?: string
}) {
  return (
    <details data-slot="reasoning" open={defaultOpen || undefined} className={cn("group/reasoning", className)}>
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-muted-foreground transition-colors outline-none select-none hover:text-foreground focus-visible:text-foreground [&::-webkit-details-marker]:hidden">
        <span className={cn(thinking && "status-shimmer")}>{thinking ? thinkingLabel : label}</span>
        {trailing}
        <ChevronRight className="size-3.5 transition-transform group-open/reasoning:rotate-90" />
      </summary>
      <div className="mt-2 border-l-2 border-border pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {children}
      </div>
    </details>
  )
}

export { Reasoning }
