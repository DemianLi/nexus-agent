import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';

import { App } from '@/App';

afterEach(cleanup);

describe('App', () => {
  it('顯示專案名稱', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'nexus-agent' })).toBeTruthy();
  });

  it('按下按鈕會累加執行次數', () => {
    render(<App />);

    expect(screen.getByRole('status').textContent).toContain('0');

    fireEvent.click(screen.getByRole('button', { name: /執行 harness/ }));

    expect(screen.getByRole('status').textContent).toContain('1');
  });
});
