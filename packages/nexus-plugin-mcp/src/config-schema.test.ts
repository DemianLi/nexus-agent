/**
 * 這顆 plugin 的 `Config` 轉成 JSON Schema 之後，`serverName` 的 pattern 仍然輸出（#1560 N0043）：
 * `SERVER_NAME_PATTERN` 是 ASCII 字元類加有界量詞，照 dsh 的可攜規則是可攜的，不能因為加了可攜檢查就被拿掉或讓整份標成不完整。
 */

import { configToJsonSchema } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { mcpConfigSchema } from './index.js';
import { SERVER_NAME_PATTERN } from './names.js';

describe('mcpConfigSchema 的 JSON Schema', () => {
  it('serverName 的 pattern 原樣保留，沒有 pattern 這一種不完整', () => {
    const result = configToJsonSchema(mcpConfigSchema);
    expect(result.losses.filter((loss) => loss.kind === 'pattern')).toEqual([]);
    const properties = result.schema?.['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['serverName']?.['pattern']).toBe(SERVER_NAME_PATTERN.source);
  });
});

describe('HTTP 連線的 url 驗證', () => {
  const parse = (url: string) =>
    mcpConfigSchema.safeParse({ serverName: 'srv', connection: { transport: 'http', url } });

  it('帶帳密的網址被拒，任何一處錯誤輸出都找不到帳密', () => {
    const result = parse('https://alice:hunter2-pw@example.test/mcp');
    expect(result.success).toBe(false);
    const dumped = JSON.stringify(result.error?.issues) + String(result.error?.message);
    expect(dumped).not.toContain('hunter2-pw');
    expect(dumped).not.toContain('alice');
    expect(dumped).toContain('headers');
  });

  it('只帶使用者名稱也拒', () => {
    expect(parse('https://alice@example.test/mcp').success).toBe(false);
  });

  it('非法網址被拒，訊息不印原文', () => {
    const result = parse('not a url with SECRET-TOKEN');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues) + String(result.error?.message)).not.toContain(
      'SECRET-TOKEN',
    );
  });

  it('沒帳密的網址照收，含 query', () => {
    expect(parse('https://example.test/mcp').success).toBe(true);
    expect(parse('http://127.0.0.1:8080/mcp?x=1').success).toBe(true);
  });
});
