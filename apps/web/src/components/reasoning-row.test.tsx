import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { ReasoningRow } from '@/components/reasoning-row';

afterEach(cleanup);

/**
 * 推理列的轉接層（#1683）：`{text, running}` → SG 的 `Reasoning`。每一條對到一行接線，拿掉那一行就紅（PR 內文有突變表）。
 * 畫出來的樣子（展開後藏摘要、`white-space`、箭頭、44px、shimmer 的動畫）在 `guard/` 量。
 */

const LONG =
  '\n**First** we list the files.\nThen we read a.txt.\n\n- a.txt\n- b.txt\n\n```\nls\n```\nNow read b.txt.\n';

const row = () => screen.getByTestId('reasoning-row');
const summary = () => row().querySelector('summary')!;
const details = () => row().querySelector('details')!;
/** summary 的名稱取自內容、跳過 `aria-hidden`：這裡只有純文字，照這條算就等於 accname。 */
function nameOf(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"], [aria-hidden=""]'))
    hidden.remove();
  return copy.textContent?.trim() ?? '';
}

describe('內文', () => {
  test('畫成 markdown：有 strong、清單、程式碼區塊，沒有字面的 **', () => {
    render(<ReasoningRow text={LONG} running={false} />);
    const body = row().querySelector('.markdown')!;
    expect(body.querySelector('strong')?.textContent).toBe('First');
    expect(body.querySelectorAll('ul > li')).toHaveLength(2);
    expect(body.querySelector('pre')?.textContent).toContain('ls');
    expect(body.textContent).not.toContain('**');
  });

  test('包一層 whitespace-normal，擋掉 SG 內文框往下繼承的 pre-wrap', () => {
    render(<ReasoningRow text={LONG} running={false} />);
    expect(row().querySelector('.markdown')?.parentElement?.className).toBe('whitespace-normal');
  });

  test('照 SG 一直掛載：收著時內文已經在 DOM 裡', () => {
    render(<ReasoningRow text={LONG} running={false} />);
    expect(details().open).toBe(false);
    expect(row().querySelector('.markdown')).not.toBeNull();
  });
});

describe('標題', () => {
  test('串流中是「思考中」、帶 SG 的 status-shimmer', () => {
    render(<ReasoningRow text={LONG} running />);
    const title = summary().querySelector('span')!;
    expect(title.textContent).toBe('思考中');
    expect(title.classList.contains('status-shimmer')).toBe(true);
  });

  test('講完是「思考過程」、不帶 shimmer', () => {
    render(<ReasoningRow text={LONG} running={false} />);
    const title = summary().querySelector('span')!;
    expect(title.textContent).toBe('思考過程');
    expect(title.classList.contains('status-shimmer')).toBe(false);
  });
});

describe('收合時的摘要（trailing）', () => {
  test('串流中是最新一行', () => {
    render(<ReasoningRow text={LONG} running />);
    expect(screen.getByTestId('reasoning-summary').textContent).toBe('Now read b.txt.');
  });

  test('講完是第一行、拿掉 **', () => {
    render(<ReasoningRow text={LONG} running={false} />);
    expect(screen.getByTestId('reasoning-summary').textContent).toBe('First we list the files.');
  });

  test('摘要與「·」在 summary 裡、都 aria-hidden，不進名稱', () => {
    render(<ReasoningRow text={LONG} running />);
    const s = summary();
    expect(s.textContent).toContain('·');
    expect(s.textContent).toContain('Now read b.txt.');
    expect(nameOf(s)).toBe('思考中');
  });

  test('展開後藏起來：「·」與摘要都掛 group-open/reasoning:hidden', () => {
    render(<ReasoningRow text={LONG} running={false} />);
    const dot = [...summary().querySelectorAll('span')].find((s) => s.textContent === '·')!;
    expect(dot.className).toContain('group-open/reasoning:hidden');
    expect(screen.getByTestId('reasoning-summary').className).toContain(
      'group-open/reasoning:hidden',
    );
  });

  test('推理只有空白時沒有「·」也沒有摘要', () => {
    render(<ReasoningRow text={'\n  \n'} running={false} />);
    expect(summary().textContent).toBe('思考過程');
    expect(screen.queryByTestId('reasoning-summary')).toBeNull();
  });
});

describe('開關', () => {
  test('點 summary 打開、再點收起', () => {
    render(<ReasoningRow text={LONG} running={false} />);
    expect(details().open).toBe(false);
    fireEvent.click(summary());
    expect(details().open).toBe(true);
    fireEvent.click(summary());
    expect(details().open).toBe(false);
  });

  test('原生 summary，不另加 role、aria-expanded', () => {
    render(<ReasoningRow text={LONG} running={false} />);
    expect(summary().hasAttribute('role')).toBe(false);
    expect(summary().hasAttribute('aria-expanded')).toBe(false);
  });
});
