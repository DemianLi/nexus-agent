import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComposerPick } from '@/components/ui/composer';
import { ContextRing } from '@/components/ui/context-ring';

/**
 * SG 的 `ComposerPick` 與 `ContextRing` 上的 nexus 欄位（README 本地修改第 33、34 條）。每個欄位一組，拿掉那一行 patch 就紅。
 * 產品怎麼用它們驗在 `permission-seat`、`model-seat`、`context-meter` 與 `App.test.tsx`。
 */

afterEach(cleanup);

const OPTIONS = [
  { value: 'a', label: '甲' },
  { value: 'b', label: '乙' },
];

const menu = () => screen.queryByRole('menu');

describe('ComposerPick（patch `0007-composer-pick-trigger`）', () => {
  it('`triggerLabel`：Trigger 的名稱帶現在的值；沒給就照 SG 用 `label`', () => {
    const { rerender } = render(
      <ComposerPick label="選項" value="a" options={OPTIONS} onValueChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '選項' })).toBeTruthy();
    rerender(
      <ComposerPick
        label="選項"
        triggerLabel="選項：甲，點開切換"
        value="a"
        options={OPTIONS}
        onValueChange={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '選項：甲，點開切換' })).toBeTruthy();
    // 選單裡那一行標題照舊是 `label`。
    fireEvent.click(screen.getByRole('button'));
    expect(menu()?.textContent).toContain('選項');
  });

  it('`open`／`onOpenChange`：外面打得開它（`/model`），選了之後回報關掉', async () => {
    const onOpenChange = vi.fn();
    const onValueChange = vi.fn();
    render(
      <ComposerPick
        label="選項"
        value="a"
        options={OPTIONS}
        onValueChange={onValueChange}
        open
        onOpenChange={onOpenChange}
      />,
    );
    expect(menu()).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemradio', { name: '乙' }));
    });
    expect(onValueChange).toHaveBeenCalledWith('b');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('`open` 是受控的：外面沒放開就不關', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            從外面打開
          </button>
          <ComposerPick
            label="選項"
            value="a"
            options={OPTIONS}
            onValueChange={() => {}}
            open={open}
            onOpenChange={setOpen}
          />
        </>
      );
    }
    render(<Host />);
    expect(menu()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '從外面打開' }));
    expect(menu()).not.toBeNull();
  });

  describe('`disabled`：清單打不開，Trigger 照樣聚焦得到（照 dsh `PermissionSelect.tsx:180`）', () => {
    const disabled = (props: { open?: boolean } = {}) => (
      <ComposerPick
        label="權限"
        triggerLabel="權限：預設，這一輪結束後才能切換"
        value="a"
        options={OPTIONS}
        onValueChange={() => {}}
        disabled
        {...props}
      />
    );

    it('Trigger 是 aria-disabled、不是原生 disabled：Tab 走得到，名稱（含原因）聽得到', () => {
      render(disabled());
      const trigger = screen.getByRole('button', { name: '權限：預設，這一輪結束後才能切換' });
      expect(trigger.getAttribute('aria-disabled')).toBe('true');
      expect(trigger.hasAttribute('disabled')).toBe(false);
      trigger.focus();
      expect(document.activeElement).toBe(trigger);
    });

    it.each([
      ['點一下', (el: HTMLElement) => fireEvent.click(el)],
      ['Enter', (el: HTMLElement) => fireEvent.keyDown(el, { key: 'Enter' })],
      ['空白鍵', (el: HTMLElement) => fireEvent.keyDown(el, { key: ' ' })],
      ['方向鍵下', (el: HTMLElement) => fireEvent.keyDown(el, { key: 'ArrowDown' })],
    ])('%s都打不開', (_name, press) => {
      render(disabled());
      const trigger = screen.getByRole('button');
      trigger.focus();
      press(trigger);
      expect(menu()).toBeNull();
    });

    it('外面給了 `open` 也不開（受控時同一條規則）', () => {
      render(disabled({ open: true }));
      expect(menu()).toBeNull();
    });
  });
});

describe('ContextRing（patch `0008-context-ring-body`）', () => {
  it('`label`：Trigger 的名稱換成呼叫端的；沒給就照 SG 的標題加四捨五入的百分比', () => {
    const { rerender } = render(<ContextRing used={755} window={1000} />);
    expect(screen.getByRole('button', { name: 'Context window 76%' })).toBeTruthy();
    rerender(<ContextRing used={755} window={1000} label="對話用量：約 75%，點開看明細" />);
    expect(screen.getByRole('button', { name: '對話用量：約 75%，點開看明細' })).toBeTruthy();
  });

  it('`children`：明細整段換成呼叫端的；沒給就是 SG 的總量、條與說明', () => {
    const { rerender } = render(<ContextRing used={1} window={4} note="SG 的說明" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog').textContent).toContain('SG 的說明');
    rerender(
      <ContextRing used={1} window={4} note="SG 的說明">
        <p>每道門檻一行</p>
      </ContextRing>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toBe('每道門檻一行');
  });
});
