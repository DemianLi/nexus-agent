import { formatSessionReferenceMention } from '@nexus/wire';
import type {
  FileReferenceCandidate,
  FileReferenceListOutcome,
  SessionReferenceCandidate,
  SessionReferenceListOutcome,
  SlashDescriptor,
} from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Composer } from '@/components/composer';
import type { SendHint, SubmitGesture } from '@/lib/submit-mode';
import { axeViolations } from '@/test/axe';
import { stubCmdkLayout } from '@/test/cmdk';

/** 輸入框與 `/` 選單（#407）。 */

beforeEach(stubCmdkLayout);
afterEach(cleanup);

const plan: SlashDescriptor = {
  name: 'plan',
  description: '進出計劃模式。',
  input: { hint: '[off]' },
};
// 真的伺服器給的 `/feedback` 帶參數（`<內容>`），光打名字另有動作（開回饋框）：選單要直接執行它。
const feedback: SlashDescriptor = {
  name: 'feedback',
  description: '留一則回饋。',
  input: { hint: '<內容>' },
};
const todo: SlashDescriptor = { name: 'todo', description: '列出待辦。' };
const goal: SlashDescriptor = {
  name: 'goal',
  description: '設定目標。',
  input: { hint: '<目標>' },
};

function Harness({
  initial = '',
  canSend = true,
  run = () => true,
  onSubmit = () => {},
  sendHint,
  onSteerQueue,
  withAttachment = false,
  fileReferences,
  sessionReferences,
  seats,
  stoppable = false,
  stopDisabled = false,
  onStop = () => {},
  textareaRef,
}: {
  initial?: string;
  canSend?: boolean;
  run?: (line: string) => boolean;
  onSubmit?: (draft: string, gesture: SubmitGesture) => void;
  sendHint?: SendHint;
  onSteerQueue?: () => void;
  /** 草稿裡有一個附件：沒打字也算送得出去。 */
  withAttachment?: boolean;
  fileReferences?: (query: string, signal: AbortSignal) => Promise<FileReferenceListOutcome>;
  sessionReferences?: (query: string, signal: AbortSignal) => Promise<SessionReferenceListOutcome>;
  seats?: ReactNode;
  stoppable?: boolean;
  stopDisabled?: boolean;
  onStop?: () => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <main>
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        placeholder="說點什麼…"
        canSend={canSend && (draft.trim() !== '' || withAttachment)}
        onSubmit={(gesture) => {
          onSubmit(draft, gesture);
          setDraft('');
        }}
        {...(sendHint === undefined ? {} : { sendHint })}
        {...(onSteerQueue === undefined ? {} : { onSteerQueue })}
        {...(withAttachment
          ? {
              attachments: {
                items: [{ id: 'a1', kind: 'file' as const, file: new File(['x'], 'a.pdf') }],
                onAdd: () => {},
                onRemove: () => {},
              },
            }
          : {})}
        commands={[plan, feedback, goal, todo]}
        decorated={new Set(['feedback'])}
        onRunCommand={run}
        stoppable={stoppable}
        stopDisabled={stopDisabled}
        onStop={onStop}
        {...(textareaRef === undefined ? {} : { textareaRef })}
        {...(fileReferences === undefined ? {} : { fileReferences })}
        {...(sessionReferences === undefined ? {} : { sessionReferences })}
        {...(seats === undefined ? {} : { seats })}
      />
    </main>
  );
}

const input = () => screen.getByLabelText<HTMLTextAreaElement>('要說的話');
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const key = (key: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(input(), { key, ...init });
const options = () =>
  within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((option) => option.textContent);
const selected = () =>
  within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .find((option) => option.getAttribute('aria-selected') === 'true');

describe('送出', () => {
  it('Enter 送出，Shift＋Enter 換行，選字中的 Enter 不送', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type('記一筆');
    key('Enter', { shiftKey: true });
    key('Enter', { isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    key('Enter');
    expect(onSubmit).toHaveBeenCalledWith('記一筆', 'enter');
    expect(input().value).toBe('');
  });

  it('Cmd/Ctrl＋Enter 也送出，標成加速；送出鈕同 Enter（#710）', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type('改用 X');
    key('Enter', { ctrlKey: true });
    type('先別動');
    key('Enter', { metaKey: true });
    type('多按了 Shift');
    key('Enter', { metaKey: true, shiftKey: true });
    expect(input().value).toBe('多按了 Shift');
    type('按鈕');
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    expect(onSubmit.mock.calls).toEqual([
      ['改用 X', 'accelerated'],
      ['先別動', 'accelerated'],
      ['按鈕', 'enter'],
    ]);
  });

  it('只攔輸入框的鍵：焦點在「＋」或附件的移除鈕時，Cmd/Ctrl＋Enter 不送出（#1591）', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} withAttachment />);
    type('還沒打完');
    for (const button of [
      screen.getByRole('button', { name: '加入附件' }),
      screen.getByRole('button', { name: /移除/ }),
    ])
      fireEvent.keyDown(button, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input().value).toBe('還沒打完');
  });

  it('草稿空白時 Cmd/Ctrl＋Enter 改成把排著的全部改成插話；有字或沒給就照舊（#710）', () => {
    const onSteerQueue = vi.fn();
    const onSubmit = vi.fn();
    const { unmount } = render(<Harness onSteerQueue={onSteerQueue} onSubmit={onSubmit} />);
    key('Enter', { ctrlKey: true });
    key('Enter', { metaKey: true });
    expect(onSteerQueue).toHaveBeenCalledTimes(2);
    // 只按 Enter、多按 Shift：不歸它管。
    key('Enter');
    key('Enter', { ctrlKey: true, shiftKey: true });
    expect(onSteerQueue).toHaveBeenCalledTimes(2);
    // 有字：是送出。
    type('改用 X');
    key('Enter', { ctrlKey: true });
    expect(onSteerQueue).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenCalledWith('改用 X', 'accelerated');
    unmount();
    // 沒給：跟以前一樣什麼都不做。
    const quiet = vi.fn();
    render(<Harness onSubmit={quiet} />);
    key('Enter', { ctrlKey: true });
    expect(quiet).not.toHaveBeenCalled();
  });

  it('草稿空白但有附件：Cmd/Ctrl＋Enter 是帶著附件送出，不是把佇列改成插話', () => {
    const onSteerQueue = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onSteerQueue={onSteerQueue} onSubmit={onSubmit} withAttachment />);
    key('Enter', { ctrlKey: true });
    expect(onSteerQueue).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('', 'accelerated');
  });

  // 畫面上不寫（#1591 Q3），只掛在輸入框的描述上，報讀還聽得到。
  it('送出的說明只給報讀：預設「Enter 送出」是輸入框的描述，呼叫端可以換掉', () => {
    const description = () => {
      const id = screen.getByRole('textbox', { name: '要說的話' }).getAttribute('aria-describedby');
      return id === null ? null : document.getElementById(id);
    };
    const { unmount } = render(<Harness />);
    expect(description()?.textContent).toBe('Enter 送出');
    expect(description()?.className).toContain('sr-only');
    unmount();
    render(<Harness sendHint={{ text: 'Enter 排隊', wide: '・Ctrl+Enter 插話' }} />);
    expect(description()?.textContent).toBe('Enter 排隊・Ctrl+Enter 插話');
  });

  it('送不出去時 Enter 不送、送出鍵按不下去', () => {
    const onSubmit = vi.fn();
    render(<Harness canSend={false} onSubmit={onSubmit} />);
    type('記一筆');
    key('Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '送出' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('主按鈕（照 dsh `InputBar.tsx:323-344`，#1591）', () => {
  const button = (name: string) => screen.queryByRole('button', { name });

  it('沒在跑：只有送出，草稿空時按不下去', () => {
    render(<Harness />);
    expect(button('停止')).toBeNull();
    expect(button('送出')?.hasAttribute('disabled')).toBe(true);
    type('記一筆');
    expect(button('送出')?.hasAttribute('disabled')).toBe(false);
  });

  it('跑著、草稿空：主按鈕是停止，按下去叫 onStop', () => {
    const onStop = vi.fn();
    render(<Harness stoppable onStop={onStop} />);
    expect(button('送出')).toBeNull();
    fireEvent.click(button('停止')!);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('跑著、有草稿：主按鈕是送出，名稱說出這一下是排隊；按下去是 Enter 的送法', () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    render(<Harness stoppable onStop={onStop} onSubmit={onSubmit} />);
    type('下一句');
    expect(button('停止')).toBeNull();
    fireEvent.click(button('排隊送出')!);
    expect(onSubmit).toHaveBeenCalledWith('下一句', 'enter');
    expect(onStop).not.toHaveBeenCalled();
  });

  it('跑著、草稿是命令：照舊叫「送出」，不說排隊（dsh 的 plainMessageDraft）', () => {
    render(<Harness stoppable />);
    type('/feedback 好用');
    expect(button('排隊送出')).toBeNull();
    expect(button('送出')?.hasAttribute('disabled')).toBe(false);
  });

  it('跑著、草稿送不出去（例如跑著時不收的命令）：主按鈕是停止（dsh 的 blocked）', () => {
    const onStop = vi.fn();
    render(<Harness stoppable canSend={false} onStop={onStop} />);
    type('/plan');
    expect(button('送出')).toBeNull();
    fireEvent.click(button('停止')!);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('斷線：沒有可按的停止；草稿空時是按不下去的送出', () => {
    render(<Harness stoppable stopDisabled />);
    expect(button('停止')).toBeNull();
    expect(button('送出')?.hasAttribute('disabled')).toBe(true);
  });
});

describe('從外面拿得到輸入框（README 本地修改第 29 條，patch `0005-composer-combobox`）', () => {
  // App 用這顆 ref 把焦點放回輸入框（選了座位、關了面板之後）。vendor 的 textarea ref 是內部的，0005 把同一個元素交出來。
  it('textareaRef 指到的就是那個輸入框', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Harness textareaRef={ref} />);
    expect(ref.current).toBe(input());
    ref.current?.focus();
    expect(document.activeElement).toBe(input());
  });
});

describe('寬度變了高度跟著重算（README 本地修改第 32 條，patch `0006-composer-width-resize`，回補上游 e867a7a9）', () => {
  /** 假的 ResizeObserver：記下觀察誰、能手動送一筆寬度、記得有沒有 disconnect。 */
  class FakeResizeObserver {
    static all: FakeResizeObserver[] = [];
    readonly targets: Element[] = [];
    disconnected = false;
    constructor(private readonly callback: ResizeObserverCallback) {
      FakeResizeObserver.all.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
    fire(width: number) {
      act(() =>
        this.callback(
          [{ contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        ),
      );
    }
  }
  const observerOf = (el: Element) => {
    const found = FakeResizeObserver.all.find((o) => o.targets.includes(el));
    if (found === undefined) throw new Error('沒有人觀察輸入框');
    return found;
  };
  /** jsdom 不排版，scrollHeight 恆為 0：改成「內容要多高」由測試指定。 */
  const contentHeight = (el: HTMLElement, px: number) =>
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => px });

  beforeEach(() => {
    FakeResizeObserver.all = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('草稿不變、寬度變了（例如打開右側欄）：高度照新的換行重算', () => {
    render(<Harness initial="一段會換行的草稿" />);
    const observer = observerOf(input());
    contentHeight(input(), 104);
    observer.fire(540);
    expect(input().style.height).toBe('104px');
    contentHeight(input(), 152);
    observer.fire(348);
    expect(input().style.height).toBe('152px');
  });

  it('寬度沒變（只有高度變，例如寫入新高度本身）不重算：不會自己回授', () => {
    render(<Harness initial="一段會換行的草稿" />);
    const observer = observerOf(input());
    contentHeight(input(), 104);
    observer.fire(540);
    contentHeight(input(), 152);
    observer.fire(540);
    expect(input().style.height).toBe('104px');
  });

  it('卸載時 disconnect', () => {
    const { unmount } = render(<Harness initial="草稿" />);
    const observer = observerOf(input());
    expect(observer.disconnected).toBe(false);
    unmount();
    expect(observer.disconnected).toBe(true);
  });
});

describe('選單錨在輸入框上（README 本地修改第 19 條，#1583）', () => {
  // vendor 的 PopoverContent 原本不把 `anchor` 傳給 Positioner（patch `0001-popover-anchor`）：拿掉那條 patch，composer 沒有
  // PopoverTrigger，浮層就沒有錨點，`--anchor-width` 不會是輸入框的寬度。
  it('Positioner 量的是輸入框那一格：`--anchor-width` 等於它的寬', async () => {
    render(<Harness />);
    const anchor = document.querySelector<HTMLElement>('[data-slot="popover-anchor"]');
    expect(anchor).not.toBeNull();
    vi.spyOn(anchor!, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 40, y: 600, width: 480, height: 120 }),
    );
    type('/');
    await waitFor(() => {
      const positioner = screen
        .getByRole('listbox')
        .closest<HTMLElement>('[style*="--anchor-width"]');
      expect(positioner?.style.getPropertyValue('--anchor-width')).toBe('480px');
    });
    // 寬度那一格用的就是這個變數。
    expect(screen.getByLabelText('命令選單').className).toContain('w-(--anchor-width)');
  });

  it('焦點一直留在輸入框：打開不搬、Esc 關掉也不搬（Base UI 的 initialFocus／finalFocus 都是 false）', async () => {
    render(<Harness />);
    act(() => {
      input().focus();
    });
    type('/');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    // Base UI 搬焦點排在 rAF／timeout 之後，多等幾格再看。
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(document.activeElement).toBe(input());
    key('Escape');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(document.activeElement).toBe(input());
  });

  it('點輸入框本身不算外面；點底列另一顆浮層的按鈕算外面，選單收起（#528：兩個浮層不疊在同一處）', async () => {
    render(<Harness seats={<button data-slot="popover-trigger">用量</button>} />);
    type('/');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    const press = (target: Element) => {
      fireEvent.pointerDown(target, { pointerType: 'mouse', button: 0 });
      fireEvent.mouseDown(target, { button: 0 });
      fireEvent.pointerUp(target, { pointerType: 'mouse', button: 0 });
      fireEvent.mouseUp(target, { button: 0 });
      fireEvent.click(target, { button: 0 });
    };
    // 按下的那一刻就要還開著：不取消的話選單先收起、再被輸入框的 click 打開，會閃一下（Radix 時代 `onInteractOutside` 擋的就是這個）。
    fireEvent.pointerDown(input(), { pointerType: 'mouse', button: 0 });
    fireEvent.mouseDown(input(), { button: 0 });
    expect(screen.getByRole('listbox')).toBeTruthy();
    press(input());
    await act(async () => {});
    expect(screen.getByRole('listbox')).toBeTruthy();
    press(screen.getByRole('button', { name: '用量' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });
});

describe('`/` 選單', () => {
  it('打 `/` 列出命令，輸入框指著清單與選中的那一項', async () => {
    render(<Harness />);
    expect(screen.queryByRole('listbox')).toBeNull();
    type('/');
    expect(options()).toEqual([
      '/plan [off]進出計劃模式。',
      '/feedback <內容>留一則回饋。',
      '/goal <目標>設定目標。',
      '/todo列出待辦。',
    ]);
    await waitFor(() => {
      expect(input().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
      expect(input().getAttribute('aria-activedescendant')).toBe(selected()?.id);
    });
    expect(selected()?.textContent).toContain('/plan');
  });

  it('打字就篩選排序；方向鍵換選項、繞圈', async () => {
    render(<Harness />);
    type('/g');
    expect(options()).toEqual(['/goal <目標>設定目標。']);
    type('/');
    key('ArrowDown');
    expect(selected()?.textContent).toContain('/feedback');
    key('ArrowUp');
    key('ArrowUp');
    expect(selected()?.textContent).toContain('/todo');
    await waitFor(() => expect(input().getAttribute('aria-activedescendant')).toBe(selected()?.id));
  });

  it('選單開著時 Shift＋Enter 不選（留給換行）', () => {
    const run = vi.fn(() => true);
    render(<Harness run={run} />);
    type('/to');
    key('Enter', { shiftKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(input().value).toBe('/to');
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('Safari 選字結束後才報的 Enter（只剩 keyCode 229）不選也不送', () => {
    const run = vi.fn(() => true);
    const onSubmit = vi.fn();
    render(<Harness run={run} onSubmit={onSubmit} />);
    type('/to');
    key('Enter', { isComposing: false, keyCode: 229 });
    expect(run).not.toHaveBeenCalled();
    expect(input().value).toBe('/to');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter 選帶參數的命令：填上 `/名稱 `、不執行、選單收起', () => {
    const run = vi.fn(() => true);
    const onSubmit = vi.fn();
    render(<Harness run={run} onSubmit={onSubmit} />);
    type('/pl');
    key('Enter');
    expect(input().value).toBe('/plan ');
    expect(input().selectionStart).toBe(6);
    expect(run).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Tab 選不帶參數的命令：從草稿拿掉、直接執行', () => {
    const run = vi.fn(() => true);
    render(<Harness run={run} />);
    type('/to');
    key('Tab');
    expect(run).toHaveBeenCalledWith('/todo');
    expect(input().value).toBe('');
  });

  it('有裝飾的 `/feedback` 雖然帶參數，Enter 選到就直接執行（照 dsh：裝飾先判），不是填 `/feedback `', () => {
    const run = vi.fn(() => true);
    render(<Harness run={run} />);
    type('/fe');
    key('Enter');
    expect(run).toHaveBeenCalledWith('/feedback');
    expect(input().value).toBe('');
  });

  it('現在不能執行：那一行留在草稿裡，選單不再跳出來', () => {
    render(<Harness run={() => false} />);
    type('/fe');
    key('Enter');
    expect(input().value).toBe('/feedback');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('點選項也選得到', () => {
    const run = vi.fn(() => true);
    render(<Harness run={run} />);
    type('/');
    fireEvent.click(screen.getByRole('option', { name: /feedback/ }));
    expect(run).toHaveBeenCalledWith('/feedback');
  });

  it('只移游標不打字（點一下、方向鍵）：游標離開 `/` 那一段，選單就收起（#1591：游標從外層的 onSelect 讀）', () => {
    render(<Harness />);
    type('/p');
    expect(screen.getByRole('listbox')).toBeTruthy();
    act(() => input().setSelectionRange(0, 0));
    fireEvent.select(input());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Esc 收起，同一個片段不再自己跳出來；再打一個字才回來。Shift＋Tab 也是收起', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type('/p');
    key('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input().value).toBe('/p');
    fireEvent.select(input());
    expect(screen.queryByRole('listbox')).toBeNull();
    type('/pl');
    expect(screen.getByRole('listbox')).toBeTruthy();
    key('Tab', { shiftKey: true });
    expect(screen.queryByRole('listbox')).toBeNull();
    // 刪光重打同一個 `/`：片段中間不見過，收起的記錄作廢，選單回來。
    type('/');
    key('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    type('');
    type('/');
    expect(screen.getByRole('listbox')).toBeTruthy();
    type('/pl');
    key('Tab', { shiftKey: true });
    // 收起之後 Enter 就是送出。
    key('Enter');
    expect(onSubmit).toHaveBeenCalledWith('/pl', 'enter');
  });

  it('句中的 `/` 只列不帶參數的命令；網址不開', () => {
    render(<Harness />);
    type('先記一下 /');
    expect(options()).toEqual(['/todo列出待辦。']);
    type('看 https://example.com/');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('選單開著時過 axe', async () => {
    render(<Harness />);
    type('/');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

/**
 * `@` 引用（#653）。規則逐條驗在 `lib/file-mention.test.ts` 與 `lib/mention-menu.test.ts`；這裡驗接上輸入框之後：
 * 什麼時候去查、鍵盤歸誰、草稿變成什麼。候選由測試決定什麼時候回來。
 */
describe('@ 引用', () => {
  const file = (path: string): FileReferenceCandidate => ({ path, kind: 'file' });
  const dir = (path: string): FileReferenceCandidate => ({ path, kind: 'directory' });

  function lister() {
    const calls: {
      readonly query: string;
      readonly signal: AbortSignal;
      readonly resolve: (outcome: FileReferenceListOutcome) => void;
    }[] = [];
    const fileReferences = (query: string, signal: AbortSignal) =>
      new Promise<FileReferenceListOutcome>((resolve) => calls.push({ query, signal, resolve }));
    return {
      fileReferences,
      calls,
      answer: (index: number, ...candidates: FileReferenceCandidate[]) =>
        calls[index]!.resolve({ kind: 'ok', result: { available: true, candidates } }),
    };
  }

  const ROOT = [dir('/docs'), dir('/src'), file('/README.md')];
  const menu = () => screen.queryByRole('dialog', { name: '@ 選單' });
  /** 讓回來的結果先處理完：沒等的話下一個字先到，那一份就成了過期的、被丟掉。 */
  const settle = () => act(async () => {});

  async function opened(fake: ReturnType<typeof lister>, draft = '@') {
    type(draft);
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.answer(0, ...ROOT);
    await waitFor(() => expect(menu()).not.toBeNull());
  }

  it('行首的 @ 查根目錄那一層；列出名字，資料夾有「Tab」提示', async () => {
    const fake = lister();
    render(<Harness fileReferences={fake.fileReferences} />);
    await opened(fake);
    expect(fake.calls[0]!.query).toBe('');
    expect(options()).toEqual(['docs/Tab', 'src/Tab', 'README.md']);
  });

  it.each([['a@b'], ['user@host'], ['(@x'], ['＠src']])('%s 不查也不開', async (draft) => {
    const fake = lister();
    render(<Harness fileReferences={fake.fileReferences} />);
    type(draft);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.calls).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('@/ 不叫出命令選單：它是一段路徑', async () => {
    const fake = lister();
    render(<Harness fileReferences={fake.fileReferences} />);
    await opened(fake, '@/');
    expect(fake.calls[0]!.query).toBe('/');
    expect(screen.queryByRole('dialog', { name: '命令選單' })).toBeNull();
  });

  it('沒接列檔時 @/ 也不叫出命令選單', async () => {
    render(<Harness />);
    type('@/');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Enter 選定檔案：換成 @/path 加一個空白，選單收起', async () => {
    const fake = lister();
    render(<Harness fileReferences={fake.fileReferences} />);
    await opened(fake);
    key('ArrowUp');
    key('Enter');
    expect(input().value).toBe('@/README.md ');
    await waitFor(() => expect(menu()).toBeNull());
  });

  it('資料夾按 Tab 往下鑽：換成 @/docs/、選單留著、查下一層；按 Enter 是選定', async () => {
    const fake = lister();
    render(<Harness fileReferences={fake.fileReferences} />);
    await opened(fake);
    key('Tab');
    expect(input().value).toBe('@/docs/');
    await waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(fake.calls[1]!.query).toBe('/docs/');
    // 下一層還沒回來：舊的列留著。
    expect(menu()).not.toBeNull();
    fake.answer(1, file('/docs/guide.md'), dir('/docs/api'));
    // 第一版不畫麵包屑，所以下一層的列照樣寫父目錄（dsh 有麵包屑時才省掉）。
    await waitFor(() => expect(options()).toEqual(['guide.md/docs', 'api//docsTab']));
    key('ArrowDown');
    key('Enter');
    expect(input().value).toBe('@/docs/api/ ');
  });

  it('Esc 收起，同一段不再自己跳出來；再打一個字又開', async () => {
    const fake = lister();
    render(<Harness fileReferences={fake.fileReferences} />);
    await opened(fake);
    key('Escape');
    await waitFor(() => expect(menu()).toBeNull());
    fireEvent.select(input());
    expect(menu()).toBeNull();
    expect(fake.calls).toHaveLength(1);
    type('@s');
    await waitFor(() => expect(fake.calls).toHaveLength(2));
    fake.answer(1, dir('/src'));
    await waitFor(() => expect(menu()).not.toBeNull());
  });

  it('Shift+Tab 也收起，輸入框留著剛打的字（dsh 的 arbitrate）', async () => {
    const fake = lister();
    render(<Harness fileReferences={fake.fileReferences} />);
    await opened(fake);
    key('Tab', { shiftKey: true });
    await waitFor(() => expect(menu()).toBeNull());
    expect(input().value).toBe('@');
  });

  it('組字中的 Enter 不選也不送', async () => {
    const fake = lister();
    const sent: string[] = [];
    render(<Harness fileReferences={fake.fileReferences} onSubmit={(draft) => sent.push(draft)} />);
    await opened(fake);
    key('Enter', { isComposing: true, keyCode: 229 });
    expect(input().value).toBe('@');
    expect(sent).toEqual([]);
  });

  it('還在查的時候：舊的列留著但選不到，Enter 不選也不送', async () => {
    const fake = lister();
    const sent: string[] = [];
    render(<Harness fileReferences={fake.fileReferences} onSubmit={(draft) => sent.push(draft)} />);
    await opened(fake);
    type('@d');
    await waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(options()).toEqual(['docs/Tab', 'src/Tab', 'README.md']);
    key('Enter');
    key('Tab');
    expect(input().value).toBe('@d');
    expect(sent).toEqual([]);
  });

  it('一列都還沒有時畫骨架；這時 Enter 不歸選單管，照常送出（dsh 的 arbitrate）', async () => {
    const fake = lister();
    const sent: string[] = [];
    render(<Harness fileReferences={fake.fileReferences} onSubmit={(draft) => sent.push(draft)} />);
    type('@zz');
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.answer(0);
    await settle();
    type('@zzz');
    await waitFor(() => expect(fake.calls).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('mention-skeleton')).toBeTruthy());
    key('Enter');
    expect(sent).toEqual(['@zzz']);
  });

  it('打得快：前幾次被取消，晚回來的舊結果不畫', async () => {
    const fake = lister();
    render(<Harness fileReferences={fake.fileReferences} />);
    await opened(fake);
    type('@a');
    type('@al');
    type('@alp');
    await waitFor(() => expect(fake.calls).toHaveLength(4));
    expect(fake.calls.slice(1, 3).every((call) => call.signal.aborted)).toBe(true);
    expect(fake.calls[3]!.signal.aborted).toBe(false);
    fake.answer(3, file('/src/alpha.ts'));
    fake.answer(1, file('/a-old.ts'));
    await waitFor(() => expect(options()).toEqual(['alpha.ts/src']));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(options()).toEqual(['alpha.ts/src']);
  });

  it('沒有工作區：選單一次都不畫，之後也不再查', async () => {
    const fake = lister();
    render(<Harness fileReferences={fake.fileReferences} />);
    type('@');
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.calls[0]!.resolve({ kind: 'ok', result: { available: false } });
    await settle();
    type('@s');
    type('@sr');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.calls).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('aria-activedescendant 跟著選中那一列走；過 axe', async () => {
    const fake = lister();
    render(<Harness fileReferences={fake.fileReferences} />);
    await opened(fake);
    key('ArrowDown');
    await waitFor(() => expect(input().getAttribute('aria-activedescendant')).toBe(selected()?.id));
    expect(selected()?.textContent).toBe('src/Tab');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

/**
 * `@` 引用別的會話（#713）。狀態怎麼併、列怎麼排逐條驗在 `lib/mention-menu.test.ts`、`lib/session-mention.test.ts`；
 * 這裡驗接上輸入框之後：什麼時候問會話、分三段畫出來、選了之後草稿變成什麼。
 */
describe('@ 引用別的會話', () => {
  const file = (path: string): FileReferenceCandidate => ({ path, kind: 'file' });
  const session = (
    sessionId: string,
    extra: Partial<SessionReferenceCandidate> = {},
  ): SessionReferenceCandidate => {
    const label = extra.label ?? sessionId;
    return {
      sessionId,
      label,
      sameWorkspace: true,
      createdAt: 1,
      updatedAt: 2,
      mention: formatSessionReferenceMention({ sessionId, label }),
      ...extra,
    };
  };

  function sources() {
    const files: {
      readonly query: string;
      readonly signal: AbortSignal;
      readonly resolve: (outcome: FileReferenceListOutcome) => void;
    }[] = [];
    const sessions: {
      readonly query: string;
      readonly signal: AbortSignal;
      readonly resolve: (outcome: SessionReferenceListOutcome) => void;
    }[] = [];
    return {
      files,
      sessions,
      fileReferences: (query: string, signal: AbortSignal) =>
        new Promise<FileReferenceListOutcome>((resolve) => files.push({ query, signal, resolve })),
      sessionReferences: (query: string, signal: AbortSignal) =>
        new Promise<SessionReferenceListOutcome>((resolve) =>
          sessions.push({ query, signal, resolve }),
        ),
      answerFiles: (index: number, ...candidates: FileReferenceCandidate[]) =>
        files[index]!.resolve({ kind: 'ok', result: { available: true, candidates } }),
      answerSessions: (index: number, ...candidates: SessionReferenceCandidate[]) =>
        sessions[index]!.resolve({ kind: 'ok', result: { available: true, candidates } }),
    };
  }

  const menu = () => screen.queryByRole('dialog', { name: '@ 選單' });
  const headings = () =>
    [...document.querySelectorAll('[cmdk-group-heading]')].map((heading) => heading.textContent);

  async function opened(fake: ReturnType<typeof sources>, draft = '@') {
    render(
      <Harness fileReferences={fake.fileReferences} sessionReferences={fake.sessionReferences} />,
    );
    type(draft);
    await waitFor(() => expect(fake.files).toHaveLength(1));
  }

  it('打 @ 兩邊一起問，分成檔案、會話、子代理三段；別的專案寫目錄名，子代理寫屬於誰', async () => {
    const fake = sources();
    await opened(fake, '@');
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]!.query).toBe('');
    fake.answerSessions(
      0,
      session('sub', { label: '查資料', parentSessionId: 'root', parentLabel: '大會話' }),
      session('other', { label: '報表', sameWorkspace: false, cwd: '/w/reports' }),
      session('mine', { label: '昨天那條' }),
    );
    fake.answerFiles(0, file('/README.md'));
    await waitFor(() => expect(menu()).not.toBeNull());
    expect(headings()).toEqual(['檔案', '會話', '子代理']);
    expect(options()).toEqual(['README.md', '報表reports', '昨天那條', '查資料屬於 大會話']);
  });

  it('名字太長時是名字自己截斷，後面的小字不縮不被吃掉', async () => {
    const fake = sources();
    await opened(fake, '@');
    fake.answerSessions(
      0,
      session('sub', {
        label: 'parent-id/tools:0000-0000-0000-0000-0000-0000-0000-0000',
        parentSessionId: 'root',
        parentLabel: '大會話',
      }),
    );
    fake.answerFiles(0);
    await waitFor(() => expect(menu()).not.toBeNull());
    const name = screen.getByText('parent-id/tools:0000-0000-0000-0000-0000-0000-0000-0000');
    const hint = screen.getByText('屬於 大會話');
    // jsdom 沒有排版：只能釘結構——截斷的是名字這一格，小字在它外面且不縮（否則長名字會把小字擠到省略號後面）。
    expect(name.classList.contains('truncate')).toBe(true);
    expect(name.contains(hint)).toBe(false);
    expect(hint.classList.contains('shrink-0')).toBe(true);
    expect(name.getAttribute('title')).toBe(
      'parent-id/tools:0000-0000-0000-0000-0000-0000-0000-0000',
    );
  });

  it('只有檔案時不畫段標題（跟原來一樣）', async () => {
    const fake = sources();
    await opened(fake);
    fake.answerFiles(0, file('/README.md'));
    fake.answerSessions(0);
    await waitFor(() => expect(menu()).not.toBeNull());
    expect(headings()).toEqual([]);
    expect(options()).toEqual(['README.md']);
  });

  it('會話比檔案先回來：先畫會話，檔案到了併進上面一段', async () => {
    const fake = sources();
    await opened(fake, '@');
    fake.answerSessions(0, session('s1', { label: '甲' }));
    await waitFor(() => expect(options()).toEqual(['甲']));
    fake.answerFiles(0, file('/a.ts'));
    await waitFor(() => expect(options()).toEqual(['a.ts', '甲']));
  });

  it('Enter 選定會話：@ 那一段換成編好的引用文字加一個空白，選單收起、不再自己跳出來', async () => {
    const fake = sources();
    await opened(fake, '照 @昨');
    const picked = session('s1', { label: '昨天那條' });
    fake.answerSessions(0, picked);
    fake.answerFiles(0);
    await waitFor(() => expect(menu()).not.toBeNull());
    key('Enter');
    expect(input().value).toBe(`照 ${picked.mention} `);
    await waitFor(() => expect(menu()).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(menu()).toBeNull();
    expect(fake.sessions).toHaveLength(1);
  });

  it('Tab 對會話也是選定，沒有往下鑽', async () => {
    const fake = sources();
    await opened(fake, '@');
    const picked = session('s1', { label: '甲' });
    fake.answerSessions(0, picked);
    fake.answerFiles(0);
    await waitFor(() => expect(menu()).not.toBeNull());
    key('Tab');
    expect(input().value).toBe(`${picked.mention} `);
    await waitFor(() => expect(menu()).toBeNull());
  });

  it('點一下也是選定', async () => {
    const fake = sources();
    await opened(fake, '@');
    const picked = session('s1', { label: '甲' });
    fake.answerSessions(0, picked);
    fake.answerFiles(0, file('/a.ts'));
    await waitFor(() => expect(options()).toEqual(['a.ts', '甲']));
    fireEvent.click(screen.getByRole('option', { name: /甲/u }));
    expect(input().value).toBe(`${picked.mention} `);
  });

  it('@/ 與 @" 開頭只查檔案', async () => {
    const fake = sources();
    await opened(fake, '@/');
    expect(fake.sessions).toHaveLength(0);
    type('@"my dir');
    await waitFor(() => expect(fake.files).toHaveLength(2));
    expect(fake.sessions).toHaveLength(0);
  });

  it('每打一個字，兩邊的上一次都取消', async () => {
    const fake = sources();
    await opened(fake, '@');
    type('@a');
    await waitFor(() => expect(fake.files).toHaveLength(2));
    expect(fake.files[0]!.signal.aborted).toBe(true);
    expect(fake.sessions[0]!.signal.aborted).toBe(true);
    expect(fake.sessions[1]!.query).toBe('a');
    expect(fake.sessions[1]!.signal.aborted).toBe(false);
  });

  it('一邊回來說不可用，另一邊還在飛的請求不重來', async () => {
    const fake = sources();
    await opened(fake, '@');
    fake.files[0]!.resolve({ kind: 'ok', result: { available: false } });
    await act(async () => {});
    expect(fake.sessions[0]!.signal.aborted).toBe(false);
    expect(fake.sessions).toHaveLength(1);
    fake.answerSessions(0, session('s1', { label: '甲' }));
    await waitFor(() => expect(options()).toEqual(['甲']));
    // 沒有工作區是這台 server 每次都一樣的事：之後打字不再問檔案，會話照問。
    type('@a');
    await waitFor(() => expect(fake.sessions).toHaveLength(2));
    expect(fake.files).toHaveLength(1);
  });

  it('沒接落盤（會話不可用）：檔案照開，之後不再問會話', async () => {
    const fake = sources();
    await opened(fake, '@');
    fake.sessions[0]!.resolve({ kind: 'ok', result: { available: false } });
    fake.answerFiles(0, file('/a.ts'));
    await waitFor(() => expect(options()).toEqual(['a.ts']));
    type('@a');
    await waitFor(() => expect(fake.files).toHaveLength(2));
    expect(fake.sessions).toHaveLength(1);
  });

  it('只給會話那一邊也能開（沒有工作區的 server）', async () => {
    const fake = sources();
    render(<Harness sessionReferences={fake.sessionReferences} />);
    type('@');
    await waitFor(() => expect(fake.sessions).toHaveLength(1));
    fake.answerSessions(0, session('s1', { label: '甲' }));
    await waitFor(() => expect(options()).toEqual(['甲']));
  });

  it('選好的引用貼著游標不會又叫出選單', async () => {
    const fake = sources();
    const picked = session('s1', { label: '甲' });
    render(
      <Harness
        initial={`看 ${picked.mention}`}
        fileReferences={fake.fileReferences}
        sessionReferences={fake.sessionReferences}
      />,
    );
    fireEvent.select(input(), { target: { selectionStart: input().value.length } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.files).toHaveLength(0);
    expect(fake.sessions).toHaveLength(0);
  });

  it('過 axe', async () => {
    const fake = sources();
    await opened(fake, '@');
    fake.answerSessions(0, session('s1', { label: '甲' }));
    fake.answerFiles(0, file('/a.ts'));
    await waitFor(() => expect(options()).toEqual(['a.ts', '甲']));
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
