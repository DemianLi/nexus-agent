import type { Event } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { FRAMES_PER_PUBLICATION, FramePublisher, publicationOf } from '@/lib/frame-publisher';

/** 手動推進的幀：`tick()` 跑一輪目前排著的 callback。 */
function manualFrames() {
  let next = 1;
  const queued = new Map<number, () => void>();
  return {
    scheduler: {
      request(callback: () => void) {
        queued.set(next, callback);
        return next++;
      },
      cancel(handle: number) {
        queued.delete(handle);
      },
    },
    tick() {
      const due = [...queued.values()];
      queued.clear();
      for (const callback of due) callback();
    },
    get pending() {
      return queued.size;
    },
  };
}

function setup(frames = manualFrames()) {
  const published: string[] = [];
  const publisher = new FramePublisher('', (state) => published.push(state), frames.scheduler);
  const append = (text: string) => (previous: string) => previous + text;
  return { frames, published, publisher, append };
}

describe('FramePublisher', () => {
  it('當場發布的變化當場交出去', () => {
    const { published, publisher, append } = setup();
    publisher.apply(append('a'));
    expect(published).toEqual(['a']);
  });

  it('串流片段跨過三次 paint 才交一次，交的是最新的那份', () => {
    const { frames, published, publisher, append } = setup();
    publisher.apply(append('a'), 'animation-frame');
    publisher.apply(append('b'), 'animation-frame');
    // 折疊照樣當場做：手上的那份是最新的。
    expect(publisher.current).toBe('ab');
    for (let i = 1; i < FRAMES_PER_PUBLICATION; i++) {
      frames.tick();
      publisher.apply(append(String(i)), 'animation-frame');
      expect(published).toEqual([]);
    }
    frames.tick();
    expect(published).toEqual(['ab12']);
    expect(frames.pending).toBe(0);
  });

  it('當場發布的事件把還在排的串流片段一起帶出去，排著的那一幀不再交', () => {
    const { frames, published, publisher, append } = setup();
    publisher.apply(append('a'), 'animation-frame');
    frames.tick();
    publisher.apply(append('!'));
    expect(published).toEqual(['a!']);
    for (let i = 0; i < FRAMES_PER_PUBLICATION; i++) frames.tick();
    expect(published).toEqual(['a!']);
  });

  it('交出去之後再來的片段重新排', () => {
    const { frames, published, publisher, append } = setup();
    publisher.apply(append('a'), 'animation-frame');
    for (let i = 0; i < FRAMES_PER_PUBLICATION; i++) frames.tick();
    publisher.apply(append('b'), 'animation-frame');
    for (let i = 0; i < FRAMES_PER_PUBLICATION; i++) frames.tick();
    expect(published).toEqual(['a', 'ab']);
  });

  it('折完沒變的不發布、不排', () => {
    const { frames, published, publisher } = setup();
    publisher.apply((previous) => previous, 'animation-frame');
    publisher.apply((previous) => previous);
    expect(published).toEqual([]);
    expect(frames.pending).toBe(0);
  });

  it('cancel 只取消排著的那一幀，還沒交的變化留著，下一次發布一起交', () => {
    const { frames, published, publisher, append } = setup();
    publisher.apply(append('a'), 'animation-frame');
    publisher.cancel();
    for (let i = 0; i < FRAMES_PER_PUBLICATION; i++) frames.tick();
    expect(published).toEqual([]);
    publisher.apply(append('b'));
    expect(published).toEqual(['ab']);
  });

  it('沒有 requestAnimationFrame 的環境當場發布', () => {
    const published: string[] = [];
    const publisher = new FramePublisher('', (state) => published.push(state), null);
    publisher.apply((previous) => `${previous}a`, 'animation-frame');
    expect(published).toEqual(['a']);
  });
});

describe('publicationOf', () => {
  const event = (method: string, data: unknown) =>
    ({
      type: 'event',
      seq: 0,
      event_id: 't:0',
      method,
      params: { namespace: [], timestamp: 0, data },
    }) as Event;

  it('串流片段走動畫幀', () => {
    for (const name of ['content-block-start', 'content-block-delta', 'content-block-finish']) {
      expect(publicationOf(event('messages', { event: name }))).toBe('animation-frame');
    }
  });

  it('一則的起訖與錯誤、工具、生命週期、自訂事件當場', () => {
    for (const name of ['message-start', 'message-finish', 'error']) {
      expect(publicationOf(event('messages', { event: name }))).toBe('immediate');
    }
    expect(publicationOf(event('tools', { event: 'tool-started' }))).toBe('immediate');
    expect(publicationOf(event('lifecycle', { event: 'completed' }))).toBe('immediate');
    expect(publicationOf(event('custom', { name: 'x' }))).toBe('immediate');
  });
});
