/*
 * 照 dsh `packages/client/ui-primitives/src/markdown/parse.ts`（本機 clone `ddefc45`，MIT）的串流那一臂。
 * dsh 講完後改用多了 TeX 的第二套文法（`parseGfmWithMath`）；nexus 還沒有 katex（規格 §4.2 列 14，⑥ 之後），
 * 所以講完與串流中用同一套文法，兩者的 block 邊界自然一致。
 */

import type { Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

import { cjkFriendlyStrong } from './cjk-friendly-strong';

/** GFM（表格、刪除線、task list、自動連結、腳註）＋中文夾標點的粗體。 */
export function parseGfm(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm(), cjkFriendlyStrong()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}
