/*
 * TeX → React（#406）：照 dsh `packages/client/ui-primitives/src/markdown/katex.tsx`（本機 clone `ddefc45`，MIT，
 * Copyright (c) DeepSeek）。三段錯誤處理照搬：先嚴格畫、失敗再用 `strict: 'ignore'` 重畫、還是不行就畫錯誤
 * span。KaTeX 給的是 HTML 字串，交給瀏覽器自己的 `DOMParser`（它套用 SVG／MathML 外來內容的屬性修正，KaTeX
 * 的輸出靠這個）轉成樹，再逐個對到 React 元素。KaTeX 的輸出是固定的 span／MathML／SVG 詞彙，沒有使用者的
 * HTML 經過，跟 `CodeBlock` 用 shiki 的 HTML 同一個信任等級；也不開 `trust`，所以 `\href` 這類指令不會變成連結。
 *
 * `.katex-mathml` 那棵子樹給輔助技術讀（照標籤名讀，不看 namespace）；看得到的是 `.katex-html` 那棵 span 樹。
 *
 * **跟 dsh 不同的一處**（外觀，AGENTS.md「技術實現標準」不約束 UI）：錯誤色用 `--destructive`，不用 KaTeX
 * 預設的 `#cc0000`——那個顏色在暗色的底上對比度不夠。
 */

import { createElement } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import katex from 'katex';

const ERROR_COLOR = 'var(--destructive)';

/** 一條 inline `style` 字串轉成 React 的 style 物件。KaTeX 只寫一般的 kebab-case 宣告，camelCase 就是全部的轉換。 */
function styleObject(css: string): CSSProperties {
  const style: Record<string, string> = {};
  for (const declaration of css.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim();
    const key = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    style[key] = declaration.slice(colon + 1).trim();
  }
  return style;
}

/** 解析出來的一個 DOM 節點對到 React 元素（文字節點原樣過）。 */
function domToReact(node: ChildNode, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  // KaTeX 的輸出只有元素與文字。
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  const props: Record<string, unknown> = { key };
  for (const attribute of element.attributes) {
    if (attribute.name === 'class') props.className = attribute.value;
    else if (attribute.name === 'style') props.style = styleObject(attribute.value);
    else props[attribute.name] = attribute.value;
  }
  const children = [...element.childNodes].map(domToReact);
  return children.length === 0
    ? createElement(element.localName, props)
    : createElement(element.localName, props, ...children);
}

/**
 * 用 KaTeX 把 TeX 畫成 React 元素。
 * @param value TeX 原文（math 節點的值；` ```math ` fence 要自己補上結尾換行，同 dsh）。
 * @param displayMode 區塊（true）或行內。
 */
export function renderTexToReact(value: string, displayMode: boolean): ReactNode {
  let html: string;
  try {
    html = katex.renderToString(value, {
      displayMode,
      throwOnError: true,
      errorColor: ERROR_COLOR,
    });
  } catch (error) {
    try {
      html = katex.renderToString(value, {
        displayMode,
        strict: 'ignore',
        throwOnError: false,
        errorColor: ERROR_COLOR,
      });
    } catch {
      // throwOnError: false 時 KaTeX 自己畫 ParseError；會到這裡的只有它的內部錯誤。
      return (
        <span className="katex-error" style={{ color: ERROR_COLOR }} title={String(error)}>
          {value}
        </span>
      );
    }
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return [...parsed.body.childNodes].map(domToReact);
}
