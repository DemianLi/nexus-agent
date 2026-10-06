/** 觀測分頁一輪的標頭：第幾輪、種類，以及一輪的數字（時刻、耗時、結束狀態、呼叫、工具、重試、token）。 */

import type { TurnHead } from '@/lib/trace-view';
import {
  TURN_END_LABEL,
  TURN_KIND_LABEL,
  clockText,
  durationText,
  failureCodeText,
  tokenText,
} from '@/lib/trajectory-view';

/** 停在中斷點的那一輪，標頭的結束狀態寫它停在哪，不寫「完成」。「停在核准點」與成本分頁同一句。 */
export const TRACE_WAITING_LABEL: Readonly<Record<NonNullable<TurnHead['waiting']>, string>> = {
  approval: '停在核准點',
  question: '停在提問',
};

/**
 * 一輪怎麼收的。停在中斷點寫它停在哪；失敗而且日誌帶了碼，寫「失敗（額度用盡）」，原碼放在 `title` 與 `data-failure-code`；
 * 沒帶碼（舊日誌）就只寫「失敗」，不補「原因不明」。
 */
function EndFact({ head }: { head: TurnHead }) {
  if (head.waiting !== undefined) {
    return <span data-testid="trace-head-waiting">{TRACE_WAITING_LABEL[head.waiting]}</span>;
  }
  if (head.end === undefined) return <span>進行中</span>;
  if (head.end === 'failed' && head.failureCode !== undefined) {
    return (
      <span
        data-testid="trace-head-failure"
        data-failure-code={head.failureCode}
        title={head.failureCode}
      >
        {TURN_END_LABEL.failed}（{failureCodeText(head.failureCode)}）
      </span>
    );
  }
  return <span>{TURN_END_LABEL[head.end]}</span>;
}

/** 一輪的數字（呼叫、工具、重試、token）；摺掉的部分仍算在計數裡，所以另外講。 */
export function HeadFacts({ head, noEnd = false }: { head: TurnHead; noEnd?: boolean }) {
  return (
    <>
      <span>{clockText(head.time)}</span>
      {!noEnd && <span>耗時 {durationText(head.durationMs)}</span>}
      {!noEnd && <EndFact head={head} />}
      <span>{head.callCount} 次呼叫</span>
      <span>
        {head.toolCount} 個工具
        {head.toolErrors > 0 && `（${head.toolErrors} 個失敗）`}
      </span>
      {head.subagentCount > 0 && (
        <span data-testid="trace-subagent-count">{head.subagentCount} 個子代理</span>
      )}
      {head.retryCount > 0 && <span>重試 {head.retryCount} 次</span>}
      <span>
        輸入 {tokenText(head.inputTokens)}／輸出 {tokenText(head.outputTokens)}
      </span>
    </>
  );
}

export function TurnHeader({ head }: { head: TurnHead }) {
  return (
    <header className="px-2 pt-1 pb-1" data-testid="trace-turn-head">
      <h3
        className="text-foreground text-sm font-medium outline-none"
        // 成本分頁的「看這一輪」把焦點交到這裡（`reveal`）；平常不在 Tab 順序裡。
        data-reveal-target=""
        tabIndex={-1}
      >
        第 {head.number} 輪
        <span className="text-muted-foreground ml-2 text-xs font-normal">
          {TURN_KIND_LABEL[head.kind]}
        </span>
      </h3>
      <p className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
        <HeadFacts head={head} />
      </p>
      {head.elidedCalls !== undefined && (
        <p className="text-muted-foreground text-xs" data-testid="trace-elided">
          另有 {head.elidedCalls} 次呼叫已摺掉
          {head.elidedTools !== undefined && `、${head.elidedTools} 個工具已摺掉`}
          ，上面的計數仍包含它們。
        </p>
      )}
    </header>
  );
}
