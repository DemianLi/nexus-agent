/**
 * 程式碼區塊（規格 §4.2 列 14，#406）：markdown 的 fence 與工具卡的參數共用。高亮照 dsh
 * `ui-primitives/src/markdown/CodeBlock.tsx`（本機 clone `ddefc45`，MIT）的三臂：
 *
 * - **串流中**：每個實例一個 {@link StreamingHighlightSession}，只重算新接上的字；完成的行每 32 行包成一組，
 *   React 對齊時不碰它們。呼叫端要讓實例在 fence 長大時保持同一個（markdown 那層用來源 offset 當 key）。
 *   講完時字沒變，就直接留用串流那一棵。
 * - **講完的**：shiki 的 HTML。那是 shiki 從 `code` 生出來的靜態 span 樹，沒有使用者的 HTML 經過，
 *   是 shiki 文件指定的 innerHTML 用法。
 * - **純文字**：不認得的語言、lazy 文法還在載、還沒捲進可視範圍。
 *
 * 外觀是 nexus 自己的（`.md-code`，`src/styles/markdown.css`）；dsh 的複製按鈕與行號不在這張卡的範圍。
 */

import { Fragment, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { useViewportHighlighting } from '@/hooks/use-viewport-highlighting';
import {
  StreamingHighlightSession,
  grammarLoadCount,
  highlightToHtml,
  subscribeGrammarLoaded,
} from '@/lib/markdown/highlight';
import type { HighlightSpan, StreamingHighlightFrame } from '@/lib/markdown/highlight';

/** shiki HTML 那一臂在 css-variables 主題下給 `pre` 的屬性；串流那一臂照抄，兩臂的樹才換得過去。 */
const SHIKI_PRE_PROPS = {
  className: 'shiki css-variables',
  style: { backgroundColor: 'var(--shiki-background)', color: 'var(--shiki-foreground)' },
  tabIndex: 0,
} as const;

/** 完成的行幾行一組：React 以組為單位對齊，DOM 仍然一行對一行。 */
const STREAMING_LINE_GROUP_SIZE = 32;

function renderLine(line: readonly HighlightSpan[], index: number): ReactNode {
  return (
    <Fragment key={index}>
      {index > 0 && '\n'}
      <span className="line">
        {line.map((span, spanIndex) => (
          <span key={spanIndex} style={span.style}>
            {span.text}
          </span>
        ))}
      </span>
    </Fragment>
  );
}

interface LineCache {
  readonly code: string;
  readonly lang: string | undefined;
  readonly generation: number;
  readonly frame: StreamingHighlightFrame;
  readonly groups: ReactNode[];
  readonly pending: ReactNode[];
  readonly nextLine: number;
  readonly body: ReactNode;
}

export function CodeBlock({
  code,
  lang,
  streaming,
}: {
  readonly code: string;
  /** info string 的第一段（同 dsh 的 `/^[\w-]+/`）；不認得的就是純文字。 */
  readonly lang: string | undefined;
  /** 這一塊還在長。 */
  readonly streaming: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const highlighting = useViewportHighlighting(rootRef, lang);
  // lazy 文法載完時重畫：先顯示純文字的那一塊換上高亮。snapshot 的值本身沒意義，只看它變了沒。
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount);
  // 串流狀態放在 ref、在 memo 裡改（同 MarkdownText 的串流快取）：只有呼叫端讓實例保持同一個時，快取才接得上。
  const sessionRef = useRef<StreamingHighlightSession | null>(null);
  const lineCacheRef = useRef<LineCache | null>(null);
  const settledRef = useRef(false);

  const streamedBody = useMemo(() => {
    void loaded;
    if (!highlighting) {
      sessionRef.current = null;
      lineCacheRef.current = null;
      settledRef.current = false;
      return undefined;
    }
    if (!streaming) {
      const previous = lineCacheRef.current;
      if (previous !== null && previous.code === code && previous.lang === lang) {
        settledRef.current = true;
        return previous.body;
      }
      sessionRef.current = null;
      lineCacheRef.current = null;
      settledRef.current = true;
      return undefined;
    }
    if (settledRef.current) {
      sessionRef.current = null;
      lineCacheRef.current = null;
      settledRef.current = false;
    }
    sessionRef.current ??= new StreamingHighlightSession();
    const frame = sessionRef.current.updateFrame(code, lang);
    if (frame === undefined) {
      lineCacheRef.current = null;
      return undefined;
    }
    const previous = lineCacheRef.current;
    if (previous?.frame === frame && previous.code === code && previous.lang === lang) {
      return previous.body;
    }
    const sameGeneration = previous?.generation === frame.generation;
    const groups = sameGeneration ? [...previous.groups] : [];
    let pending = sameGeneration ? [...previous.pending] : [];
    let nextLine = sameGeneration ? previous.nextLine : 0;
    for (const line of frame.appended) {
      pending.push(renderLine(line, nextLine));
      nextLine += 1;
      if (pending.length !== STREAMING_LINE_GROUP_SIZE) continue;
      const start = nextLine - pending.length;
      groups.push(<Fragment key={start}>{pending}</Fragment>);
      pending = [];
    }
    const tail = frame.tail.map((line, index) => renderLine(line, nextLine + index));
    const tailGroup = <Fragment key={nextLine - pending.length}>{[...pending, ...tail]}</Fragment>;
    const body = (
      <pre {...SHIKI_PRE_PROPS}>
        <code>
          {groups}
          {tailGroup}
        </code>
      </pre>
    );
    lineCacheRef.current = {
      code,
      lang,
      generation: frame.generation,
      frame,
      groups,
      pending,
      nextLine,
      body,
    };
    return body;
  }, [streaming, highlighting, code, lang, loaded]);

  const html = useMemo(() => {
    void loaded;
    return highlighting && !streaming && streamedBody === undefined
      ? highlightToHtml(code, lang)
      : undefined;
  }, [streaming, highlighting, streamedBody, code, lang, loaded]);

  const body =
    streamedBody !== undefined ? (
      streamedBody
    ) : html === undefined ? (
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    ) : (
      <div dangerouslySetInnerHTML={{ __html: html }} />
    );

  return (
    <div ref={rootRef} className="md-code" data-streaming={streaming || undefined}>
      {lang !== undefined && <div className="md-code-lang">{lang}</div>}
      {body}
    </div>
  );
}
