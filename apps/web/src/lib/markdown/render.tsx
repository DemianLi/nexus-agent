/*
 * mdast → React 的直接渲染：照 dsh `packages/client/ui-primitives/src/markdown/render.tsx`（本機 clone `ddefc45`，
 * MIT，Copyright (c) DeepSeek）刪減而來。一個 switch 走過解析出來的節點，所以串流時凍結的 block 可以快取成
 * React 元素（`components/markdown-text.tsx`）。
 *
 * **照搬的安全規則**：連結只放行 http／https／mailto（其他協定與相對路徑都只留文字）；raw HTML 一律當文字，
 * 不進 DOM；站內錨點不過 allowlist，所以腳註只畫上標數字、不做頁內連結。
 *
 * **沒搬的**（nexus 目前沒有對應的東西）：TeX 數學（katex 在 ⑥ 之後）、本機檔案連結與 inline code 的檔案提及
 * （要一個開檔的宿主）、本機路徑圖片、外部連結交給宿主開啟的 delegate。
 *
 * **跟 dsh 不同的一處**：圖片**不自動載入**，畫成指向原圖的連結（文字是 alt）。模型的輸出可以放任何網址，自動
 * 載入等於讓一段回覆替使用者發出請求（網址裡可以帶資料）；而完全內網的部署裡外部圖片本來就載不到，dsh 的退路
 * 也是顯示 alt。UI 不受 dsh 約束（AGENTS.md「技術實現標準」），這裡選不發請求。
 *
 * 認不得的節點型別畫成空（跟 dsh 一樣）：別處註冊的文法可能加新的型別。
 */

import { Fragment, createElement } from 'react';
import type { Key, ReactNode } from 'react';
import type * as Md from 'mdast';
import { normalizeUri } from 'micromark-util-sanitize-uri';

import { CodeBlock } from '@/components/markdown/code-block';

import type { PositionedBlock } from './incremental';

function sanitizeUrl(url: string): string {
  try {
    switch (new URL(url).protocol) {
      case 'http:':
      case 'https:':
      case 'mailto:':
        return url;
      default:
        return '';
    }
  } catch {
    // 相對路徑與其他解析不了的都不放行；`new URL()` 對字串沒有別的失敗方式。
    return '';
  }
}

/** 連結與圖片的定義、腳註定義（同一個 identifier 第一個定義算數，同 CommonMark）。 */
export interface ReferenceTargets {
  definitions: Map<string, Md.Definition>;
  footnotes: Map<string, Md.FootnoteDefinition>;
}

export function createReferenceTargets(): ReferenceTargets {
  return { definitions: new Map(), footnotes: new Map() };
}

/** 深度優先把 `nodes` 底下的定義收進 `targets`，同一個 identifier 留第一個。 */
export function collectReferenceTargets(
  nodes: readonly Md.RootContent[],
  targets: ReferenceTargets,
): void {
  for (const node of nodes) {
    if (node.type === 'definition') {
      const id = node.identifier.toUpperCase();
      if (!targets.definitions.has(id)) targets.definitions.set(id, node);
    } else if (node.type === 'footnoteDefinition') {
      const id = node.identifier.toUpperCase();
      if (!targets.footnotes.has(id)) targets.footnotes.set(id, node);
    }
    if ('children' in node) collectReferenceTargets(node.children, targets);
  }
}

/** 一次渲染的狀態：定義與腳註是唯讀的，腳註編號照文件順序在渲染時累積。 */
export interface MarkdownRenderContext {
  /** 串流中：程式碼區塊邊長邊畫（⑥ 的高亮會用到）。 */
  readonly streaming: boolean;
  readonly targets: ReferenceTargets;
  /** 腳註 identifier，照第一次被引用的順序；編號是 1 起算的位置。 */
  readonly footnoteOrder: string[];
  /** 每個腳註被引用了幾次；決定腳註區的返回記號數。 */
  readonly footnoteCounts: Map<string, number>;
}

/** 畫頂層 block；畫不出東西的（定義、認不得的型別）直接丟掉。 */
export function renderBlocks(
  blocks: readonly PositionedBlock[],
  context: MarkdownRenderContext,
): ReactNode[] {
  return blocks
    .map((block) => renderNode(block.node, block.key, context))
    .filter((element) => element !== null);
}

/** 容器裡的 block，要分得出段落與其他（清單項目在緊湊時把段落拆掉、腳註把返回記號放進最後一段）。 */
type BlockEntry = { paragraph: ReactNode[] } | { element: ReactNode };

function renderBlockEntries(
  blocks: readonly Md.RootContent[],
  context: MarkdownRenderContext,
): BlockEntry[] {
  const entries: BlockEntry[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'paragraph') {
      entries.push({ paragraph: renderChildren(block.children, context) });
    } else {
      const element = renderNode(block, index, context);
      if (element !== null) entries.push({ element });
    }
  }
  return entries;
}

function renderChildren(
  nodes: readonly Md.RootContent[],
  context: MarkdownRenderContext,
): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, index, context));
}

function renderNode(node: Md.RootContent, key: Key, context: MarkdownRenderContext): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'paragraph':
      return <p key={key}>{renderChildren(node.children, context)}</p>;
    case 'heading':
      return createElement(`h${node.depth}`, { key }, ...renderChildren(node.children, context));
    case 'blockquote':
      return <blockquote key={key}>{renderChildren(node.children, context)}</blockquote>;
    case 'thematicBreak':
      return <hr key={key} />;
    case 'break':
      return <br key={key} />;
    case 'strong':
      return <strong key={key}>{renderChildren(node.children, context)}</strong>;
    case 'emphasis':
      return <em key={key}>{renderChildren(node.children, context)}</em>;
    case 'delete':
      return <del key={key}>{renderChildren(node.children, context)}</del>;
    case 'inlineCode': {
      // 同 mdast-util-to-hast：行內 code 的換行畫成空白。
      const value = node.value.replace(/\r?\n|\r/g, ' ');
      // 整段就是一個 http(s) 網址時保留 code 的樣子、多一個安全的連結；指令、半截網址、別的協定照舊只是 code。
      const href = inlineCodeHttpUrl(value);
      if (href !== undefined) return <code key={key}>{renderSafeLink(href, [value], 'link')}</code>;
      return <code key={key}>{value}</code>;
    }
    case 'html':
      // 沒有 HTML 解析器：raw HTML 一律當文字。
      return node.value;
    case 'code':
      return (
        <CodeBlock
          key={key}
          code={node.value}
          lang={
            node.lang === null || node.lang === undefined
              ? undefined
              : /^[\w-]+/.exec(node.lang)?.[0]
          }
          streaming={context.streaming}
        />
      );
    case 'list':
      return renderList(node, key, context);
    case 'listItem':
      // 只有手組的樹會走到：文法產生的清單項目一定在清單裡。
      return renderListItem(node, listItemLoose(node), key, context);
    case 'table':
      return renderTable(node, key, context);
    case 'link':
      return renderSafeLink(normalizeUri(node.url), renderChildren(node.children, context), key);
    case 'linkReference':
      return renderLinkReference(node, key, context);
    case 'image':
      return renderImage(node.url, node.alt ?? '', key);
    case 'imageReference':
      return renderImageReference(node, key, context);
    case 'footnoteReference':
      return renderFootnoteReference(node, key, context);
    case 'definition':
    case 'footnoteDefinition':
      // 定義就地解開引用；腳註本文畫在最後的腳註區。
      return null;
    default:
      return null;
  }
}

/** 清單本身或任何一項是鬆散的，整份清單每項都留段落。 */
function listLoose(list: Md.List): boolean {
  return (list.spread ?? false) || list.children.some(listItemLoose);
}

function listItemLoose(item: Md.ListItem): boolean {
  return item.spread ?? item.children.length > 1;
}

function renderList(node: Md.List, key: Key, context: MarkdownRenderContext): ReactNode {
  const loose = listLoose(node);
  const properties: { start?: number; className?: string } = {};
  if (typeof node.start === 'number' && node.start !== 1) properties.start = node.start;
  if (node.children.some((item) => typeof item.checked === 'boolean')) {
    properties.className = 'contains-task-list';
  }
  return createElement(
    node.ordered === true ? 'ol' : 'ul',
    { key, ...properties },
    ...node.children.map((item, index) => renderListItem(item, loose, index, context)),
  );
}

function renderListItem(
  item: Md.ListItem,
  loose: boolean,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const entries = renderBlockEntries(item.children, context);
  const task = typeof item.checked === 'boolean';
  if (task) {
    const checkbox = (
      <input
        key="task-checkbox"
        type="checkbox"
        checked={item.checked === true}
        disabled
        aria-label={item.checked === true ? '已完成' : '未完成'}
      />
    );
    const head = entries[0];
    if (head !== undefined && 'paragraph' in head) {
      head.paragraph = head.paragraph.length > 0 ? [checkbox, ' ', ...head.paragraph] : [checkbox];
    } else {
      entries.unshift({ paragraph: [checkbox] });
    }
  }
  // 緊湊清單把段落拆開（跟 mdast-util-to-hast 一樣），鬆散的每段留 <p>。
  const parts = entries.map((entry, index) =>
    'paragraph' in entry ? (
      loose ? (
        <p key={`p-${index}`}>{entry.paragraph}</p>
      ) : (
        <Fragment key={`p-${index}`}>{entry.paragraph}</Fragment>
      )
    ) : (
      <Fragment key={`b-${index}`}>{entry.element}</Fragment>
    ),
  );
  return (
    <li key={key} className={task ? 'task-list-item' : undefined}>
      {parts}
    </li>
  );
}

function renderTable(node: Md.Table, key: Key, context: MarkdownRenderContext): ReactNode {
  const align = node.align ?? null;
  const [headRow, ...bodyRows] = node.children;
  return (
    // 表格比欄寬時在自己的框裡橫捲，不撐開整則訊息。tabIndex 讓鍵盤捲得到。
    <div key={key} className="md-table-scroll" tabIndex={0}>
      <table>
        {headRow !== undefined && <thead>{renderTableRow(headRow, 'th', align, 0, context)}</thead>}
        {bodyRows.length > 0 && (
          <tbody>
            {bodyRows.map((row, index) => renderTableRow(row, 'td', align, index + 1, context))}
          </tbody>
        )}
      </table>
    </div>
  );
}

function renderTableRow(
  row: Md.TableRow,
  cellTag: 'th' | 'td',
  align: readonly Md.AlignType[] | null,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  // 有欄對齊時每列剛好一欄一格，多的截掉、少的補空（同 mdast-util-to-hast）。
  const length = align === null ? row.children.length : align.length;
  const cells: ReactNode[] = [];
  for (let index = 0; index < length; index++) {
    const cell = row.children[index];
    const alignValue = align?.[index];
    cells.push(
      createElement(
        cellTag,
        { key: index, style: alignValue == null ? undefined : { textAlign: alignValue } },
        ...(cell === undefined ? [] : renderChildren(cell.children, context)),
      ),
    );
  }
  return <tr key={key}>{cells}</tr>;
}

/** 過了 allowlist 的連結；外部的另開分頁，不帶 referrer。沒過的只留文字。 */
function renderSafeLink(href: string, children: ReactNode[], key: Key): ReactNode {
  const safeHref = sanitizeUrl(href);
  if (safeHref === '') return <Fragment key={key}>{children}</Fragment>;
  const external = safeHref.startsWith('http:') || safeHref.startsWith('https:');
  return (
    <a
      key={key}
      href={safeHref}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}

function inlineCodeHttpUrl(value: string): string | undefined {
  if (value.trim() !== value) return undefined;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 圖片不自動載入（見檔頭）：過了 allowlist 的畫成連結，文字是 alt；沒過的只留 alt。 */
function renderImage(url: string, alt: string, key: Key): ReactNode {
  const href = sanitizeUrl(normalizeUri(url));
  const label = alt === '' ? '圖片' : `圖片：${alt}`;
  if (href === '' || href.startsWith('mailto:')) {
    return (
      <span key={key} className="md-image-alt">
        {label}
      </span>
    );
  }
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="md-image-alt">
      {label}
    </a>
  );
}

/** 找不到定義時，引用退回原本的方括號文字。 */
function referenceSuffix(node: Md.LinkReference | Md.ImageReference): string {
  if (node.referenceType === 'collapsed') return '][]';
  if (node.referenceType === 'full') return `][${node.label ?? node.identifier}]`;
  return ']';
}

function renderLinkReference(
  node: Md.LinkReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const definition = context.targets.definitions.get(node.identifier.toUpperCase());
  if (definition === undefined) {
    // 增量解析時定義可能落在凍結邊界的另一側：先照原文，講完的整份解析會補回來。
    return (
      <Fragment key={key}>
        {'['}
        {renderChildren(node.children, context)}
        {referenceSuffix(node)}
      </Fragment>
    );
  }
  return renderSafeLink(normalizeUri(definition.url), renderChildren(node.children, context), key);
}

function renderImageReference(
  node: Md.ImageReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const definition = context.targets.definitions.get(node.identifier.toUpperCase());
  if (definition === undefined) return `![${node.alt ?? ''}${referenceSuffix(node)}`;
  return renderImage(definition.url, node.alt ?? '', key);
}

function renderFootnoteReference(
  node: Md.FootnoteReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const id = node.identifier.toUpperCase();
  const seen = context.footnoteCounts.get(id);
  if (seen === undefined) context.footnoteOrder.push(id);
  context.footnoteCounts.set(id, (seen ?? 0) + 1);
  return <sup key={key}>{String(context.footnoteOrder.indexOf(id) + 1)}</sup>;
}

/** 這次渲染引用到的腳註，照第一次引用的順序；每被引用一次一個返回記號（純文字）。 */
export function renderFootnoteSection(context: MarkdownRenderContext): ReactNode | null {
  const items: ReactNode[] = [];
  for (const id of context.footnoteOrder) {
    const definition = context.targets.footnotes.get(id);
    if (definition === undefined) continue;
    const count = context.footnoteCounts.get(id) ?? 0;
    const backrefs: ReactNode[] = [];
    for (let reference = 1; reference <= count; reference++) {
      if (backrefs.length > 0) backrefs.push(' ');
      backrefs.push('↩');
      if (reference > 1) backrefs.push(<sup key={`re-${reference}`}>{String(reference)}</sup>);
    }
    const entries = renderBlockEntries(definition.children, context);
    const tail = entries[entries.length - 1];
    const body: ReactNode[] = entries.map((entry, index) =>
      'paragraph' in entry ? (
        <p key={`p-${index}`}>
          {entry.paragraph}
          {entry === tail && <> {backrefs}</>}
        </p>
      ) : (
        <Fragment key={`b-${index}`}>{entry.element}</Fragment>
      ),
    );
    if (tail === undefined || !('paragraph' in tail)) body.push(...backrefs);
    items.push(<li key={id}>{body}</li>);
  }
  if (items.length === 0) return null;
  return (
    <section key="footnotes" className="footnotes" aria-label="腳註">
      <ol>{items}</ol>
    </section>
  );
}
