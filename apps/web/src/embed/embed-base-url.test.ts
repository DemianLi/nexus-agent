import { describe, expect, it } from 'vitest';

import { embedBaseUrl } from './embedded-chat';

/** 嵌入版的 agent 位置從 `embed.js` 自己的網址算，不看宿主頁（#2426）。 */
describe('embedBaseUrl', () => {
  it.each([
    ['http://h/embed.js', '/embed'],
    ['http://h/nexus/embed.js', '/nexus/embed'],
    ['http://h/a/b/embed.js?v=1', '/a/b/embed'],
  ])('%s → %s', (scriptUrl, expected) => {
    expect(embedBaseUrl(scriptUrl)).toBe(expected);
  });

  it('宿主頁在別的路徑也不影響', () => {
    expect(document.baseURI).toBe('http://localhost:3000/');
    const base = document.createElement('base');
    base.href = 'http://localhost:3000/viz/page/';
    document.head.append(base);
    try {
      expect(embedBaseUrl('http://localhost:3000/nexus/embed.js')).toBe('/nexus/embed');
    } finally {
      base.remove();
    }
  });
});
