import { emptyConversation, reduceAll } from '@nexus/wire';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Transcript } from '@/components/transcript';
import { Script } from '@/test/conversation-frames';

import {
  findTranscriptItem,
  registerTranscriptScroller,
  revealTranscriptItem,
} from './transcript-locate';

/**
 * 「定位」怎麼捲（[#1033](https://github.com/DemianLi/nexus-agent/issues/1033)）：串流中對話區在自動捲到底，直接 `scrollIntoView`
 * 會被拉回去（實機量過：1280 寬那一格始終進不了視野），所以要走對話區自己登記的 `scrollToMessage`。
 */

afterEach(cleanup);

function item(id: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-message-id', id);
  el.scrollIntoView = vi.fn();
  return el;
}

describe('revealTranscriptItem', () => {
  it('有登記的捲動就走它、傳條目 id，不再自己 scrollIntoView', () => {
    const scrollTo = vi.fn(() => true);
    const unregister = registerTranscriptScroller(scrollTo);
    const target = item('tool-1');
    revealTranscriptItem(target);
    expect(scrollTo).toHaveBeenCalledWith('tool-1');
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    unregister();
  });

  it('登記的那條回 false（對話區沒有這一格）時退回 scrollIntoView', () => {
    const unregister = registerTranscriptScroller(() => false);
    const target = item('tool-1');
    revealTranscriptItem(target);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    unregister();
  });

  it('沒登記（對話區還沒掛）時退回 scrollIntoView', () => {
    const target = item('tool-1');
    revealTranscriptItem(target);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('取消登記只收掉自己那一份：後登記的不會被先前那一份的取消函式拔掉', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unregisterFirst = registerTranscriptScroller(first);
    const unregisterSecond = registerTranscriptScroller(second);
    unregisterFirst();
    revealTranscriptItem(item('a'));
    expect(second).toHaveBeenCalledWith('a');
    expect(first).not.toHaveBeenCalled();
    unregisterSecond();
    const target = item('b');
    revealTranscriptItem(target);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe('Transcript 掛上時登記自己的捲動', () => {
  function mountWithTool() {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '讀一下'),
      script.openAi('live'),
    ]);
    return render(<Transcript state={state} isFresh={() => false} />);
  }

  it('掛上之後定位走對話區的 scrollToMessage；卸下之後退回', () => {
    const view = mountWithTool();
    const target = findTranscriptItem('history-0');
    expect(target).toBeDefined();
    const spy = vi.fn();
    target!.scrollIntoView = spy;
    revealTranscriptItem(target!);
    // 走原語的 scrollToMessage：它自己捲 viewport，沒有人呼叫元素的 scrollIntoView。
    expect(spy).not.toHaveBeenCalled();

    view.unmount();
    const orphan = item('history-0');
    revealTranscriptItem(orphan);
    expect(orphan.scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
