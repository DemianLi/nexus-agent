/**
 * 讀用量投影（[#1028](https://github.com/DemianLi/nexus-agent/issues/1028)）的那一層：哪些值可以信、每個欄位怎麼寫成列。
 * 成本分頁（`cost-view.ts`、`panel.tsx`）第 1 版（[#1034](https://github.com/DemianLi/nexus-agent/issues/1034)）只透過這裡碰投影。
 *
 * ## 數字只有一個來源
 *
 * 有投影時，累計、逐輪、子代理的數字**全部**取自 `token-meter` 的 view，不再混 `sessionStats`：投影的 `modelMs` 扣掉了重試退避、
 * `sessionStats.llmMs` 沒扣，同一個畫面兩個來源會差一截，而且是設計上就會差。逐欄的和 `outside ＋ earlier ＋ Σ turns ＝ session`
 * 是投影自己保證的（`cost-view.test.ts` 釘住畫面值等於 view 值）。
 *
 * ## 閘門
 *
 * 同觀測分頁：`failed: true`、版本不是 {@link TOKEN_METER_VERSION}、形狀不對，一律當成沒有，呼叫端退回第 0 版。
 *
 * ## 「不知道」與「是 0」
 *
 * - 供應商沒報用量的呼叫（`unknownSteps`）不是 0：有這種呼叫，token 那幾格標「下限」。
 * - `unaccountedMs` **可能是負的**（三段互不重疊的前提被破壞），照實寫、加標記，不夾 0。
 *
 * @module
 */

import {
  DELEGATION_TOOL_NAMES,
  TOKEN_METER_CALIBER,
  TOKEN_METER_PROJECTION,
  TOKEN_METER_VERSION,
} from '@nexus/wire';
import type {
  ConversationState,
  TokenMeterEnd,
  TokenMeterLink,
  TokenMeterSpan,
  TokenMeterTurn,
  TokenMeterView,
} from '@nexus/wire';

import {
  cacheCountText,
  cacheHitRate,
  cacheHitRateText,
  exactTokens,
  formatDuration,
  usageBuckets,
} from '@/lib/session-usage-view';
import { UNKNOWN_SUBAGENT_LABEL } from '@/lib/subagent-view';
import {
  TURN_END_LABEL,
  TURN_KIND_LABEL,
  clockText,
  durationText,
  trajectoryOf,
  viewOf,
} from '@/lib/trajectory-view';

type Projections = ConversationState['projections'];

const isSpan = (value: unknown): value is TokenMeterSpan =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as TokenMeterSpan).steps === 'number' &&
  typeof (value as TokenMeterSpan).inputTokens === 'number' &&
  typeof (value as TokenMeterSpan).modelMs === 'number';

/** 一份日誌的用量 view；沒有、拋過、版本不認得、形狀不對都是 `undefined`。 */
export function tokenMeterOf(projections: Projections): TokenMeterView | undefined {
  const view = viewOf(projections, TOKEN_METER_PROJECTION, TOKEN_METER_VERSION);
  if (typeof view !== 'object' || view === null) return undefined;
  const { session, outside, turns, links, totalTurns, linksOmitted } =
    view as Partial<TokenMeterView>;
  if (
    !isSpan(session) ||
    !isSpan(outside) ||
    !Array.isArray(turns) ||
    !Array.isArray(links) ||
    typeof totalTurns !== 'number' ||
    typeof linksOmitted !== 'number'
  ) {
    return undefined;
  }
  return view as TokenMeterView;
}

/** 分頁頂上那一句（有用量投影時）。 */
export const COST_STRUCTURED_HEADLINE =
  '第 1 版：逐輪用量，數字都來自用量投影，不畫金額、不畫完成率';

export const COST_STRUCTURED_LIMITS = {
  scope:
    '這裡的 token 是供應商報的：含失敗與中止的呼叫、含快取讀取；不含生摘要的那一次（另列）、不含產生會話標題的那一次。供應商沒報用量的呼叫不是 0，有這種呼叫時 token 是下限。',
  time: '時間分三段加一格殘差：模型（扣掉重試退避）、工具（平行的取聯集）、等待（重試退避加核准等待）；殘差是三段都沒覆蓋到的，可能是負的，那代表前提被破壞。',
  window:
    '逐輪只列最近的幾輪，更早的併成一列；每一輪的「在觀測分頁看這一輪」只在觀測分頁還有那一輪的資料時能按。',
  subagent:
    '子代理的 token 可以和主對話相加，時間不行：前景子代理跑的時間已經在派它的那顆工具的耗時裡。數字是即時的，它還在跑就會繼續增加。',
  absent: '沒有金額（端點不回報單價）、沒有完成率（沒有任務成功的判準）。',
} as const;

/** 畫面上有、但投影的口徑表沒有的欄位（由其他欄位算出來的）。 */
export const DERIVED_CALIBER: Readonly<Record<string, string>> = {
  tokensTotal: '輸入加輸出：整筆帳（輸入已含快取讀取）。',
  tokensTotalBuckets:
    '輸入（未快取）、快取讀、快取寫、輸出四項相加：整筆帳。有一個快取桶沒記時，合計不含那一項，是下限。',
  cacheHitRate:
    '快取讀 ÷（未快取＋快取讀＋快取寫），這一段加起來算，不是各次呼叫比例的平均；有一個快取桶沒記就寫「沒記」，不寫 0%。',
  subagentTokens:
    '主對話加上每個列得出來的子代理的 token 加總；有子代理還沒有數字、或有呼叫沒報用量時是下限。',
};

/** 欄位的口徑句；兩張表都沒有就是 `undefined`（測試會抓到）。 */
export function caliberOf(field: string): string | undefined {
  return TOKEN_METER_CALIBER[field] ?? DERIVED_CALIBER[field];
}

/** 一格：`field` 是口徑表的鍵（畫面的 `data-field`），`value` 已經是寫好的字。 */
export type FieldRow = readonly [field: string, label: string, value: string];

/** 負數也寫得出來的耗時：殘差可能是負的。 */
export function signedDuration(ms: number): string {
  return ms < 0 ? `−${formatDuration(-ms)}` : formatDuration(ms);
}

const tokenValue = (count: number, lowerBound: boolean): string =>
  `${exactTokens(count)}${lowerBound ? '（下限）' : ''}`;

/** 快取桶：沒記寫「沒記」（不加下限記號：那不是少算，是沒有這個數字）。 */
const cacheValue = (count: number | undefined, lowerBound: boolean): string =>
  count === undefined ? cacheCountText(count) : tokenValue(count, lowerBound);

/**
 * 一段事件的數字換成列。一輪（`turn`）才有殘差。**零值的選填格不畫**（沒有失敗、沒有重試、沒有摘要就不佔版面），
 * 但 token 與呼叫數永遠畫：0 是真的答案。
 */
export function spanRows(span: TokenMeterSpan, turn?: TokenMeterTurn): readonly FieldRow[] {
  const lower = span.unknownSteps > 0;
  // 四桶互不重疊，**不讀 `inputTokens`**（#724）：它之後會改成只算未快取，畫面的數字不能跟著動。投影沒給未快取那一格
  // （舊 server）就退回 `inputTokens`（完整 prompt，含快取），跟以前一樣。
  const buckets = usageBuckets(span);
  const hitRate = cacheHitRate(buckets);
  const cacheMissing = buckets.cacheRead === undefined || buckets.cacheWrite === undefined;
  const rows: FieldRow[] = buckets.cacheInInput
    ? [
        ['inputTokens', '輸入', tokenValue(buckets.input, lower)],
        ['outputTokens', '輸出', tokenValue(buckets.output, lower)],
        ['tokensTotal', '合計', tokenValue(buckets.total, lower)],
      ]
    : [
        ['uncachedInputTokens', '輸入', tokenValue(buckets.input, lower)],
        ['cacheReadTokens', '快取讀', cacheValue(buckets.cacheRead, lower)],
        ['cacheWriteTokens', '快取寫', cacheValue(buckets.cacheWrite, lower)],
        ['outputTokens', '輸出', tokenValue(buckets.output, lower)],
        ['tokensTotalBuckets', '合計', tokenValue(buckets.total, lower || cacheMissing)],
      ];
  if (hitRate !== undefined) rows.push(['cacheHitRate', '快取命中率', cacheHitRateText(hitRate)]);
  if (span.failedInputTokens > 0 || span.failedOutputTokens > 0) {
    rows.push(
      ['failedInputTokens', '其中失敗或中止的輸入', exactTokens(span.failedInputTokens)],
      ['failedOutputTokens', '其中失敗或中止的輸出', exactTokens(span.failedOutputTokens)],
    );
  }
  if (span.summaries > 0) {
    rows.push(['summaries', '生摘要', `${span.summaries} 次`]);
    if (span.summariesUnknown > 0) {
      rows.push(['summariesUnknown', '其中沒報用量的', `${span.summariesUnknown} 次`]);
    }
    rows.push(
      ['summaryInputTokens', '生摘要的輸入（另列）', exactTokens(span.summaryInputTokens)],
      ['summaryOutputTokens', '生摘要的輸出（另列）', exactTokens(span.summaryOutputTokens)],
    );
  }
  rows.push(['steps', '模型呼叫', `${span.steps} 次`]);
  if (span.failedSteps > 0)
    rows.push(['failedSteps', '其中失敗或中止的', `${span.failedSteps} 次`]);
  if (span.unknownSteps > 0) {
    rows.push(['unknownSteps', '其中沒報用量的', `${span.unknownSteps} 次`]);
  }
  rows.push(['toolCalls', '工具呼叫', `${span.toolCalls} 次`]);
  if (span.toolErrors > 0) rows.push(['toolErrors', '其中失敗的', `${span.toolErrors} 次`]);
  if (span.retries > 0) rows.push(['retries', '重試', `${span.retries} 次`]);
  rows.push(
    ['modelMs', '模型耗時', formatDuration(span.modelMs)],
    ['toolMs', '工具耗時', formatDuration(span.toolMs)],
  );
  if (span.waitMs > 0) rows.push(['waitMs', '核准等待', formatDuration(span.waitMs)]);
  if (span.retryWaitMs > 0)
    rows.push(['retryWaitMs', '重試退避', formatDuration(span.retryWaitMs)]);
  if (turn?.unaccountedMs !== undefined) {
    rows.push([
      'unaccountedMs',
      turn.unaccountedMs < 0 ? '殘差（為負：前提被破壞）' : '殘差',
      signedDuration(turn.unaccountedMs),
    ]);
  }
  return rows;
}

/** 依模型、依工具的分佈（會話總計那一段用）。 */
export function distributionRows(span: TokenMeterSpan): {
  readonly models: readonly (readonly [label: string, value: string])[];
  readonly tools: readonly (readonly [label: string, value: string])[];
} {
  const models = span.models.map(
    (row) =>
      [
        row.model ?? '（沒有請求快照，模型不明）',
        `${row.steps} 次・輸入 ${row.inputTokens.toLocaleString('en-US')}／輸出 ${row.outputTokens.toLocaleString('en-US')}`,
      ] as const,
  );
  if (span.modelsOther !== undefined) {
    models.push([
      '其他模型',
      `${span.modelsOther.steps} 次・輸入 ${span.modelsOther.inputTokens.toLocaleString('en-US')}／輸出 ${span.modelsOther.outputTokens.toLocaleString('en-US')}`,
    ]);
  }
  const tools = span.tools.map(
    (row) =>
      [row.name, `${row.calls} 次${row.errors > 0 ? `（${row.errors} 次失敗）` : ''}`] as const,
  );
  if (span.toolsOther !== undefined) {
    tools.push([
      '其他工具',
      `${span.toolsOther.calls} 次${span.toolsOther.errors > 0 ? `（${span.toolsOther.errors} 次失敗）` : ''}`,
    ]);
  }
  return { models, tools };
}

/** 一輪怎麼結束的；用量投影多一格「停在核准點」。 */
export const METER_END_LABEL: Readonly<Record<TokenMeterEnd, string>> = {
  ...TURN_END_LABEL,
  paused: '停在核准點',
};

/** 一輪的列。**只放原始值**：投影每顆事件整份換掉，物件身分不能當比對依據（`sameTurnRow`）。 */
export interface CostTurnRow {
  readonly key: string;
  /** `TokenMeterTurn.seq`，也是觀測分頁那一組的 `turn-<seq>`。 */
  readonly seq: number;
  /** 第幾個邏輯輪（1 起，與觀測分頁同一套）。 */
  readonly number: number;
  readonly kind: string;
  readonly kindLabel: string;
  readonly time: string;
  readonly wall: string;
  readonly endLabel: string;
  readonly fields: readonly FieldRow[];
  /** 觀測分頁現在有沒有這一輪的資料（決定「看這一輪」鈕能不能按）。 */
  readonly revealable: boolean;
}

/** 兩列畫出來會一樣嗎（`memo` 的比較）。 */
export function sameTurnRow(a: CostTurnRow, b: CostTurnRow): boolean {
  return (
    a.key === b.key &&
    a.seq === b.seq &&
    a.number === b.number &&
    a.kind === b.kind &&
    a.time === b.time &&
    a.wall === b.wall &&
    a.endLabel === b.endLabel &&
    a.revealable === b.revealable &&
    a.fields.length === b.fields.length &&
    a.fields.every((row, i) => {
      const other = b.fields[i];
      return (
        other !== undefined && row[0] === other[0] && row[1] === other[1] && row[2] === other[2]
      );
    })
  );
}

/** 觀測分頁現在能定位到的輪的 `seq`：軌跡的 `turns` 與 `digests`。 */
export function revealableSeqs(state: ConversationState): ReadonlySet<number> {
  const trajectory = trajectoryOf(state);
  const seqs = new Set<number>();
  if (trajectory === undefined) return seqs;
  for (const turn of trajectory.turns) seqs.add(turn.seq);
  for (const digest of trajectory.digests) seqs.add(digest.seq);
  return seqs;
}

export function costTurnRows(
  view: TokenMeterView,
  revealable: ReadonlySet<number>,
): readonly CostTurnRow[] {
  return view.turns.map((turn) => ({
    key: `turn-${turn.seq}`,
    seq: turn.seq,
    number: turn.index + 1,
    kind: turn.kind,
    // 用量投影的 `kind` 是字串：不認得的原樣顯示，不猜。
    kindLabel: (TURN_KIND_LABEL as Readonly<Record<string, string>>)[turn.kind] ?? turn.kind,
    time: clockText(turn.time),
    wall: durationText(turn.wallMs),
    endLabel: turn.end === undefined ? '進行中' : METER_END_LABEL[turn.end],
    fields: spanRows(turn, turn),
    revealable: revealable.has(turn.seq),
  }));
}

/** 一個子代理的分列。`view` 是 `undefined` 代表它的投影還沒到（寫「還沒有資料」，不寫 0）。 */
export interface CostSubagent {
  readonly runId: string;
  /** 派它的那顆委派呼叫的 `callId`：前景子代理沒有背景那把鑰匙，名字要從這顆卡的參數找。 */
  readonly callId: string;
  readonly mode: TokenMeterLink['mode'];
  /** 派它的那一輪（`TokenMeterTurn.index`）；不在任何輪裡就沒有。 */
  readonly turn: number | undefined;
  readonly view: TokenMeterView | undefined;
}

/** root 的 `links` 接回 `subagentProjections[runId]`，逐個子代理各自過閘門。 */
export function costSubagents(
  state: ConversationState,
  root: TokenMeterView,
): readonly CostSubagent[] {
  return root.links.map((link) => ({
    runId: link.runId,
    callId: link.callId,
    mode: link.mode,
    turn: link.turn,
    view: tokenMeterOf(state.subagentProjections[link.runId] ?? {}),
  }));
}

/**
 * 含子代理的 token：主對話加上每個有數字的子代理。**只加 token，不加時間。**
 * `complete` 為 false（有子代理還沒有數字、有呼叫沒報用量、或有更早的子代理沒逐個列出）時是下限。
 */
export function tokensWithSubagents(
  root: TokenMeterView,
  subagents: readonly CostSubagent[],
): { readonly total: number; readonly complete: boolean } {
  // 每一份各自用四桶加起來（不讀 `inputTokens`，見 `spanRows`）；有快取桶沒記的，加起來就不含那一項，所以是下限。
  const countable = (span: TokenMeterSpan): boolean => {
    const buckets = usageBuckets(span);
    return span.unknownSteps === 0 && (buckets.cacheInInput || cacheKnown(buckets));
  };
  let total = usageBuckets(root.session).total;
  let complete = countable(root.session) && root.linksOmitted === 0;
  for (const subagent of subagents) {
    if (subagent.view === undefined) {
      complete = false;
      continue;
    }
    total += usageBuckets(subagent.view.session).total;
    if (!countable(subagent.view.session)) complete = false;
  }
  return { total, complete };
}

const cacheKnown = (buckets: ReturnType<typeof usageBuckets>): boolean =>
  buckets.cacheRead !== undefined && buckets.cacheWrite !== undefined;

/** 對不到名字的前景子代理的稱呼（背景的對不到時沿用 `UNKNOWN_SUBAGENT_LABEL`）。 */
export const FOREGROUND_SUBAGENT_LABEL = '子代理';

/**
 * 每個子代理叫什麼。背景的名字在委派卡結果的 meta（`names`）；前景的沒有那把鑰匙，改讀派它的那顆委派呼叫的參數
 * （`subagent_type`）。都對不到（重新整理後那一頁沒載入）就寫「子代理」，不編名字。
 */
export function subagentTitles(
  entries: ConversationState['entries'],
  subagents: readonly CostSubagent[],
  names: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const wanted = new Map(subagents.map((subagent) => [subagent.callId, subagent.runId]));
  const fromInput = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== 'tool' || !DELEGATION_TOOL_NAMES.includes(entry.name)) continue;
    const runId = wanted.get(entry.callId);
    if (runId === undefined) continue;
    try {
      const type = (JSON.parse(entry.input) as { subagent_type?: unknown }).subagent_type;
      if (typeof type === 'string' && type !== '') fromInput.set(runId, type);
    } catch {
      // 參數不是 JSON（照線上原樣留著的）：當沒有。
    }
  }
  const titles = new Map<string, string>();
  for (const subagent of subagents) {
    const named = names.get(subagent.runId);
    titles.set(
      subagent.runId,
      named !== undefined && named !== ''
        ? named
        : (fromInput.get(subagent.runId) ??
            (subagent.mode === 'one-shot' ? FOREGROUND_SUBAGENT_LABEL : UNKNOWN_SUBAGENT_LABEL)),
    );
  }
  return titles;
}
