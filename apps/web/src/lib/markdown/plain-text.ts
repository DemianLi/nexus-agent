/*
 * markdown 投影成純文字，給精簡的摘要與標題用：照 dsh `packages/client/ui-primitives/src/markdown/plain-text.ts`
 * （`477b4f4`，MIT，Copyright (c) DeepSeek）。解析跟畫面共用串流那一臂的文法（{@link parseGfm}），所以拿掉的正好是
 * 畫面會畫成樣式的那些記號；raw HTML 照字面留著，連結留文字，圖片留替代文字，程式碼留原文。
 */

import { parseGfm } from './parse';

/** 取多少：整份、第一行看得到的字，或第一個段落。 */
export type MarkdownPlainTextMode = 'all' | 'first-line' | 'first-paragraph';

interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly alt?: string | null;
  readonly children?: readonly MarkdownNode[];
}

function inlineText(node: MarkdownNode): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
      return node.value ?? '';
    case 'image':
    case 'imageReference':
      return node.alt ?? '';
    case 'break':
      return '\n';
    case 'html':
      return node.value ?? '';
    default:
      return node.children?.map(inlineText).join('') ?? '';
  }
}

function compactInline(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function blockText(node: MarkdownNode): string {
  switch (node.type) {
    case 'root':
    case 'blockquote':
      return node.children?.map(blockText).filter(Boolean).join('\n\n') ?? '';
    case 'paragraph':
    case 'heading':
      return compactInline(inlineText(node));
    case 'code':
      return node.value?.trim() ?? '';
    case 'list':
      return node.children?.map(blockText).filter(Boolean).join('\n') ?? '';
    case 'listItem':
      return node.children?.map(blockText).filter(Boolean).join(' ') ?? '';
    case 'table':
      return node.children?.map(blockText).filter(Boolean).join('\n') ?? '';
    case 'tableRow':
      return node.children?.map(blockText).join('\t') ?? '';
    case 'tableCell':
      return compactInline(inlineText(node));
    case 'html':
      return node.value ?? '';
    case 'thematicBreak':
    case 'definition':
      return '';
    default:
      return compactInline(inlineText(node));
  }
}

function findFirstParagraph(node: MarkdownNode): string | undefined {
  if (node.type === 'paragraph') {
    const text = compactInline(inlineText(node));
    if (text !== '') return text;
  }
  for (const child of node.children ?? []) {
    const text = findFirstParagraph(child);
    if (text !== undefined) return text;
  }
  return undefined;
}

function fullText(root: MarkdownNode): string {
  return blockText(root)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * 解析 GFM、拿掉呈現用的記號，raw HTML 照字面留著。
 *
 * @param mode - `first-line` 是第一行看得到的字；`first-paragraph` 是第一個語意上的段落（標題、清單項目裡的段落也算，
 *   找不到段落就退回第一行）。
 */
export function markdownPlainText(markdown: string, mode: MarkdownPlainTextMode = 'all'): string {
  const root = parseGfm(markdown) as MarkdownNode;
  const all = fullText(root);
  switch (mode) {
    case 'all':
      return all;
    case 'first-line':
      return all.split('\n').find((line) => line !== '') ?? '';
    case 'first-paragraph':
      return findFirstParagraph(root) ?? all.split('\n').find((line) => line !== '') ?? '';
  }
}
