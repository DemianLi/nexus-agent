/**
 * 觀測分頁的「一組」與「更早的摘要」：一輪的標頭加它的列（`TurnGroup`），以及窗口外那些輪只有計數的摺疊區（`Digests`）。
 * 列數有上限：每組只畫最新的 {@link ROW_PAGE} 列、摘要一次畫 {@link DIGEST_PAGE} 列，更早的按鈕再展開。
 */

import { useEffect, useRef, useState } from 'react';

import { Chevron } from '@/components/chevron';
import { RowTrigger } from '@/components/row-trigger';
import { PullControl, TRACE_PULL_SUMMARY_ONLY_TEXT } from '@/components/trace/pull-control';
import { TraceRowView } from '@/components/trace/row';

import { HeadFacts, TurnHeader } from '@/components/trace/turn-head';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import type { TraceDigest, TraceRow, TraceTurn } from '@/lib/trace-view';
import type { PullStatus } from '@/lib/trajectory-pull';
import { TURN_KIND_LABEL } from '@/lib/trajectory-view';

/** 窗口外的輪摘要一次畫幾列。 */
export const DIGEST_PAGE = 20;
/** 一組裡一次畫幾列（最新的）；單輪可以很長（目標自己排的輪、一輪幾百次呼叫），列數不設限畫面會凍住。 */
export const ROW_PAGE = 200;

export const TRACE_MORE_DIGESTS_LABEL = '顯示更早的摘要';
export const TRACE_MORE_ROWS_LABEL = '顯示更早的列';
export const TRACE_LEGACY_GROUP_TEXT = '沒有結構資料的一輪：以人說的那一句切開';

export function TurnGroup({
  turn,
  structured,
  names,
  missing,
  revealed,
  onLocate,
  pullStatus,
  onPull,
}: {
  turn: TraceTurn;
  structured: boolean;
  names: ReadonlyMap<string, string>;
  missing: string | undefined;
  /** 剛被成本分頁指到的那一組：畫一圈標示。 */
  revealed: boolean;
  onLocate: (row: TraceRow) => void;
  /** 只有摘要的組才有：載入細節的進度（沒給就不畫載入鈕）。 */
  pullStatus?: PullStatus | undefined;
  onPull?: ((seq: number) => void) | undefined;
}) {
  const title = turn.head === undefined ? '' : `第 ${turn.head.number} 輪`;
  const [shown, setShown] = useState(ROW_PAGE);
  const hiddenRows = Math.max(0, turn.rows.length - shown);
  const rows = hiddenRows === 0 ? turn.rows : turn.rows.slice(hiddenRows);
  return (
    <section
      className={`border-border mb-4 border-l pl-1 ${revealed ? 'ring-ring rounded-md ring-2' : ''}`}
      data-testid="trace-turn"
      data-legacy={turn.legacy ? '' : undefined}
      data-seq={turn.seq}
      data-revealed={revealed ? '' : undefined}
    >
      {turn.head !== undefined && <TurnHeader head={turn.head} />}
      {turn.summaryOnly === true && (
        <p className="text-muted-foreground px-2 text-tip" data-testid="trace-summary-only">
          {TRACE_PULL_SUMMARY_ONLY_TEXT}
        </p>
      )}
      {turn.summaryOnly === true &&
        turn.seq !== undefined &&
        pullStatus !== undefined &&
        onPull !== undefined && (
          <PullControl status={pullStatus} onPull={() => onPull(turn.seq!)} />
        )}
      {structured && turn.legacy && (
        <p className="text-muted-foreground px-2 pt-1 text-tip" data-testid="trace-legacy-group">
          {TRACE_LEGACY_GROUP_TEXT}
        </p>
      )}
      {hiddenRows > 0 && (
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 w-full text-tip lg:min-h-9"
          data-testid="trace-more-rows"
          onClick={() => setShown((count) => count + ROW_PAGE)}
        >
          {TRACE_MORE_ROWS_LABEL}（還有 {hiddenRows} 列）
        </Button>
      )}
      <ol
        aria-label={`${title}的過程，共 ${turn.rows.length} 列`.trimStart()}
        className="flex flex-col gap-0.5"
      >
        {rows.map((row) => (
          <TraceRowView
            key={row.key}
            row={row}
            names={names}
            missing={missing === row.key}
            onLocate={onLocate}
          />
        ))}
      </ol>
    </section>
  );
}

/** 窗口外那些輪：只有計數，沒有內文、沒有定位鈕。 */
export function Digests({
  digests,
  omitted,
  reveal,
  revealedSeq,
  onRevealed,
  statusOf: pullStatusOf,
  onPull,
}: {
  digests: readonly TraceDigest[];
  omitted: number;
  /** 載入某一輪細節的進度與動作（沒給就不畫載入鈕）。 */
  statusOf?: ((seq: number) => PullStatus) | undefined;
  onPull?: ((seq: number) => void) | undefined;
  /** 要顯示的是這裡面的某一輪：展開區塊、展開到那一輪那一頁，再捲過去。 */
  reveal: { readonly seq: number; readonly nonce: number } | undefined;
  revealedSeq: number | undefined;
  onRevealed: (nonce: number) => void;
}) {
  const [shown, setShown] = useState(DIGEST_PAGE);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<number | undefined>(undefined);
  const list = useRef<HTMLOListElement>(null);
  const hidden = Math.max(0, digests.length - shown);
  const visible = digests.slice(hidden);
  // 第一段：決定要展開到哪（只動狀態）。第二段在這些狀態落地、列畫出來之後才找元素。
  useEffect(() => {
    if (reveal === undefined) return;
    const at = digests.findIndex((digest) => digest.seq === reveal.seq);
    if (at === -1) return;
    setOpen(true);
    setShown((count) => Math.max(count, digests.length - at));
    setReady(reveal.nonce);
  }, [reveal, digests]);
  useEffect(() => {
    if (reveal === undefined || ready !== reveal.nonce) return;
    const target = list.current?.querySelector<HTMLElement>(`[data-seq="${reveal.seq}"]`);
    if (target === null || target === undefined) return;
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
    onRevealed(reveal.nonce);
  }, [reveal, ready, shown, open, onRevealed]);
  return (
    <Collapsible className="mb-4" data-testid="trace-digests" open={open} onOpenChange={setOpen}>
      <RowTrigger fit="bare" className="text-tip">
        <span className="text-muted-foreground">
          更早的 {digests.length + omitted} 輪（只有摘要）
        </span>
        <Chevron className="text-muted-foreground ml-auto" />
      </RowTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        {omitted > 0 && (
          <p className="text-muted-foreground px-2 pb-1 text-tip" data-testid="trace-omitted">
            再更早的 {omitted} 輪連摘要都沒留下。
          </p>
        )}
        {hidden > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="mb-1 min-h-11 w-full text-tip lg:min-h-9"
            data-testid="trace-more-digests"
            onClick={() => setShown((count) => count + DIGEST_PAGE)}
          >
            {TRACE_MORE_DIGESTS_LABEL}（還有 {hidden} 輪）
          </Button>
        )}
        <ol ref={list} className="flex flex-col gap-1 px-2 text-tip" aria-label="更早的輪的摘要">
          {visible.map((digest) => (
            <li
              key={digest.key}
              className={`outline-none ${revealedSeq === digest.seq ? 'ring-ring rounded-md ring-2' : ''}`}
              data-testid="trace-digest"
              data-number={digest.number}
              data-seq={digest.seq}
              data-revealed={revealedSeq === digest.seq ? '' : undefined}
              tabIndex={-1}
            >
              <p className="text-foreground">
                第 {digest.number} 輪
                <span className="text-muted-foreground ml-2">{TURN_KIND_LABEL[digest.kind]}</span>
              </p>
              <p className="text-muted-foreground flex flex-wrap gap-x-2">
                <HeadFacts head={digest} />
              </p>
              {pullStatusOf !== undefined && onPull !== undefined && (
                <PullControl status={pullStatusOf(digest.seq)} onPull={() => onPull(digest.seq)} />
              )}
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
