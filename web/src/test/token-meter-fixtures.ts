import type {
  ConversationState,
  TokenMeterEarlier,
  TokenMeterLink,
  TokenMeterSpan,
  TokenMeterTurn,
  TokenMeterView,
} from '@nexus/wire';
import { TOKEN_METER_PROJECTION, TOKEN_METER_VERSION, reduceAll } from '@nexus/wire';

import type { Script } from '@/test/conversation-frames';
import { projectionFrame } from '@/test/trajectory-fixtures';

/**
 * 用量投影的測試建構器。形狀照 `packages/nexus-wire/src/token-meter.ts`；值是手寫的（插件那一側有自己的折疊測試，
 * 這裡只管 web 怎麼讀），但送進 `reduceAll` 的是真的 `projection` frame，閘門與 `subagentProjections` 走的是真路徑。
 */
export function span(overrides: Partial<TokenMeterSpan> = {}): TokenMeterSpan {
  return {
    steps: 0,
    failedSteps: 0,
    unknownSteps: 0,
    inputTokens: 0,
    outputTokens: 0,
    failedInputTokens: 0,
    failedOutputTokens: 0,
    summaries: 0,
    summariesUnknown: 0,
    summaryInputTokens: 0,
    summaryOutputTokens: 0,
    retries: 0,
    retryWaitMs: 0,
    modelMs: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolSumMs: 0,
    toolMs: 0,
    waitMs: 0,
    tools: [],
    models: [],
    ...overrides,
  };
}

const NUMERIC = [
  'steps',
  'failedSteps',
  'unknownSteps',
  'inputTokens',
  'outputTokens',
  'failedInputTokens',
  'failedOutputTokens',
  'summaries',
  'summariesUnknown',
  'summaryInputTokens',
  'summaryOutputTokens',
  'retries',
  'retryWaitMs',
  'modelMs',
  'toolCalls',
  'toolErrors',
  'toolSumMs',
  'toolMs',
  'waitMs',
] as const;

const BUCKETS = [
  'uncachedInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'failedCacheReadTokens',
  'failedCacheWriteTokens',
  'summaryCacheReadTokens',
  'summaryCacheWriteTokens',
] as const;

/** 逐欄相加：投影保證 `session ＝ outside ＋ earlier ＋ Σ turns`，夾具照這條造 `session`。 */
export function sumSpans(spans: readonly TokenMeterSpan[]): TokenMeterSpan {
  const total: Record<string, number> = {};
  for (const key of NUMERIC) total[key] = spans.reduce((sum, item) => sum + item[key], 0);
  // 快取分桶（#724）是選填：每一段都有才有，只要有一段缺席整格就不放（缺席＝沒記，不當 0 加）。
  for (const key of BUCKETS) {
    if (spans.length > 0 && spans.every((item) => item[key] !== undefined)) {
      total[key] = spans.reduce((sum, item) => sum + (item[key] ?? 0), 0);
    }
  }
  return span(total as Partial<TokenMeterSpan>);
}

export function meterTurn(index: number, overrides: Partial<TokenMeterTurn> = {}): TokenMeterTurn {
  return {
    ...span({ steps: 1, inputTokens: 100, outputTokens: 20, modelMs: 800, toolMs: 100 }),
    index,
    seq: index * 100,
    time: 1_700_000_000_000 + index * 1000,
    kind: 'message',
    end: 'completed',
    endTime: 1_700_000_000_000 + index * 1000 + 1000,
    wallMs: 1000,
    unaccountedMs: 100,
    ...overrides,
  };
}

export function meterLink(runId: string, overrides: Partial<TokenMeterLink> = {}): TokenMeterLink {
  return { runId, callId: `c-${runId}`, mode: 'continuable', ...overrides };
}

export interface MeterParts {
  readonly turns?: readonly TokenMeterTurn[];
  readonly outside?: TokenMeterSpan;
  readonly earlier?: TokenMeterEarlier;
  readonly links?: readonly TokenMeterLink[];
  readonly linksOmitted?: number;
  readonly totalTurns?: number;
}

/** 以各段造一份 view，`session` 是它們的逐欄加總（`models`、`tools` 不加：夾具不放）。 */
export function meterView(parts: MeterParts = {}): TokenMeterView {
  const turns = parts.turns ?? [];
  const outside = parts.outside ?? span();
  return {
    session: sumSpans([outside, ...(parts.earlier === undefined ? [] : [parts.earlier]), ...turns]),
    outside,
    turns,
    ...(parts.earlier === undefined ? {} : { earlier: parts.earlier }),
    totalTurns: parts.totalTurns ?? turns.length,
    links: parts.links ?? [],
    linksOmitted: parts.linksOmitted ?? 0,
  };
}

/** 把 root 的用量當成下行的 `projection` frame 折進狀態。 */
export function withMeter(
  state: ConversationState,
  script: Script,
  view: unknown,
  version: number = TOKEN_METER_VERSION,
): ConversationState {
  return reduceAll(state, [projectionFrame(script, TOKEN_METER_PROJECTION, version, view)]);
}

/** 某個子代理自己的用量（`session` ＝ 它的 `runId`），落在 `subagentProjections[runId]`。 */
export function withSubagentMeter(
  state: ConversationState,
  script: Script,
  runId: string,
  view: unknown,
): ConversationState {
  return reduceAll(state, [
    projectionFrame(script, TOKEN_METER_PROJECTION, TOKEN_METER_VERSION, view, { session: runId }),
  ]);
}
