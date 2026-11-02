/** 觀測分頁一輪的標頭：第幾輪、種類，以及一輪的數字（時刻、耗時、結束狀態、呼叫、工具、重試、token）。 */

import { Badge } from '@/components/ui/badge';
import { DotLoader } from '@/components/ui/dot-loader';
import { stoppedByTurnClock } from '@/lib/stop-cause';
import { ENDING_LABEL } from '@/lib/trace-view';
import type { TurnHead } from '@/lib/trace-view';
import {
  TURN_END_LABEL,
  TURN_KIND_LABEL,
  clockText,
  durationText,
  failureCodeText,
  tokenParts,
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
  if (head.end === 'aborted' && stoppedByTurnClock(head.endCause)) {
    return <span>{ENDING_LABEL['timed-out']}</span>;
  }
  return <span>{TURN_END_LABEL[head.end]}</span>;
}

type EndTone = 'done' | 'waiting' | 'failed' | 'running' | 'neutral';

function endToneOf(head: TurnHead): EndTone {
  if (head.waiting !== undefined) return 'waiting';
  if (head.end === undefined) return 'running';
  if (head.end === 'completed') return 'done';
  if (head.end === 'failed') return 'failed';
  return 'neutral';
}

const END_TONE_DOT: Readonly<Partial<Record<EndTone, string>>> = {
  done: 'bg-status-done',
  waiting: 'bg-status-interrupted',
};

/**
 * 狀態膠囊（#1690 T8）：字一律是膠囊的前景色，色調畫在字前面的小圓點上：完成 `status-done`、停在中斷點（等核准或回答，#1468 Q14 的
 * 「需要你處理」）`status-interrupted`；進行中換成 `DotLoader`；失敗是 SG 的 `destructive` 膠囊；其餘收法沒有點，只靠字。
 * 圓點是非文字，門檻 3。不用 `default`：SG 把 `default` 膠囊畫成實心的墨色玻璃。
 */
function EndPill({ head }: { head: TurnHead }) {
  const tone = endToneOf(head);
  const dot = END_TONE_DOT[tone];
  return (
    <Badge
      variant={tone === 'failed' ? 'destructive' : 'secondary'}
      className="shrink-0"
      data-testid="trace-head-status"
      data-tone={tone}
    >
      {tone === 'running' && <DotLoader />}
      {dot !== undefined && (
        <span aria-hidden data-testid="trace-head-dot" className={`size-1.5 rounded-full ${dot}`} />
      )}
      <EndFact head={head} />
    </Badge>
  );
}

/**
 * 一輪的數字（呼叫、工具、重試、token）；摺掉的部分仍算在計數裡，所以另外講。`endElsewhere` 是結束狀態另外畫在標頭的膠囊裡，
 * 這一行就不再重複。
 */
export function HeadFacts({
  head,
  noEnd = false,
  endElsewhere = false,
}: {
  head: TurnHead;
  noEnd?: boolean;
  endElsewhere?: boolean;
}) {
  const tokens = tokenParts(head);
  return (
    <>
      <span>{clockText(head.time)}</span>
      {!noEnd && <span>耗時 {durationText(head.durationMs)}</span>}
      {!noEnd && !endElsewhere && <EndFact head={head} />}
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
        輸入 {tokens.input}／輸出 {tokens.output}
      </span>
      {tokens.hitRate !== undefined && (
        <span data-testid="trace-cache-hit">快取命中 {tokens.hitRate}</span>
      )}
    </>
  );
}

export function TurnHeader({ head }: { head: TurnHead }) {
  return (
    <header className="px-2 pt-1 pb-1" data-testid="trace-turn-head">
      <div className="flex min-w-0 items-center gap-2">
        <h3
          className="text-foreground min-w-0 flex-1 text-body font-medium outline-none"
          // 成本分頁的「看這一輪」把焦點交到這裡（`reveal`）；平常不在 Tab 順序裡。
          data-reveal-target=""
          tabIndex={-1}
        >
          第 {head.number} 輪
          <span className="text-muted-foreground ml-2 text-tip font-normal">
            {TURN_KIND_LABEL[head.kind]}
          </span>
        </h3>
        <EndPill head={head} />
      </div>
      <p className="text-muted-foreground flex flex-wrap gap-x-2 text-tip">
        <HeadFacts head={head} endElsewhere />
      </p>
      {head.elidedCalls !== undefined && (
        <p className="text-muted-foreground text-tip" data-testid="trace-elided">
          另有 {head.elidedCalls} 次呼叫已摺掉
          {head.elidedTools !== undefined && `、${head.elidedTools} 個工具已摺掉`}
          ，上面的計數仍包含它們。
        </p>
      )}
    </header>
  );
}
