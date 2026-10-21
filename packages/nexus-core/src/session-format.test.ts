/**
 * 版本邊目錄的建構檢查與分類（#1529 驗收 A）。四種壞目錄各一格、每格都要拋：拿掉任何一條檢查，對應那一格紅。
 */

import { describe, expect, it } from 'vitest';

import {
  RELEASED_SESSION_FORMAT_VERSIONS,
  SESSION_FORMAT_CATALOG,
  SESSION_FORMAT_EDGES,
  classifyStoredFormatVersion,
  createSessionFormatCatalog,
} from './session-format.js';
import type { SessionFormatEdge } from './session-format.js';
import { SESSION_LOG_FORMAT_VERSION } from './session-store.js';

/** 出貨那份邊，改一處之後的副本。 */
function edgesWith(change: (edges: SessionFormatEdge[]) => void): SessionFormatEdge[] {
  const edges = SESSION_FORMAT_EDGES.map((edge) => ({ ...edge }));
  change(edges);
  return edges;
}

describe('出貨的目錄', () => {
  it('從 1 連續走到 SESSION_LOG_FORMAT_VERSION，每條都是 N→N+1', () => {
    expect(SESSION_FORMAT_CATALOG.current).toBe(SESSION_LOG_FORMAT_VERSION);
    expect(SESSION_FORMAT_CATALOG.edges.map((edge) => [edge.from, edge.to])).toEqual(
      Array.from({ length: SESSION_LOG_FORMAT_VERSION - 1 }, (_, index) => [index + 1, index + 2]),
    );
  });

  it('出過貨的版本都不比目前新，而且由小到大不重複', () => {
    expect([...RELEASED_SESSION_FORMAT_VERSIONS].sort((a, b) => a - b)).toEqual([
      ...new Set(RELEASED_SESSION_FORMAT_VERSIONS),
    ]);
    for (const version of RELEASED_SESSION_FORMAT_VERSIONS) {
      expect(version).toBeLessThanOrEqual(SESSION_LOG_FORMAT_VERSION);
    }
  });
});

describe('建構檢查（驗收 A）', () => {
  it('缺邊：拿掉 13→14 就拋', () => {
    const edges = edgesWith((all) => all.splice(12, 1));
    expect(() => createSessionFormatCatalog(edges)).toThrow(/缺 13→14/);
  });

  it('重複：同一條出現兩次就拋', () => {
    const edges = edgesWith((all) => all.push({ ...all[20]! }));
    expect(() => createSessionFormatCatalog(edges)).toThrow(/21→22 重複/);
  });

  it('不相鄰：from 3、to 5 就拋', () => {
    const edges = edgesWith((all) => {
      all[2] = { ...all[2]!, to: 5 };
    });
    expect(() => createSessionFormatCatalog(edges)).toThrow(/3→5 不是相鄰的兩版/);
  });

  it('沒走到常數：目前版本注入成多一號，最後一條就沒到', () => {
    const next = SESSION_LOG_FORMAT_VERSION + 1;
    expect(() => createSessionFormatCatalog(SESSION_FORMAT_EDGES, next)).toThrow(
      new RegExp(`缺 ${String(SESSION_LOG_FORMAT_VERSION)}→${String(next)} 這條邊`),
    );
  });

  it('比目前版本新的邊：常數注入成少一號就拋', () => {
    expect(() =>
      createSessionFormatCatalog(SESSION_FORMAT_EDGES, SESSION_LOG_FORMAT_VERSION - 1),
    ).toThrow(/有比目前版本 \d+ 新的邊/);
  });
});

describe('classifyStoredFormatVersion', () => {
  it('出貨的目錄：1 到目前都讀得了，多一號是 newer', () => {
    for (let version = 1; version <= SESSION_LOG_FORMAT_VERSION; version += 1) {
      expect(classifyStoredFormatVersion(version)).toBe('readable');
    }
    expect(classifyStoredFormatVersion(SESSION_LOG_FORMAT_VERSION + 1)).toBe('newer');
  });

  it('13→14 是 breaking：13 以前沒有遷移，14 以後照讀', () => {
    const catalog = createSessionFormatCatalog(
      edgesWith((all) => {
        all[12] = { ...all[12]!, kind: 'breaking' };
      }),
    );
    expect(classifyStoredFormatVersion(2, catalog)).toBe('older-without-migration');
    expect(classifyStoredFormatVersion(13, catalog)).toBe('older-without-migration');
    expect(classifyStoredFormatVersion(14, catalog)).toBe('readable');
    expect(classifyStoredFormatVersion(SESSION_LOG_FORMAT_VERSION, catalog)).toBe('readable');
    expect(classifyStoredFormatVersion(SESSION_LOG_FORMAT_VERSION + 1, catalog)).toBe('newer');
  });
});
