/*
 * 兩套 mdast 文法，一臂一套：照 dsh `packages/client/ui-primitives/src/markdown/parse.ts`（本機 clone `ddefc45`，MIT）。
 * 每一臂自己一致（增量解析的尾段、整份解析、純文字投影對 block 從哪開始到哪結束都一樣）；講完那套就是串流那套
 * 再加 TeX，所以兩臂只在 TeX 分隔符開頭的地方不同——`$$` 區塊串流中是段落、講完是 math 區塊，這是設計。
 */

import type { Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';

import { cjkFriendlyStrong } from './cjk-friendly-strong';
import { mathCompatibility } from './math-compatibility';

/**
 * 串流那一臂：GFM（表格、刪除線、task list、自動連結、腳註）＋中文夾標點的粗體，沒有 TeX——寫到一半的公式
 * 不會閃 KaTeX 的錯誤。
 */
export function parseGfm(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm(), cjkFriendlyStrong()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

/** 講完那一臂：{@link parseGfm} 再加 TeX（`$…$`、`$$…$$`，以及 `\(…\)`、`\[…\]`）。 */
export function parseGfmWithMath(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm(), cjkFriendlyStrong(), mathCompatibility(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
}
