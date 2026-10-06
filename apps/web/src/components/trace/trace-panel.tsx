/**
 * 右側欄的「觀測」分頁（[#1033](https://github.com/DemianLi/nexus-agent/issues/1033)，殼與入口在 #1031、決定在
 * [#1017](https://github.com/DemianLi/nexus-agent/issues/1017)；第 1 版在 [#1034](https://github.com/DemianLi/nexus-agent/issues/1034)）：
 * 把對話一輪一組、依序列成一列一列，點開看細節。
 *
 * **有軌跡投影時**（`lib/trace-view.ts` 的結構化模式）輪界、模型呼叫段落、重試、重複呼叫提醒、時刻與耗時都讀它；**沒有時**
 * 退回第 0 版（只有順序），兩種的限制都全部寫在畫面上（`TRACE_LIMITS`、`TRACE_STRUCTURED_LIMITS`）。投影的歸位在
 * `lib/trace-view.ts`，這裡只畫。UI/UX 以 shadcn＋Tailwind 為基底、Libraries.dev 為模仿對象，不是照 dsh 的
 * `ui-trajectory` 畫時間線。
 *
 * - **畫面上的列數有上限**：只畫最新的 {@link TURN_PAGE} 組、每組只畫最新的 `ROW_PAGE` 列（`trace-groups.tsx`），更早的按「顯示更早的」再展開；窗口外的輪摘要（最多 200 列）收在
 *   一個摺起來的區塊、同樣分段。投影每顆事件整份換掉，所以列只放原始值（`lib/trace-view.ts`），`memo` 才擋得住。
 * - **資料走可訂閱的 store**（`sources.conversation`），而且**只在看得見時訂閱**（`useVisibleSnapshot`）：分頁藏起來時
 *   不卸載（保住捲動位置與展開狀態），但串流的逐字片段不會讓它重算。
 * - **細節是展開的**：思考與壓縮本身就是一列可展開的元件（`ReasoningRow`、`CompactionRow`），直接當列用，不再包一層；
 *   工具列展開時才掛 `ToolCard`（沿用它的全部畫法，收著的列不付它的錢）。
 * - **375／768 單欄**：細節在列下面展開，不並排；觸控目標 44px（`min-h-11`）。串流中新增的列不做進場動效（spec §7）。
 * - **檔案分工**：這個檔只留時間線（「看這一輪」的定位與按需拉）與分頁入口；畫面的零件各在自己的檔——`trace-lines`（列的基本件）、
 *   `trace-row`（一列）、`trace-call`（模型呼叫列與請求快照）、`trace-subagent`（子代理的呼叫結構）、`trace-turn-head`（一輪的標頭）、
 *   `trace-pull-control`（載入細節的鈕）、`trace-groups`（一組與更早的摘要）。
 * - **「在對話裡定位」**：每列右邊一顆鈕，捲到對話區那一則（`lib/transcript-locate.ts`）；1024 以下由右側欄先收掉抽屜、
 *   再把焦點交給那一則（`right-sidebar.tsx`）。找不到時在那一列底下講原因。
 */

import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';

import type { ConversationState } from '@nexus/wire';

import type { PanelBodyProps, TurnReveal } from '@/components/sidebar/right-sidebar-panels';
import { Digests, TurnGroup } from '@/components/trace/trace-groups';
import {
  TRACE_PULL_FAILED_TEXT,
  TRACE_PULL_LOADING_TEXT,
} from '@/components/trace/trace-pull-control';
import { SubagentSourceContext } from '@/components/trace/trace-subagent';
import { Button } from '@/components/ui/button';
import { useStableNames } from '@/hooks/use-stable-names';
import { useTrajectoryPull } from '@/hooks/use-trajectory-pull';
import { useVisibleSnapshot } from '@/hooks/use-visible-snapshot';
import {
  TRACE_HEADLINE,
  TRACE_LIMITS,
  TRACE_STRUCTURED_HEADLINE,
  TRACE_STRUCTURED_LIMITS,
  traceModel,
  turnSeqOfMessage,
} from '@/lib/trace-view';
import type { TraceRow } from '@/lib/trace-view';
import { statusOf } from '@/lib/trajectory-pull';
import type { PullSnapshot, TrajectoryPuller } from '@/lib/trajectory-pull';
import { trajectoryOf } from '@/lib/trajectory-view';

/** 面板還沒有資料可畫時那一句（也是 #1031 留下的那一句）。 */
export const TRACE_EMPTY_TEXT = '尚無資料';

export const TRACE_LOCATED_TEXT = '已在對話裡定位';
export const TRACE_LIMITS_HEADING = '這一版的限制';
export const TRACE_REVEALED_TEXT = '已捲到那一輪';
export const TRACE_REVEAL_MISSING_TEXT = '觀測分頁已經沒有那一輪的資料';
/** 從回覆底下按「這一輪的過程」，那一則歸不進軌跡的輪（窗口之前、投影還沒跟上、或沒有軌跡投影）。 */
export const TRACE_REPLY_UNPLACED_TEXT =
  '這一則回覆歸不到軌跡裡的輪：它在軌跡窗口之前，或軌跡還沒跟上、或這個會話沒有軌跡投影。';
/** 同上，但軌跡有更早輪的摘要：多半是那一輪太舊，只剩摘要，對不到是哪一輪。 */
export const TRACE_REPLY_OLDER_TEXT =
  '這一則回覆多半在軌跡窗口之前：更早的輪只剩摘要（上面「更早的輪」），對不到是哪一輪。';
/** 「看這一輪」標示的那一圈亮多久。 */
export const REVEAL_HIGHLIGHT_MS = 3000;

const noop = () => {};

function Limits({ structured }: { structured: boolean }) {
  const limits = structured ? TRACE_STRUCTURED_LIMITS : TRACE_LIMITS;
  return (
    <section aria-labelledby="trace-limits" className="text-muted-foreground mt-2 px-2 text-xs">
      <h3 id="trace-limits" className="mb-1 font-medium">
        {TRACE_LIMITS_HEADING}
      </h3>
      <ul className="flex list-disc flex-col gap-1 pl-4" data-testid="trace-limits">
        {Object.entries(limits).map(([key, text]) => (
          <li key={key} data-limit={key}>
            {text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 一次畫幾組；更早的按「顯示更早的」再展開。 */
export const TURN_PAGE = 12;

export const TRACE_MORE_TURNS_LABEL = '顯示更早的輪';

const Timeline = memo(function Timeline({
  state,
  locate,
  reveal,
  onRevealed,
  puller,
  pull,
}: {
  state: ConversationState;
  locate: PanelBodyProps['locate'];
  reveal: TurnReveal | undefined;
  onRevealed: (nonce: number) => void;
  /** 按需拉細節（#1083）；沒給就只有推送的那幾輪。 */
  puller: TrajectoryPuller | undefined;
  pull: PullSnapshot | undefined;
}) {
  const pulled = pull?.turns;
  const model = useMemo(() => traceModel(state, pulled), [state, pulled]);
  const names = useStableNames(state.entries);
  const subagentSource = useMemo(() => ({ state, puller }), [state, puller]);
  const [missing, setMissing] = useState<string | undefined>(undefined);
  const [announced, setAnnounced] = useState('');
  // 找不到那一輪時，畫面上也要說（`announced` 只給讀屏）：不然看得見的人只看到側邊欄打開、什麼都沒標示。
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [shown, setShown] = useState(TURN_PAGE);
  const [revealedSeq, setRevealedSeq] = useState<number | undefined>(undefined);
  const [readyTurn, setReadyTurn] = useState<number | undefined>(undefined);
  // 「看這一輪」落在只有摘要的輪、或回覆歸不進軌跡時，先把那一輪的細節拉回來再定位（#1083）：`loading` 期間不下結論，
  // `settled` 之後照拉不到的老辦法講；失敗的原因記在這裡，給標示用。
  const [pullNote, setPullNote] = useState<
    | {
        readonly nonce: number;
        readonly phase: 'loading' | 'settled';
        readonly failure?: string;
      }
    | undefined
  >(undefined);
  const section = useRef<HTMLElement>(null);
  // 回覆底下的「這一輪的過程」給的是訊息 id：先換成那一輪的 `seq`，換不出來（歸不進軌跡的輪）就講明白。
  const target = useMemo(() => {
    if (reveal === undefined) return undefined;
    if (reveal.seq !== undefined) return { nonce: reveal.nonce, seq: reveal.seq };
    const seq = turnSeqOfMessage(model, state.entries, reveal.messageId);
    return seq === undefined ? 'unplaced' : { nonce: reveal.nonce, seq };
  }, [reveal, model, state.entries]);
  const placed = target === undefined || target === 'unplaced' ? undefined : target;
  const revealIn =
    target === undefined
      ? undefined
      : target === 'unplaced'
        ? ('unplaced' as const)
        : model.turns.some((turn) => turn.seq === target.seq)
          ? ('turns' as const)
          : model.digests.some((digest) => digest.seq === target.seq)
            ? ('digests' as const)
            : ('missing' as const);
  const pullAnchor =
    puller === undefined || reveal === undefined || !model.structured
      ? undefined
      : revealIn === 'digests' && placed !== undefined
        ? { seq: placed.seq }
        : revealIn === 'unplaced' && reveal.messageId !== undefined
          ? { messageId: reveal.messageId }
          : undefined;
  const pullHold =
    pullAnchor !== undefined &&
    reveal !== undefined &&
    !(pullNote?.nonce === reveal.nonce && pullNote.phase === 'settled');
  useEffect(() => {
    if (reveal === undefined || puller === undefined || pullAnchor === undefined) return;
    if (pullNote?.nonce === reveal.nonce) return;
    const { nonce } = reveal;
    setPullNote({ nonce, phase: 'loading' });
    void puller.pull(pullAnchor).then((outcome) => {
      setPullNote((current) =>
        current?.nonce === nonce
          ? {
              nonce,
              phase: 'settled',
              ...(outcome.ok || outcome.code === 'turn_not_found' || outcome.code === 'aborted'
                ? {}
                : { failure: outcome.message }),
            }
          : current,
      );
    });
  }, [reveal, puller, pullAnchor, pullNote]);
  // 「看這一輪」（#1034）：第一段只動狀態——展開到那一組那一頁、或交給摘要區塊自己展開；第二段在畫出來之後才找元素、捲過去、
  // 把焦點放在標題。`readyTurn` 讓兩段落在同一個 commit。1024 以下兩個分頁在同一個抽屜裡，不收抽屜。
  useEffect(() => {
    if (reveal === undefined) return;
    if (pullHold) {
      setAnnounced(TRACE_PULL_LOADING_TEXT);
      setNotice(TRACE_PULL_LOADING_TEXT);
      return;
    }
    const failure = pullNote?.nonce === reveal.nonce ? pullNote.failure : undefined;
    if (revealIn === 'digests') {
      // 摘要列自己會捲過去、標示（`Digests`）；拉失敗就在上面講原因，不是靜靜退回摘要。
      const text = failure === undefined ? undefined : `${TRACE_PULL_FAILED_TEXT}${failure}`;
      setNotice(text);
      if (text !== undefined) setAnnounced(text);
    } else if (revealIn === 'turns' && placed !== undefined) {
      setNotice(undefined);
      const at = model.turns.findIndex((turn) => turn.seq === placed.seq);
      setShown((count) => Math.max(count, model.turns.length - at));
      setReadyTurn(reveal.nonce);
    } else if (revealIn === 'missing' || revealIn === 'unplaced') {
      const base =
        revealIn === 'missing'
          ? TRACE_REVEAL_MISSING_TEXT
          : model.structured && (model.digests.length > 0 || model.omitted > 0)
            ? TRACE_REPLY_OLDER_TEXT
            : TRACE_REPLY_UNPLACED_TEXT;
      const text = failure === undefined ? base : `${base}（${TRACE_PULL_FAILED_TEXT}${failure}）`;
      setAnnounced(text);
      setNotice(text);
      // 說明在最上面；面板可能停在很下面，捲回去才看得到。
      if (section.current !== null) section.current.scrollTop = 0;
      onRevealed(reveal.nonce);
    }
  }, [reveal, revealIn, placed, model, onRevealed, pullHold, pullNote]);
  useEffect(() => {
    if (placed === undefined || readyTurn !== placed.nonce) return;
    const group = section.current?.querySelector<HTMLElement>(`section[data-seq="${placed.seq}"]`);
    if (group === null || group === undefined) return;
    group.scrollIntoView({ block: 'start' });
    group.querySelector<HTMLElement>('[data-reveal-target]')?.focus({ preventScroll: true });
    setRevealedSeq(placed.seq);
    setAnnounced(TRACE_REVEALED_TEXT);
    onRevealed(placed.nonce);
  }, [placed, readyTurn, shown, onRevealed]);
  const onDigestRevealed = useCallback(
    (nonce: number) => {
      if (placed !== undefined) setRevealedSeq(placed.seq);
      setAnnounced(TRACE_REVEALED_TEXT);
      onRevealed(nonce);
    },
    [placed, onRevealed],
  );
  // 標示只亮一下。
  useEffect(() => {
    if (revealedSeq === undefined) return;
    const timer = setTimeout(() => setRevealedSeq(undefined), REVEAL_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [revealedSeq]);
  const onLocate = useCallback(
    (row: TraceRow) => {
      if (row.target === undefined) return;
      const found = locate(row.target);
      setMissing(found ? undefined : row.key);
      setAnnounced(found ? TRACE_LOCATED_TEXT : '');
    },
    [locate],
  );
  const onPull = useMemo(
    () =>
      puller === undefined
        ? undefined
        : (seq: number) => {
            void puller.pull({ seq });
          },
    [puller],
  );
  const statusFor = useMemo(
    () =>
      pull === undefined || puller === undefined ? undefined : (seq: number) => statusOf(pull, seq),
    [pull, puller],
  );
  const hiddenTurns = Math.max(0, model.turns.length - shown);
  const turns = hiddenTurns === 0 ? model.turns : model.turns.slice(hiddenTurns);
  return (
    <SubagentSourceContext.Provider value={subagentSource}>
      <section
        ref={section}
        aria-label="對話的過程"
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
        data-testid="right-sidebar-panel-trace"
        // 可捲動的區塊要能用鍵盤捲：進 Tab 順序（同計劃分頁，§8）。
        tabIndex={0}
      >
        <p className="text-muted-foreground mb-3 px-2 text-xs" data-testid="trace-headline">
          {model.structured ? TRACE_STRUCTURED_HEADLINE : TRACE_HEADLINE}
        </p>
        {notice !== undefined && (
          <p
            // 讀屏已經從下面的 `role=status` 聽到同一句，這裡只給看得見的人。
            aria-hidden
            className="bg-chip mb-3 rounded-md px-3 py-2 text-xs"
            data-testid="trace-reveal-notice"
          >
            {notice}
          </p>
        )}
        {model.structured && (model.digests.length > 0 || model.omitted > 0) && (
          <Digests
            digests={model.digests}
            omitted={model.omitted}
            reveal={revealIn === 'digests' && !pullHold ? placed : undefined}
            statusOf={statusFor}
            onPull={onPull}
            revealedSeq={revealedSeq}
            onRevealed={onDigestRevealed}
          />
        )}
        {hiddenTurns > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="mb-3 min-h-11 w-full text-xs lg:min-h-9"
            data-testid="trace-more-turns"
            onClick={() => setShown((count) => count + TURN_PAGE)}
          >
            {TRACE_MORE_TURNS_LABEL}（還有 {hiddenTurns} 組）
          </Button>
        )}
        {turns.map((turn) => (
          <TurnGroup
            key={turn.key}
            turn={turn}
            structured={model.structured}
            names={names}
            missing={missing}
            revealed={turn.seq !== undefined && turn.seq === revealedSeq}
            onLocate={onLocate}
            pullStatus={
              turn.summaryOnly === true && turn.seq !== undefined
                ? statusFor?.(turn.seq)
                : undefined
            }
            onPull={onPull}
          />
        ))}
        <Limits structured={model.structured} />
        <p role="status" className="sr-only">
          {announced}
        </p>
      </section>
    </SubagentSourceContext.Provider>
  );
});

export function TraceBody({ visible, sources, locate, reveal, onRevealed }: PanelBodyProps) {
  const state = useVisibleSnapshot(sources.conversation, visible);
  const pull = useVisibleSnapshot(sources.trajectoryPull, visible);
  useTrajectoryPull(sources.trajectoryPull, state, visible);
  // 條目是空的、但軌跡投影已經有輪（內文沒載入）時照樣畫結構，不寫「尚無資料」。
  const empty =
    state === undefined ||
    (state.entries.length === 0 &&
      (trajectoryOf(state)?.turns.length ?? 0) + (trajectoryOf(state)?.digests.length ?? 0) === 0);
  if (empty) {
    return (
      <p
        className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm"
        data-testid="right-sidebar-panel-trace"
      >
        {TRACE_EMPTY_TEXT}
      </p>
    );
  }
  return (
    <Timeline
      state={state}
      locate={locate}
      // 看不見時不消費：分頁選中之後才會有最新的快照可找。
      reveal={visible ? reveal : undefined}
      onRevealed={onRevealed ?? noop}
      puller={sources.trajectoryPull}
      pull={pull}
    />
  );
}
