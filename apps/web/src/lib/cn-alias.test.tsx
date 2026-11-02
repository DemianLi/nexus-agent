import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { Button } from '@/vendor/solid-glass/components/ui/button';

afterEach(cleanup);

/**
 * vendor 的 solid-glass 元件 `import { cn } from "cn"`，解析層把裸的 `cn` 換成 `lib/utils.ts`（`resolve-alias.ts`，#1523）。
 * 這裡渲染的是**vendor 原樣**的 Button（不經 `components/ui`），所以拿掉別名就紅：npm 的 `cn` 把 `text-ui` 當成文字顏色，
 * 吃掉 `text-primary-foreground`、留下 `text-sm`（#1141）；`rounded-row` 也不認得，跟 `rounded-md` 兩個都留。
 * build 走的 Vite 解析與 tsconfig 的 `paths` 在 `vite-config.test.ts` 對。
 */
describe('vendor 元件的 cn 解析到 lib/utils.ts（#1523）', () => {
  test('傳 text-ui：字色還在、text-sm 被換掉', () => {
    render(<Button className="text-ui">送出</Button>);
    const classes = screen.getByRole('button', { name: '送出' }).className.split(/\s+/);
    expect(classes).toContain('text-ui');
    expect(classes).toContain('text-primary-foreground');
    expect(classes).not.toContain('text-sm');
  });

  test('傳 rounded-row：rounded-md 被換掉', () => {
    render(<Button className="rounded-row">送出</Button>);
    const classes = screen.getByRole('button', { name: '送出' }).className.split(/\s+/);
    expect(classes).toContain('rounded-row');
    expect(classes).not.toContain('rounded-md');
  });
});
