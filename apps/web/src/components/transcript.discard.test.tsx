import { emptyConversation, MESSAGE_DISCARD, reduceAll } from '@nexus/wire';
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
