import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

afterEach(cleanup);

function Confirm() {
  return (
    <>
      <button type="button">框外前面</button>
      <AlertDialog>
        <AlertDialogTrigger render={<button type="button" />}>刪除</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>確定刪除？</AlertDialogTitle>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction>確定</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <button type="button">框外後面</button>
    </>
  );
}

async function open() {
  render(<Confirm />);
  const trigger = screen.getByRole('button', { name: '刪除' });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('alertdialog');
  await waitFor(() => expect(document.activeElement?.textContent).toBe('取消'));
  return { trigger, dialog };
}

test('焦點困在框內：框外標成讀不到，Tab 走出兩端會被接回框裡', async () => {
  const { dialog } = await open();

  for (const name of ['框外前面', '刪除', '框外後面'])
    expect(screen.getByText(name).closest('[aria-hidden="true"]')).not.toBeNull();
  expect(dialog.closest('[aria-hidden="true"]')).toBeNull();

  const [before, after] = [...document.querySelectorAll<HTMLElement>('[data-base-ui-focus-guard]')];
  expect(before!.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(after!.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

  act(() => after!.focus());
  await waitFor(() => expect(document.activeElement?.textContent).toBe('取消'));
  act(() => before!.focus());
  await waitFor(() => expect(document.activeElement?.textContent).toBe('確定'));
});

test.each([
  ['按取消', () => fireEvent.click(screen.getByRole('button', { name: '取消' }))],
  ['按確定', () => fireEvent.click(screen.getByRole('button', { name: '確定' }))],
  ['按 Esc', (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: 'Escape' })],
])('%s 關掉之後焦點回到觸發的那顆', async (_name, close) => {
  const { trigger, dialog } = await open();
  close(dialog);
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
