/**
 * 請求基準檔：存檔格式的無損往返、正規化，以及進版控的那批檔本身是完整的。
 *
 * 這裡**不**重跑場景去對基準檔，只守三件事：
 * 存的格式讀得回原樣、會隨執行變的字串有被換掉、已提交的基準檔每一份都解得開。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeText, normalizeValue } from './request-baseline.js';
import { BASELINE_DIR } from './request-baseline-refresh-paths.js';
import { decodeEndpoint, encodeEndpoint } from './request-baseline-format.js';
import type { EncodedCase, ToolsTable } from './request-baseline-format.js';

const body = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  model: 'm',
  messages,
  stream: true,
  ...extra,
});

describe('存檔格式：無損往返', () => {
  it('共用前綴、工具表、鍵順序都原樣讀回', () => {
    const tools = [{ type: 'function', function: { name: 'echo' } }];
    const bodies = [
      body([{ role: 'user', content: '一' }], { tools }),
      body(
        [
          { role: 'user', content: '一' },
          { role: 'assistant', content: '好' },
          { role: 'user', content: '二' },
        ],
        { tools },
      ),
      // 鍵順序不同：`tools` 在 `messages` 前面。
      { tools, messages: [{ role: 'user', content: '另一條' }], model: 'm' },
      // 沒有 tools、沒有共用。
      { messages: [], model: 'm' },
    ];
    const table: ToolsTable = {};
    const encoded = encodeEndpoint(bodies, table);
    expect(Object.keys(table)).toHaveLength(1);
    expect(encoded[1]!.messages).toMatchObject({ base: 0, keep: 1 });
    const decoded = decodeEndpoint(encoded, table);
    expect(decoded.map((item) => JSON.stringify(item))).toEqual(
      bodies.map((item) => JSON.stringify(item)),
    );
  });

  it('壞檔：工具表缺鍵、base 指到後面都拋', () => {
    const table: ToolsTable = {};
    const encoded = encodeEndpoint([body([{ role: 'user', content: 'x' }], { tools: [1] })], table);
    expect(() => decodeEndpoint(encoded, {})).toThrow('工具表沒有');
    expect(() =>
      decodeEndpoint(
        [
          {
            order: ['messages'],
            rest: {},
            messages: { base: 3, keep: 1, items: [] },
          },
        ],
        {},
      ),
    ).toThrow('不在它前面');
  });
});

describe('正規化', () => {
  it('暫存目錄、時間、UUID 換成記號；執行編號依首次出現編號', () => {
    expect(normalizeText('在 /var/folders/ab/cd1234/T/nexus-lh-xyz 下')).toBe('在 {{tmp}} 下');
    expect(normalizeText('於 2026-11-15T10:00:00.123Z')).toBe('於 {{time}}');
    expect(normalizeText('id 123e4567-e89b-12d3-a456-426614174000')).toBe('id {{uuid}}');
    const ids = new Map<string, string>();
    const out = normalizeValue(
      { a: 'bg-0123456789ab 與 bg-ba9876543210', b: ['bg-0123456789ab'] },
      ids,
    );
    expect(out).toEqual({ a: '{{id1}} 與 {{id2}}', b: ['{{id1}}'] });
  });
});

describe('已提交的基準檔', () => {
  const dirs = readdirSync(BASELINE_DIR, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  const table = JSON.parse(readFileSync(join(BASELINE_DIR, '_tools.json'), 'utf8')) as ToolsTable;
  const STATUSES = ['identical', 'summary-shape', 'known-difference', 'self-compared', 'unstable'];

  it('至少有一批案例，而且每一份都解得開', () => {
    let cases = 0;
    for (const dir of dirs) {
      for (const file of readdirSync(join(BASELINE_DIR, dir.name))) {
        const saved = JSON.parse(
          readFileSync(join(BASELINE_DIR, dir.name, file), 'utf8'),
        ) as EncodedCase & { status: string };
        expect(STATUSES, `${dir.name}/${file} 的狀態`).toContain(saved.status);
        if (saved.status === 'unstable') {
          // 不穩的只記狀態，不存內容。
          expect(saved.endpoints).toEqual([]);
        } else {
          expect(saved.endpoints.length, `${dir.name}/${file} 有請求`).toBeGreaterThan(0);
          for (const endpoint of saved.endpoints) decodeEndpoint(endpoint, table);
        }
        cases += 1;
      }
    }
    expect(cases).toBeGreaterThan(40);
  });
});
