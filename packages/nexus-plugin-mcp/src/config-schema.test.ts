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
