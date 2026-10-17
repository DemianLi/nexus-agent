import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

/**
 * 關閉鈕的報讀名稱是中文「關閉」（README 本地修改第 20 條，patch `0002-dialog-close-label`、`0003-sheet-close-label`）：
 * vendor 原文是寫死的 "Close"。框要打開才掃得到（`history-ui.test.tsx` 只掃已經掛上的 DOM），所以這裡各自打開。
 */

afterEach(cleanup);

test('dialog 右上角的關閉鈕與 footer 的關閉鈕都叫「關閉」', () => {
  render(
    <Dialog defaultOpen>
      <DialogContent>
        <DialogTitle>標題</DialogTitle>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>,
  );
  const dialog = screen.getByRole('dialog');
  expect(screen.getAllByRole('button', { name: '關閉' })).toHaveLength(2);
  expect(dialog.textContent).not.toContain('Close');
});

test('sheet 的關閉鈕叫「關閉」', () => {
  render(
    <Sheet defaultOpen>
      <SheetContent>
        <SheetTitle>側欄</SheetTitle>
      </SheetContent>
    </Sheet>,
  );
  expect(screen.getByRole('button', { name: '關閉' })).toBeTruthy();
  expect(screen.getByRole('dialog').textContent).not.toContain('Close');
});
