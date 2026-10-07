import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { Button } from '@/components/ui/button';

afterEach(cleanup);

test('預設按鈕同時帶著字級與字色（cn 不能把其中一個吃掉）', () => {
  render(<Button>送出</Button>);
  const classes = screen.getByRole('button', { name: '送出' }).className.split(/\s+/);
  expect(classes).toContain('text-body');
  expect(classes).toContain('text-primary-foreground');
});
