/**
 * 助理回覆的 markdown（規格 §4.2 列 10／11，#405）。照 dsh `ui-primitives/src/markdown/MarkdownText.tsx`
 * （本機 clone `ddefc45`，MIT）：
 *
 * - **講完的**：整份解析一次、收齊定義、畫出來。
 * - **串流中**：`IncrementalMarkdownParser` 凍結前面的 block，凍結的那些快取成 React 元素，每個 delta 只重解、重畫
 *   最後那一段；凍結的 block 跨過邊界時 key 不變（來源 offset），React 對齊而不是重掛。
 *
 * 已知的偏差（跟 dsh 一樣）：串流中，引用連結或腳註的定義落在凍結邊界另一側時先照原文，講完的整份解析會補回來。
 *
 * 輸入是模型寫的、不可信：raw HTML 當文字、連結過協定 allowlist、圖片不自動載入（見 `lib/markdown/render.tsx`）。
 */

import { cloneElement, isValidElement, memo, useMemo, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { IncrementalMarkdownParser } from '@/lib/markdown/incremental';
import { parseGfm } from '@/lib/markdown/parse';
import {
  collectReferenceTargets,
  createReferenceTargets,
  renderBlocks,
  renderFootnoteSection,
} from '@/lib/markdown/render';
import type { MarkdownRenderContext, ReferenceTargets } from '@/lib/markdown/render';

function renderSettled(text: string): ReactNode[] {
  const root = parseGfm(text);
  const targets = createReferenceTargets();
  collectReferenceTargets(root.children, targets);
  const context: MarkdownRenderContext = {
    streaming: false,
    targets,
    footnoteOrder: [],
    footnoteCounts: new Map(),
  };
  const blocks = renderBlocks(
    root.children.map((node, index) => ({
      node,
      key: node.position?.start.offset ?? -(index + 1),
    })),
    context,
  );
  const section = renderFootnoteSection(context);
  return section === null ? blocks : [...blocks, section];
}

/**
 * 一則正在長的回覆的串流狀態：增量解析器、凍結 block 的快取元素，以及畫它們時用掉的定義與腳註狀態
 * （凍結部分的腳註編號已定，尾段每次從它的拷貝接著編）。
 */
class StreamingRenderer {
  private readonly parser = new IncrementalMarkdownParser(parseGfm);
  private generation = -1;
  private frozenCount = 0;
  private frozenElements: ReactNode[] = [];
  private frozenTargets: ReferenceTargets = createReferenceTargets();
  private frozenFootnoteOrder: string[] = [];
  private frozenFootnoteCounts = new Map<string, number>();
  private lastText: string | null = null;
  private lastRendered: ReactNode[] = [];

  /** 同一段字重畫時回同一份（React 可以放心重跑 render）。 */
  render(text: string): ReactNode[] {
    if (text === this.lastText) return this.lastRendered;
    const { frozen, tail, generation } = this.parser.update(text);
    if (generation !== this.generation) {
      this.generation = generation;
      this.frozenCount = 0;
      this.frozenElements = [];
      this.frozenTargets = createReferenceTargets();
      this.frozenFootnoteOrder = [];
      this.frozenFootnoteCounts = new Map();
    }
    const newlyFrozen = frozen.slice(this.frozenCount);
    collectReferenceTargets(
      newlyFrozen.map((block) => block.node),
      this.frozenTargets,
    );
    // 這一格看得到的定義：凍結的全部＋這次的尾段。
    const frameTargets: ReferenceTargets = {
      definitions: new Map(this.frozenTargets.definitions),
      footnotes: new Map(this.frozenTargets.footnotes),
    };
    collectReferenceTargets(
      tail.map((block) => block.node),
      frameTargets,
    );
    if (newlyFrozen.length > 0) {
      this.frozenElements = [
        ...this.frozenElements,
        ...renderBlocks(newlyFrozen, {
          streaming: true,
          targets: frameTargets,
          footnoteOrder: this.frozenFootnoteOrder,
          footnoteCounts: this.frozenFootnoteCounts,
        }),
      ];
      this.frozenCount = frozen.length;
    }
    const tailContext: MarkdownRenderContext = {
      streaming: true,
      targets: frameTargets,
      footnoteOrder: [...this.frozenFootnoteOrder],
      footnoteCounts: new Map(this.frozenFootnoteCounts),
    };
    const children = [...this.frozenElements, ...renderBlocks(tail, tailContext)];
    const section = renderFootnoteSection(tailContext);
    if (section !== null) children.push(section);
    this.lastText = text;
    this.lastRendered = children;
    return this.lastRendered;
  }
}

/** 接得進去的最後一塊：段落與標題。清單、表格、程式碼區塊後面的游標只能另起一行。 */
const INLINE_TAIL = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** 把 `caret` 接進最後一塊的字尾（新元素，不動快取裡的那一份）。 */
function withCaret(children: ReactNode[], caret: ReactNode): ReactNode[] {
  const last = children.at(-1);
  if (isValidElement(last) && typeof last.type === 'string' && INLINE_TAIL.has(last.type)) {
    const element = last as ReactElement<{ children?: ReactNode }>;
    return [
      ...children.slice(0, -1),
      cloneElement(element, undefined, element.props.children, caret),
    ];
  }
  return [...children, caret];
}

export const MarkdownText = memo(function MarkdownText({
  text,
  streaming = false,
  caret,
}: {
  readonly text: string;
  readonly streaming?: boolean;
  /** 串流中接在最後一個字後面的東西（游標）。 */
  readonly caret?: ReactNode;
}) {
  const stream = useRef<StreamingRenderer | null>(null);
  const children = useMemo(() => {
    if (!streaming) {
      stream.current = null;
      return renderSettled(text);
    }
    stream.current ??= new StreamingRenderer();
    return stream.current.render(text);
  }, [text, streaming]);
  return (
    <div className="markdown">{caret === undefined ? children : withCaret(children, caret)}</div>
  );
});
