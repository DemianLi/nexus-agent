import { SERVER_CLOSING } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { SERVER_CLOSING_TEXT, serverClosingText } from '@/lib/server-closing';

describe('serverClosingText（#1995）', () => {
  it('serve 正在收尾：回給使用者看的那一句', () => {
    expect(serverClosingText(SERVER_CLOSING)).toBe(SERVER_CLOSING_TEXT);
  });

  it('其他碼與沒有碼：回 undefined，照各處自己的講法', () => {
    expect(serverClosingText('unknown_error')).toBeUndefined();
    expect(serverClosingText(undefined)).toBeUndefined();
  });
});
