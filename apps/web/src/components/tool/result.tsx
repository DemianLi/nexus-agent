/**
 * 工具卡展開之後的內容：寫檔／改檔的 diff（[#601](https://github.com/DemianLi/nexus-agent/issues/601)）、讀檔卡與搜尋卡
 * （[#625](https://github.com/DemianLi/nexus-agent/issues/625)），以及通用卡的結果文字。要畫哪一段、切在哪裡由
 * `lib/tool-diff.ts`、`lib/tool-result-card.ts` 與 `lib/tool-output.ts` 決定，這裡只管畫。
 *
 * - **收合**：diff、讀檔、搜尋三種在對話裡都只畫頭尾兩段，中間一顆鈕展開（照 dsh 的 `FoldToggle`）；展開之後照審查頁
 *   的上限畫到 {@link MAX_RENDERED_LINES} 列——harness 的上限管的是位元組，管不住畫面上的行數。diff 與搜尋另有字元上限
 *   （每列、整張卡，`lib/card-limit.ts`，#961）：列數管不到一列超長、也管不到幾千列各二十幾字。
 * - **diff**：對話裡最多 {@link CHAT_DIFF_MAX_LINES} 列。底色與符號色跟審查頁同一組（`DIFF_TONE`／`DIFF_SIGN`）。
 * - **讀檔**（dsh `ReadBlock`）：標頭是路徑、讀到哪裡、語言；每行帶行號，整段一起高亮（`highlightLines`），語言的文法
 *   還在載時先畫純文字、載完補上色。對話裡最多 {@link CHAT_READ_MAX_LINES} 行。
 * - **搜尋**（dsh `SearchBlock`）：標頭一句摘要，截斷時寫「顯示 X／共 N」；grep 每個檔一列標題、底下帶行號的命中，
 *   glob 一列一個路徑。對話裡最多 {@link CHAT_SEARCH_MAX_LINES} 列。
 * - **不做的**：dsh 的複製、換行切換、每個檔各自收合，我們的卡都沒有。
 * - **參數**：`CodeBlock` 畫，超過 {@link INPUT_MAX_CHARS} 字元時頭尾各畫一塊、中間一行說明（#958）。
 * - **結果**：純文字、自動換行，限高 150px 在框裡捲（dsh `ToolRow.module.css` 的 `.ioText`）。框可以捲，所以
 *   鍵盤要能停上去。
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { Surface } from '@/components/surface';
import { CodeBlock } from '@/components/markdown/code-block';
import { CARD_LINE_MAX_CHARS, fitRowCount } from '@/lib/card-limit';
import { DIFF_SIGN, DIFF_TONE, MAX_RENDERED_LINES } from '@/lib/diff-rows';
import {
  grammarLoadCount,
  highlightLines,
  subscribeGrammarLoaded,
  supportsHighlighting,
} from '@/lib/markdown/highlight';
import type { HighlightSpan } from '@/lib/markdown/highlight';
import { CHAT_DIFF_MAX_LINES, cappedRows, diffRows } from '@/lib/tool-diff';
import type { DiffFragment, ToolDiffRow } from '@/lib/tool-diff';
import {
  CHAT_READ_MAX_LINES,
  CHAT_SEARCH_MAX_LINES,
  cappedSearchRows,
  readWindowText,
  searchRows,
  searchSummary,
} from '@/lib/tool-result-card';
import type { ReadCard, ReadLine, SearchCard, SearchRow } from '@/lib/tool-result-card';
import { clipMiddle, omittedLabel, type ToolOutput } from '@/lib/tool-output';
import { INPUT_MAX_CHARS } from '@/lib/tool-view';
import { cn } from '@/lib/utils';

/**
 * 一列的文字，超過 {@link CARD_LINE_MAX_CHARS} 字元時取頭尾各半、中間一句講沒畫多少字（#961）。
 * 只動畫面，不動 `meta` 與參數。
 */
function ClippedText({ text }: { text: string }) {
  const clipped = clipMiddle(text, CARD_LINE_MAX_CHARS);
  if (clipped.dropped === 0) return text;
  return (
    <>
      {clipped.head}
      <span className="text-muted-foreground font-sans italic" data-testid="card-line-omitted">
        {`⋯ 中間 ${clipped.dropped} 字沒畫 ⋯`}
      </span>
      {clipped.tail}
    </>
  );
}

function DiffLine({ row }: { row: ToolDiffRow }) {
  if (row.kind === 'path') {
    return (
      <div className="text-muted-foreground px-3 pb-1 font-medium break-all" data-diff-line="path">
        {row.text}
      </div>
    );
  }
  if (row.kind === 'gap') {
    return (
      <div className="text-muted-foreground px-3 select-none" data-diff-line="gap">
        {row.text}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'grid grid-cols-[1.5em_minmax(0,1fr)] whitespace-pre-wrap',
        DIFF_TONE[row.kind],
      )}
      data-diff-line={row.kind}
    >
      <span className={cn('text-center select-none', DIFF_SIGN[row.kind])}>
        {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
      </span>
      <span className="pr-3 wrap-anywhere">
        <ClippedText text={row.text} />
      </span>
    </div>
  );
}

/** 收合那顆鈕（dsh `FoldToggle`）：收著寫還有幾列沒畫，展開後寫「收起」。 */
function FoldToggle({
  expanded,
  hidden,
  unit,
  onToggle,
  testId,
}: {
  expanded: boolean;
  hidden: number;
  unit: '行' | '列';
  onToggle: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground hover:bg-chip-hover w-full px-3 py-0.5 text-left font-sans transition-colors duration-(--duration-quick)"
      aria-expanded={expanded}
      onClick={onToggle}
      data-testid={testId}
    >
      {expanded ? '收起' : `展開其餘 ${hidden} ${unit}`}
    </button>
  );
}

/** 展開後沒畫完時的那一句：撞到 {@link MAX_RENDERED_LINES} 列，或（diff、搜尋）撞到整張卡的字元預算。 */
function RenderCapNote({ shown, unit }: { shown: number; unit: '行' | '列' }) {
  return (
    <p className="text-muted-foreground px-3 pt-1 font-sans">
      只顯示前 {shown} {unit}
    </p>
  );
}

/**
 * 頭尾兩段、中間一顆鈕。`capped` 是收著時的切法，展開後畫 `rows` 的前 {@link MAX_RENDERED_LINES} 列。
 * 給了 `weigh`（一列的字元數）就再受整張卡的字元預算限制（`fitRowCount`，#961）；讀檔卡不給，維持原樣。
 */
function Folded<T>({
  rows,
  capped,
  unit,
  testId,
  render,
  weigh,
}: {
  rows: readonly T[];
  capped: { head: readonly T[]; tail: readonly T[]; hidden: number };
  unit: '行' | '列';
  testId: string;
  render: (row: T, key: number) => ReactNode;
  weigh?: (row: T) => number;
}) {
  const [expanded, setExpanded] = useState(false);
  const { head, tail, hidden } = capped;
  const limit = expanded
    ? weigh === undefined
      ? MAX_RENDERED_LINES
      : Math.min(MAX_RENDERED_LINES, fitRowCount(rows, weigh))
    : 0;
  const shown = expanded ? rows.slice(0, limit) : head;
  return (
    <>
      {shown.map((row, at) => render(row, at))}
      {hidden > 0 && (
        <FoldToggle
          expanded={expanded}
          hidden={hidden}
          unit={unit}
          onToggle={() => setExpanded((value) => !value)}
          testId={testId}
        />
      )}
      {!expanded && tail.map((row, at) => render(row, head.length + hidden + at))}
      {expanded && rows.length > limit && <RenderCapNote shown={limit} unit={unit} />}
    </>
  );
}

export function ToolDiff({ fragments }: { fragments: readonly DiffFragment[] }) {
  const rows = useMemo(() => diffRows(fragments), [fragments]);
  return (
    <Surface tone="stage" className="py-2 font-mono text-tip leading-5.5" data-testid="tool-diff">
      <Folded
        rows={rows}
        capped={cappedRows(rows, CHAT_DIFF_MAX_LINES)}
        unit="行"
        testId="tool-diff-toggle"
        render={(row, key) => <DiffLine key={key} row={row} />}
        weigh={(row) => row.text.length}
      />
    </Surface>
  );
}

/** 標頭：左邊是路徑或摘要，右邊是讀到哪裡與語言。窄的時候左邊截斷、右邊不讓。 */
function CardHeader({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="text-muted-foreground flex min-w-0 items-baseline gap-3 px-3 pb-1 font-sans">
      <span className="min-w-0 flex-1 truncate font-medium" title={title}>
        {title}
      </span>
      {aside !== undefined && <span className="flex shrink-0 gap-2">{aside}</span>}
    </div>
  );
}

function Spans({ spans }: { spans: readonly HighlightSpan[] }) {
  return spans.map((span, index) => (
    <span key={index} style={span.style}>
      {span.text}
    </span>
  ));
}

function ReadRow({
  line,
  spans,
  gutter,
}: {
  line: ReadLine;
  spans: readonly HighlightSpan[] | undefined;
  gutter: string;
}) {
  return (
    <div
      className="grid gap-3 px-3 whitespace-pre-wrap"
      style={{ gridTemplateColumns: `${gutter} minmax(0,1fr)` }}
      data-read-line={line.number}
    >
      <span aria-hidden className="text-muted-foreground text-right select-none">
        {line.number}
      </span>
      <span className="wrap-anywhere">
        {/* 超長的一行畫截過的純文字，不畫上色的段：段是從整行切的，截不得（#980）。 */}
        {spans === undefined || line.text.length > CARD_LINE_MAX_CHARS ? (
          <ClippedText text={line.text} />
        ) : (
          <Spans spans={spans} />
        )}
      </span>
    </div>
  );
}

export function ToolRead({ card }: { card: ReadCard }) {
  const raw = useMemo(() => card.lines.map((line) => line.text).join('\n'), [card.lines]);
  // lazy 文法載完時重算：先畫純文字的那張卡補上色。值本身不讀，只讓 memo 換一次。
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount);
  const highlighted = useMemo(() => {
    void loaded;
    return highlightLines(raw, card.lang);
  }, [raw, card.lang, loaded]);
  const indexed = useMemo(
    () => card.lines.map((line, index) => ({ line, spans: highlighted?.[index] })),
    [card.lines, highlighted],
  );
  const digits = card.lines.reduce((max, line) => Math.max(max, String(line.number).length), 3);
  const windowText = readWindowText(card);
  const lang = supportsHighlighting(card.lang) ? card.lang : undefined;
  return (
    <Surface tone="stage" className="py-2 font-mono text-tip leading-5.5" data-testid="tool-read">
      <CardHeader
        title={card.path}
        aside={
          windowText === undefined && lang === undefined ? undefined : (
            <>
              {windowText !== undefined && <span data-testid="tool-read-window">{windowText}</span>}
              {lang !== undefined && <span className="font-mono">{lang}</span>}
            </>
          )
        }
      />
      {indexed.length === 0 ? (
        <p className="text-muted-foreground px-3 font-sans">沒有內容。</p>
      ) : (
        <Folded
          rows={indexed}
          capped={cappedRows(indexed, CHAT_READ_MAX_LINES)}
          unit="行"
          testId="tool-read-toggle"
          render={(row) => (
            <ReadRow
              key={row.line.number}
              line={row.line}
              spans={row.spans}
              gutter={`${digits}ch`}
            />
          )}
        />
      )}
    </Surface>
  );
}

function SearchLine({ row }: { row: SearchRow }) {
  if (row.type === 'file') {
    return (
      <div
        className="text-muted-foreground flex min-w-0 gap-2 px-3 pt-1 font-medium"
        data-search-row="file"
      >
        <span className="min-w-0 flex-1 break-all">{row.path}</span>
        <span className="shrink-0 font-sans">{row.count}</span>
      </div>
    );
  }
  if (row.type === 'path') {
    return (
      <div className="px-3 break-all" data-search-row="path">
        {row.path}
      </div>
    );
  }
  return (
    <div className="px-3 whitespace-pre-wrap wrap-anywhere" data-search-row="match">
      <span className="text-muted-foreground select-none">{row.lineNumber}: </span>
      <ClippedText text={row.line} />
    </div>
  );
}

function searchRowKey(row: SearchRow): string {
  if (row.type === 'match') return `match:${row.fileIndex}:${row.lineNumber}`;
  if (row.type === 'file') return `file:${row.index}`;
  return `path:${row.path}`;
}

/** 搜尋卡一列畫出來的字元數：命中算行號那一小段加整行，檔案標題與路徑算路徑。 */
function searchRowChars(row: SearchRow): number {
  if (row.type === 'match') return String(row.lineNumber).length + 2 + row.line.length;
  return row.path.length;
}

export function ToolSearch({ card }: { card: SearchCard }) {
  const rows = useMemo(() => searchRows(card), [card]);
  return (
    <Surface tone="stage" className="py-2 font-mono text-tip leading-5.5" data-testid="tool-search">
      <CardHeader title={searchSummary(card)} />
      <Folded
        rows={rows}
        capped={cappedSearchRows(rows, CHAT_SEARCH_MAX_LINES)}
        unit="列"
        testId="tool-search-toggle"
        render={(row, key) => <SearchLine key={`${searchRowKey(row)}@${key}`} row={row} />}
        weigh={searchRowChars}
      />
    </Surface>
  );
}

export function ToolOutputBlock({ output }: { output: ToolOutput }) {
  const label = omittedLabel(output);
  return (
    <Surface tone="stage" data-testid="tool-output">
      <div className="text-muted-foreground px-3 pt-2 text-tip">結果</div>
      <pre
        tabIndex={0}
        aria-label="工具結果"
        className="max-h-[150px] overflow-auto px-3 pt-1 pb-2 font-mono text-tip whitespace-pre-wrap wrap-anywhere"
      >
        {output.head}
        {label !== undefined && (
          <>
            {'\n'}
            <span
              className="text-muted-foreground font-sans italic"
              data-testid="tool-output-omitted"
            >
              {label}
            </span>
            {'\n'}
            {output.tail}
          </>
        )}
      </pre>
    </Surface>
  );
}

/**
 * 展開後的參數（#958）：沒超過 {@link INPUT_MAX_CHARS} 字元就是一塊 `CodeBlock`；超過時頭尾各一塊、中間一行
 * 講沒畫多少字，跟結果（`ToolOutputBlock`）同一個形狀，不動模型看到什麼。
 *
 * **切開的兩塊畫純文字、不上色**：尾那一塊是從原文中間開始的，不知道自己落在字串、註解還是程式裡，上色是猜的；
 * 而且 shiki 的文法對長長一串空白會慢得很不成比例（實測：一段 10,000 字元、夾空白的尾巴上色約 470ms，同樣長度
 * 在註解裡面只有約 50ms）。沒超過上限的整段照常上色（串流中照常串流上色）。
 */
export function ToolInputBlock({
  text,
  lang,
  streaming,
}: {
  readonly text: string;
  readonly lang: string | undefined;
  readonly streaming: boolean;
}) {
  const clipped = useMemo(() => clipMiddle(text, INPUT_MAX_CHARS), [text]);
  if (clipped.dropped === 0) return <CodeBlock code={text} lang={lang} streaming={streaming} />;
  return (
    <>
      <CodeBlock code={clipped.head} lang={undefined} streaming={false} />
      <p
        className="text-muted-foreground px-3 py-1 text-tip italic"
        data-testid="tool-input-omitted"
      >
        {`⋯ 中間 ${clipped.dropped} 字沒畫 ⋯`}
      </p>
      <CodeBlock code={clipped.tail} lang={undefined} streaming={false} />
    </>
  );
}
