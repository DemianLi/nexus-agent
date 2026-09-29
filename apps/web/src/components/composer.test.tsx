import type {
  FileReferenceCandidate,
  FileReferenceListOutcome,
  SlashDescriptor,
} from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
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
  fileReferences,
}: {
  initial?: string;
  canSend?: boolean;
  run?: (line: string) => boolean;
  onSubmit?: (draft: string, gesture: SubmitGesture) => void;
  sendHint?: SendHint;
  onSteerQueue?: () => void;
  fileReferences?: (query: string, signal: AbortSignal) => Promise<FileReferenceListOutcome>;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <main>
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        placeholder="說點什麼…"
        canSend={canSend && draft.trim() !== ''}
        onSubmit={(gesture) => {
          onSubmit(draft, gesture);
          setDraft('');
        }}
        {...(sendHint === undefined ? {} : { sendHint })}
        {...(onSteerQueue === undefined ? {} : { onSteerQueue })}
        commands={[plan, feedback, goal, todo]}
        decorated={new Set(['feedback'])}
        onRunCommand={run}
        stoppable={false}
        stopDisabled={false}
        onStop={() => {}}
        {...(fileReferences === undefined ? {} : { fileReferences })}
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

  it('底列提示預設「Enter 送出」，呼叫端可以換掉；寬螢幕才畫的那一段窄螢幕藏起來', () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByTestId('send-hint').textContent).toBe('Enter 送出');
    unmount();
    render(<Harness sendHint={{ text: 'Enter 排隊', wide: '・Ctrl+Enter 插話' }} />);
    expect(screen.getByTestId('send-hint').textContent).toBe('Enter 排隊・Ctrl+Enter 插話');
    expect(screen.getByText('・Ctrl+Enter 插話').className).toBe('hidden sm:inline');
    // 外殼是 flex：兩段之間不能有間距。
    expect(screen.getByTestId('send-hint').classList.contains('gap-0')).toBe(true);
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
  const menu = () => screen.queryByRole('dialog', { name: '檔案選單' });
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
