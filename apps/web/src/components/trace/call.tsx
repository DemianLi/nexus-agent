/**
 * 觀測分頁的「模型呼叫」一列：起訖、用量、模型，展開後是當時送出的系統提示詞全文、取樣設定與工具清單
 * （日誌的 `request/system`、`request/header`）。
 */

import { Cpu } from 'lucide-react';
import { useMemo } from 'react';

import { ExpandableLine, SnapshotBlock } from '@/components/trace/lines';
import { CALL_OUTCOME_LABEL, TRACE_CALL_UNLOADED_TEXT } from '@/lib/trace-view';
import type { TraceRow } from '@/lib/trace-view';
import { ABSENT, clockText, durationText, tokenParts, tokenText } from '@/lib/trajectory-view';

export const TRACE_SNAPSHOT_REASON_TEXT = {
  initial: '第一次記錄',
  change: '內容變了才又記一份',
} as const;
export const TRACE_SYSTEM_TRUNCATED_TEXT = '這份系統提示詞太長，只留前面的部分，下面不是全文。';
export const TRACE_TOOLS_DIFF_PREFIX = '相對上一份工具清單：';
export const TRACE_HEADER_BAD_TEXT = '這份設定與工具清單讀不出來。';

const SNAPSHOT_STATE_TEXT = { none: ABSENT, gone: '已不保留' } as const;

/** 呼叫上記的請求快照：沒記是 `—`，指到的那份已被擠掉是「已不保留」（快照只留最新 4 份）。 */
function snapshotText(
  row: Extract<TraceRow, { kind: 'call' }>,
  which: 'system' | 'header',
): string {
  const state = row[which];
  if (state !== 'kept') return SNAPSHOT_STATE_TEXT[state];
  if (which === 'system') {
    return row.systemChars === undefined
      ? '已記錄'
      : `${tokenText(row.systemChars)} 字元${row.systemTruncated === true ? '（已截斷）' : ''}`;
  }
  return row.headerTools === undefined ? '已記錄' : `工具 ${row.headerTools} 個`;
}

const SNAPSHOT_PRE =
  'bg-chip max-h-72 min-w-0 overflow-auto rounded-lg p-2 font-mono text-tip break-words whitespace-pre-wrap';

interface ParsedHeader {
  readonly config: readonly (readonly [string, string])[];
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly rest: string;
  }[];
}

/** 展開時才解析（整份常有二十幾 KB）。讀不出來是 `undefined`，不猜。 */
function parseHeader(json: string): ParsedHeader | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { config, tools } = value as { config?: unknown; tools?: unknown };
  const text = (v: unknown) => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ABSENT));
  return {
    config:
      typeof config === 'object' && config !== null
        ? Object.entries(config).map(([key, v]) => [key, text(v)] as const)
        : [],
    tools: Array.isArray(tools)
      ? tools.map((tool: unknown) => {
          if (typeof tool !== 'object' || tool === null)
            return { name: ABSENT, description: '', rest: text(tool) };
          const { name, description, ...rest } = tool as Record<string, unknown>;
          return {
            name: typeof name === 'string' ? name : ABSENT,
            description: typeof description === 'string' ? description : '',
            rest: Object.keys(rest).length === 0 ? '' : JSON.stringify(rest, null, 2),
          };
        })
      : [],
  };
}

function HeaderBody({ json, diff }: { json: string; diff: string | undefined }) {
  const header = useMemo(() => parseHeader(json), [json]);
  if (header === undefined) {
    return <p className="text-muted-foreground text-tip">{TRACE_HEADER_BAD_TEXT}</p>;
  }
  return (
    <div className="space-y-2 text-tip">
      {header.config.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="trace-header-config">
          {header.config.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="text-foreground min-w-0 font-mono break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {diff !== undefined && (
        <p className="text-foreground" data-testid="trace-header-diff">
          {TRACE_TOOLS_DIFF_PREFIX}
          {diff}
        </p>
      )}
      <ul className="space-y-0.5" data-testid="trace-header-tools">
        {header.tools.map((tool, index) => (
          <li key={`${tool.name}-${index}`}>
            <SnapshotBlock
              testId="trace-header-tool"
              title={<code className="font-mono">{tool.name}</code>}
            >
              {tool.description !== '' && (
                <p className="mb-1 break-words whitespace-pre-wrap">{tool.description}</p>
              )}
              {tool.rest !== '' && <pre className={SNAPSHOT_PRE}>{tool.rest}</pre>}
            </SnapshotBlock>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 這次呼叫當時送出去的系統提示詞全文，與取樣設定、工具清單（日誌的 `request/system`、`request/header`）。 */
function SnapshotDetails({ row }: { row: Extract<TraceRow, { kind: 'call' }> }) {
  return (
    <>
      {row.systemText !== undefined && (
        <SnapshotBlock
          testId="trace-system-text"
          title={`系統提示詞全文（${tokenText(row.systemChars)} 字元）`}
        >
          {row.systemReason !== undefined && (
            <p className="text-muted-foreground mb-1 text-tip">
              {TRACE_SNAPSHOT_REASON_TEXT[row.systemReason]}
            </p>
          )}
          {row.systemTruncated === true && (
            <p className="text-muted-foreground mb-1 text-tip" data-testid="trace-system-truncated">
              {TRACE_SYSTEM_TRUNCATED_TEXT}
            </p>
          )}
          <pre className={SNAPSHOT_PRE}>{row.systemText}</pre>
        </SnapshotBlock>
      )}
      {row.headerJson !== undefined && (
        <SnapshotBlock
          testId="trace-header-block"
          title={
            row.headerTools === undefined
              ? '取樣設定與工具清單'
              : `取樣設定與工具清單（工具 ${row.headerTools} 個）`
          }
        >
          {row.headerReason !== undefined && (
            <p className="text-muted-foreground mb-1 text-tip">
              {TRACE_SNAPSHOT_REASON_TEXT[row.headerReason]}
            </p>
          )}
          <HeaderBody json={row.headerJson} diff={row.toolsDiff} />
        </SnapshotBlock>
      )}
    </>
  );
}

/** 一次模型呼叫的段落：起訖、用量、模型與當時送出的設定。 */
export function CallRow({ row }: { row: Extract<TraceRow, { kind: 'call' }> }) {
  const tokens = tokenParts(row);
  const details: [string, string][] = [
    ['開始', clockText(row.time)],
    ['結束', clockText(row.endTime)],
    ['耗時', durationText(row.durationMs)],
    ...(row.outcome === undefined
      ? []
      : ([['結果', CALL_OUTCOME_LABEL[row.outcome]]] as [string, string][])),
    ['模型', row.model ?? ABSENT],
    ['輸入 token', tokens.input],
    ...(tokens.cache === undefined
      ? []
      : ([
          ['快取讀 token', tokens.cache.read],
          ['快取寫 token', tokens.cache.write],
        ] as [string, string][])),
    ['輸出 token', tokens.output],
    ...(tokens.hitRate === undefined
      ? []
      : ([['快取命中率', tokens.hitRate]] as [string, string][])),
    ['這次叫的工具', `${row.toolCount} 個`],
    ['重試', `${row.retryCount} 次`],
    ['系統提示詞', snapshotText(row, 'system')],
    ['設定與工具清單', snapshotText(row, 'header')],
  ];
  return (
    <ExpandableLine
      line={{
        icon: Cpu,
        label: `模型呼叫 #${row.n}`,
        summary: row.model ?? '',
        meta: (
          <span data-testid="trace-time">
            {row.outcome !== undefined && (
              <span className="text-destructive" data-testid="trace-call-outcome">
                {CALL_OUTCOME_LABEL[row.outcome]} ·{' '}
              </span>
            )}
            {clockText(row.time)} · {durationText(row.durationMs)}
            {row.inputTokens !== undefined &&
              ` · 輸入 ${tokens.input}／輸出 ${tokens.output}${
                tokens.hitRate === undefined ? '' : ` · 快取命中 ${tokens.hitRate}`
              }`}
          </span>
        ),
      }}
    >
      <dl
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-tip"
        data-testid="trace-call-details"
      >
        {details.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="text-foreground min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <SnapshotDetails row={row} />
      {row.hasContent && !row.loaded && (
        <p className="text-muted-foreground mt-2 text-tip" data-testid="trace-call-unloaded">
          {TRACE_CALL_UNLOADED_TEXT}
        </p>
      )}
    </ExpandableLine>
  );
}
