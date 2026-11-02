import { describe, expect, it } from 'vitest';

import { isMuxRoute, parseMuxClientMessage, parseMuxServerMessage } from './mux.js';
import { THREAD_FEED_PATH } from './protocol.js';

describe('isMuxRoute', () => {
  it.each([
    ['POST', '/threads/t1/stream', true],
    ['GET', THREAD_FEED_PATH, true],
    ['GET', '/threads/t1/stream', false],
    ['POST', THREAD_FEED_PATH, false],
    ['POST', '/threads/t1/commands/run.start', false],
    ['POST', '/threads/t1/stream?x=1', false],
    ['POST', '/threads/a/b/stream', false],
    ['GET', '/threads', false],
  ])('%s %s → %s', (method, path, allowed) => {
    expect(isMuxRoute(method, path)).toBe(allowed);
  });
});

describe('parseMuxClientMessage', () => {
  it.each([
    ['{"t":"open","id":"1","method":"GET","path":"/threads/feed"}'],
    ['{"t":"open","id":"1","method":"POST","path":"/p","body":"{}"}'],
    ['{"t":"cancel","id":"1"}'],
    ['{"t":"credit","id":"1","chars":10}'],
  ])('收 %s', (raw) => {
    expect(parseMuxClientMessage(raw)).toEqual(JSON.parse(raw));
  });

  it.each([
    ['not json'],
    ['null'],
    ['[]'],
    ['{"t":"cancel"}'],
    ['{"t":"cancel","id":1}'],
    ['{"t":"nope","id":"1"}'],
    ['{"t":"open","id":"1","method":"GET"}'],
    ['{"t":"open","id":"1","method":"POST","path":"/p","body":1}'],
    ['{"t":"credit","id":"1"}'],
    ['{"t":"credit","id":"1","chars":0}'],
    ['{"t":"credit","id":"1","chars":-1}'],
    ['{"t":"credit","id":"1","chars":1.5}'],
  ])('不收 %s', (raw) => {
    expect(parseMuxClientMessage(raw)).toBeUndefined();
  });
});

describe('parseMuxServerMessage', () => {
  it.each([
    ['{"t":"head","id":"1","status":200,"contentType":"text/event-stream"}'],
    ['{"t":"data","id":"1","text":"x"}'],
    ['{"t":"end","id":"1"}'],
    ['{"t":"error","id":"1","message":"x"}'],
  ])('收 %s', (raw) => {
    expect(parseMuxServerMessage(raw)).toEqual(JSON.parse(raw));
  });

  it.each([
    ['not json'],
    ['{"t":"end"}'],
    ['{"t":"data","id":"1"}'],
    ['{"t":"error","id":"1"}'],
    ['{"t":"head","id":"1","status":"200","contentType":""}'],
    ['{"t":"nope","id":"1"}'],
  ])('不收 %s', (raw) => {
    expect(parseMuxServerMessage(raw)).toBeUndefined();
  });
});
