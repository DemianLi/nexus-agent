import { describe, expect, it } from 'vitest';

import { forwardedPrincipal, PRINCIPAL_HEADER, principalHeaders } from './forwarded-principal.js';
import type { EmbedPrincipal } from './wire-principal.js';

const EMBED: EmbedPrincipal = {
  kind: 'embed',
  embedder: 'portal',
  subject: 'alice@example',
  userId: 'u-1',
  sessionIdSha256: 'a'.repeat(64),
};

describe('forwarded-principal', () => {
  it('嵌入身分來回一致；主機擁有者不帶標頭，對話行程讀成擁有者', () => {
    expect(forwardedPrincipal(new Headers(principalHeaders(EMBED)))).toEqual(EMBED);
    expect(principalHeaders({ kind: 'owner' })).toEqual({});
    expect(forwardedPrincipal(new Headers())).toEqual({ kind: 'owner' });
  });

  it('解不開、種類不對、欄位缺或多：當成沒認證，不退回擁有者', () => {
    const bad = [
      'not-json',
      encodeURIComponent(JSON.stringify({ kind: 'owner' })),
      encodeURIComponent(JSON.stringify({ ...EMBED, userId: undefined })),
      encodeURIComponent(JSON.stringify({ ...EMBED, userId: '' })),
      encodeURIComponent(JSON.stringify({ ...EMBED, extra: 'x' })),
    ];
    for (const value of bad) {
      expect(forwardedPrincipal(new Headers({ [PRINCIPAL_HEADER]: value }))).toBeUndefined();
    }
  });
});
