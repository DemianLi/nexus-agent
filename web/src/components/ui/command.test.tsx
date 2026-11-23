import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { Command, CommandDialog, CommandItem, CommandList } from '@/components/ui/command';
import { stubCmdkLayout } from '@/test/cmdk';

/**
 * `CommandDialog` 預設的標題與說明是中文（README 本地修改第 26 條）：vendor 原文是 "Command Palette"／"Search for a command to run..."。
 * 產品碼目前沒用到 CommandDialog，這條釘住包裝層的預設，免得哪天直接轉出 vendor 版就靜靜換回英文。
 */

beforeEach(stubCmdkLayout);
afterEach(cleanup);

test('CommandDialog 沒給標題與說明時，報讀到的是中文預設', () => {
  render(
    // SG 的 CommandDialog 不自己包 `Command`（跟 develop 那版不同），由呼叫端包。
    <CommandDialog open>
      <Command>
        <CommandList>
          <CommandItem>選項</CommandItem>
        </CommandList>
      </Command>
    </CommandDialog>,
  );
  const dialog = screen.getByRole('dialog', { name: '命令選單' });
  expect(dialog.getAttribute('aria-describedby')).not.toBeNull();
  expect(document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
    '搜尋要執行的命令…',
  );
  expect(document.body.textContent).not.toMatch(/Command Palette|Search for a command/u);
});
