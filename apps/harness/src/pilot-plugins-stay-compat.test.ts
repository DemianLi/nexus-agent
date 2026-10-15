/**
 * **present 留在相容層，不上樹**（[#1418](https://github.com/DemianLi/nexus-agent/issues/1418)）。
 *
 * 它是「逐條 thread 的東西在呼叫當下拿」那套接縫的試點：邏輯已經對（套一次、服務兩條 thread），但**不匯出 `manifest`**——
 * 上樹是 #1385 後面的卡，這裡刻意不做。`resolveEntryModule` 用 `isFunctionPluginModule` 決定一列走橋接還是走
 * `NexusPlugin`，所以斷言就釘在那個判別式上：哪天有人順手加了 `manifest`，這顆會靜靜改走橋接，這一檔先紅。
 *
 * **ask-user 已經不在這裡**（#1458）：它遷上樹了，`migrated-plugin-gate.test.ts` 的遷出名單接手，答題管道那一面由
 * `ask-user-on-tree.test.ts` 量。
 */

import { describe, expect, it } from 'vitest';

import { isFunctionPluginModule } from './plugin-tree.js';

const PILOTS = ['@nexus/plugin-present'] as const;

describe('試點插件不匯出 manifest，判別式判成非函式插件', () => {
  for (const specifier of PILOTS) {
    it(`${specifier}：isFunctionPluginModule 為 false，也沒有 manifest 具名匯出`, async () => {
      const namespace: unknown = await import(specifier);
      expect(isFunctionPluginModule(namespace)).toBe(false);
      expect((namespace as { manifest?: unknown }).manifest).toBeUndefined();
      // 走相容層的那條：default 是一顆 NexusPlugin（有 `name` 與 `apply`）。
      const entry = (namespace as { default?: { name?: unknown; apply?: unknown } }).default;
      expect(typeof entry?.name).toBe('string');
      expect(typeof entry?.apply).toBe('function');
    });
  }
});
