import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { InputGroupAddon as VendorInputGroupAddon } from '@/vendor/solid-glass/components/ui/input-group';

afterEach(cleanup);

/**
 * 點 addon 的空白處把焦點交給欄位（README 本地修改第 16 條，#1523）：vendor 只找 `input`，輸入框用的是 textarea，
 * 所以 nexus 層連 textarea 一起找。
 */
describe('InputGroupAddon：點空白處把焦點交給欄位', () => {
  test('欄位是 textarea 時也拿得到焦點（輸入框就是這樣組的）', () => {
    render(
      <InputGroup>
        <InputGroupTextarea aria-label="要說的話" />
        <InputGroupAddon align="block-end" data-testid="addon">
          <InputGroupButton aria-label="送出">送</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    );
    fireEvent.click(screen.getByTestId('addon'));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '要說的話' }));
  });

  test('vendor 原文仍只找 input：上游哪天改好了，這條紅，提醒把本地修改拿掉', () => {
    render(
      <InputGroup>
        <InputGroupTextarea aria-label="要說的話" />
        <VendorInputGroupAddon align="block-end" data-testid="addon" />
      </InputGroup>,
    );
    fireEvent.click(screen.getByTestId('addon'));
    expect(document.activeElement).toBe(document.body);
  });

  test('欄位是 input 時照舊', () => {
    render(
      <InputGroup>
        <InputGroupInput aria-label="搜尋" />
        <InputGroupAddon data-testid="addon">⌘K</InputGroupAddon>
      </InputGroup>,
    );
    fireEvent.click(screen.getByTestId('addon'));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '搜尋' }));
  });

  test('點到 addon 裡的按鈕不搶焦點', () => {
    render(
      <InputGroup>
        <InputGroupTextarea aria-label="要說的話" />
        <InputGroupAddon align="block-end">
          <InputGroupButton aria-label="送出">送</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    );
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: '要說的話' }));
  });

  test('呼叫端自己傳 onClick 時由呼叫端的蓋掉（跟 vendor 一樣）', () => {
    const onClick = vi.fn();
    render(
      <InputGroup>
        <InputGroupTextarea aria-label="要說的話" />
        <InputGroupAddon data-testid="addon" onClick={onClick} />
      </InputGroup>,
    );
    fireEvent.click(screen.getByTestId('addon'));
    expect(onClick).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(document.body);
  });
});
