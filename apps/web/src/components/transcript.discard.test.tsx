import {
  emptyConversation,
  LLM_RETRY,
  LLM_RETRY_STARTED,
  MESSAGE_DISCARD,
  reduceAll,
} from '@nexus/wire';
import type { ConversationState, Event } from '@nexus/wire';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Transcript } from '@/components/transcript';
import { Script } from '@/test/conversation-frames';

/**
 * 串流中段出錯、整次重打（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）：失敗那次吐出來的字，在 harness 送 `message-discard`
 * 的當下從畫面上擦掉，重打的那一則接著畫。折疊器已經把那一格拿掉（wire 的測試管），這裡管**畫面**：擦掉之後畫面上不留
 * 任何殘影，重打的那一則照常畫，沒有擦掉時（重打預算用完）斷尾的那一則照舊留著。
 */

afterEach(cleanup);

function fold(build: (script: Script) => Event[]): ConversationState {
  const script = new Script();
  return reduceAll(emptyConversation(), [
    script.running(),
    ...script.human('h1', '問'),
    ...build(script),
  ]);
}

function view(state: ConversationState) {
  return render(<Transcript state={state} isFresh={() => false} />);
}

describe('被擋下的人話（封存的會話，#633）', () => {
  it('泡泡照畫，底下一句中性的提示；沒被擋下的人話沒有', () => {
    const script = new Script();
    const blocked = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('h1', '封存之後說的話'),
      script.blocked(),
    ]);
    const { unmount } = view(blocked);
    expect(screen.getByText('封存之後說的話')).toBeTruthy();
    expect(screen.getByTestId('blocked-hint').textContent).toBe('已封存，這句話沒有送給模型');
    // 不是錯誤：沒有紅色警示語意。
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();

    const normal = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('h2', '正常說的話'),
      script.completed(),
    ]);
    view(normal);
    expect(screen.queryByTestId('blocked-hint')).toBeNull();
  });

  it('被擋下之後解封再說一句：後一句沒有提示，前一句的提示還在（歷史不被改寫）', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('h1', '第一句被擋'),
      script.blocked(),
      script.running(),
      ...script.human('h2', '第二句送出去了'),
      ...script.ai('a', { text: '收到' }),
      script.completed(),
    ]);
    view(state);
    expect(screen.getAllByTestId('blocked-hint')).toHaveLength(1);
    expect(
      state.entries.filter((entry) => entry.kind === 'human' && entry.blocked === true),
    ).toHaveLength(1);
  });
});

describe('作廢的回覆（#520）', () => {
  it('吐到一半的那則被作廢：字與推理都從畫面消失，只剩人的那一句', () => {
    const state = fold((s) => [
      s.openAi('a'),
      s.delta('a', '第一次吐的半截'),
      s.custom(MESSAGE_DISCARD, { messageId: 'a' }),
    ]);
    view(state);
    expect(screen.queryByText(/第一次吐的半截/u)).toBeNull();
    expect(document.body.textContent).toContain('問');
    expect(state.entries.map((entry) => entry.kind)).toEqual(['human']);
  });

  it('擦掉後重打的那一則接著畫：畫面只有第二次的回覆，沒有第一次的殘影', () => {
    const state = fold((s) => [
      s.openAi('a'),
      s.delta('a', '第一次吐的半截'),
      s.custom(MESSAGE_DISCARD, { messageId: 'a' }),
      ...s.ai('b', { text: '重打後的完整回覆' }),
      s.completed(),
    ]);
    view(state);
    expect(screen.getByText('重打後的完整回覆')).toBeTruthy();
    expect(screen.queryByText(/第一次吐的半截/u)).toBeNull();
  });

  it('逐步到達：先看得到半截、作廢後消失、重打的字再出現（同一個元件實體重畫）', () => {
    const script = new Script();
    const base = [script.running(), ...script.human('h1', '問')];
    const steps: Event[][] = [
      [script.openAi('a'), script.delta('a', '半截的字')],
      [script.custom(MESSAGE_DISCARD, { messageId: 'a' })],
      [script.openAi('b'), script.delta('b', '重打')],
      [script.delta('b', '的字'), script.completed()],
    ];
    let events = base;
    const view1 = render(
      <Transcript state={reduceAll(emptyConversation(), events)} isFresh={() => false} />,
    );
    const texts: string[] = [];
    for (const step of steps) {
      events = [...events, ...step];
      view1.rerender(
        <Transcript state={reduceAll(emptyConversation(), events)} isFresh={() => false} />,
      );
      texts.push(document.body.textContent ?? '');
    }
    expect(texts[0]).toContain('半截的字');
    expect(texts[1]).not.toContain('半截的字');
    expect(texts[2]).toContain('重打');
    expect(texts[2]).not.toContain('半截的字');
    expect(texts[3]).toContain('重打的字');
    expect(texts[3]).not.toContain('半截的字');
  });

  it('沒有作廢記號（重打預算用完）：斷尾的那一則照舊留在畫面', () => {
    const state = fold((s) => [s.openAi('a'), s.delta('a', '斷尾的半截'), s.failed('x', '失敗')]);
    view(state);
    expect(screen.getByText(/斷尾的半截/u)).toBeTruthy();
  });
});

describe('等著重打的倒數行（#520）', () => {
  const retryFrame = (s: Script, over: Record<string, unknown> = {}) =>
    s.custom(LLM_RETRY, {
      retryId: 'r1',
      retry: 1,
      maxRetries: 2,
      delayMs: 3000,
      code: 'TIMEOUT',
      ...over,
    });
  const rowText = () => screen.queryByTestId('llm-retry')?.textContent ?? null;

  it('作廢之後、下一則回覆開始之前：輪尾有一行倒數，作廢的字不在', () => {
    const state = fold((s) => [
      s.openAi('a'),
      s.delta('a', '第一次吐的半截'),
      s.custom(MESSAGE_DISCARD, { messageId: 'a' }),
      retryFrame(s),
    ]);
    view(state);
    expect(rowText()).toContain('逾時，3 秒後重試（第 1／2 次）');
    expect(screen.queryByText(/第一次吐的半截/u)).toBeNull();
  });

  it('下一則回覆開始：倒數行收掉，重打的字接著畫', () => {
    const state = fold((s) => [
      s.openAi('a'),
      s.custom(MESSAGE_DISCARD, { messageId: 'a' }),
      retryFrame(s),
      s.custom(LLM_RETRY_STARTED, { retryId: 'r1', retry: 1 }),
      ...s.ai('b', { text: '重打後的回覆' }),
    ]);
    view(state);
    expect(rowText()).toBeNull();
    expect(screen.getByText('重打後的回覆')).toBeTruthy();
  });

  it('退避中按了停止：這一輪收尾就收掉，不留一行過期的倒數', () => {
    const state = fold((s) => [
      s.openAi('a'),
      s.custom(MESSAGE_DISCARD, { messageId: 'a' }),
      retryFrame(s),
      s.stopped(),
    ]);
    view(state);
    expect(rowText()).toBeNull();
  });

  it('沒有在重試：不畫那一行', () => {
    view(fold((s) => [...s.ai('a', { text: '正常的回覆' }), s.completed()]));
    expect(rowText()).toBeNull();
  });

  it('同一個 retryId 的下一次嘗試：畫成第 2 次', () => {
    const state = fold((s) => [
      retryFrame(s),
      s.custom(LLM_RETRY_STARTED, { retryId: 'r1', retry: 1 }),
      retryFrame(s, { retry: 2, delayMs: 2000, code: 'TRANSPORT' }),
    ]);
    view(state);
    expect(rowText()).toContain('連線失敗，2 秒後重試（第 2／2 次）');
  });
});
