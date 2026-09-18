import axe from 'axe-core';

/**
 * `.docs/web-ui-spec.md` §11 第 6 條的掃描 helper：對一塊畫好的 DOM 跑 axe-core，回傳違規清單（空＝通過）。
 *
 * **jsdom 沒有版面**，所以 `color-contrast` 關掉：對比度由 `src/styles/tokens-contrast.test.ts` 對 token 重算，
 * 真的像素要靠人工抽驗（§5）。其他規則照 axe 預設，標準是 WCAG 2.2 AA。
 * 各張卡把自己碰到的畫面加進來；必掃四畫面見 #400。
 */
export async function axeViolations(root: Element): Promise<string[]> {
  const result = await axe.run(root, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    },
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations.flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id}：${node.target.join(' ')}（${violation.help}）`),
  );
}
