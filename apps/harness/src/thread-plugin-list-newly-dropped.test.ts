/**
 * 「新掉」照字面算（[#1423](https://github.com/DemianLi/nexus-agent/issues/1423) 怎麼落實第 1 點）：
 * 上一次組裝或重讀還掛著、這一次掉了；起點是啟動那一份的結果。
 *
 * 這一檔量 `createThreadPluginList` 的記憶本身（不經 serve）：`noteDropped` 與 `noteAssemblyFailure`
 * 回傳的新掉的列 id、重讀交給記錄器的 `newlyDropped`。端到端的版本在 `serve-plugin-failed-record.test.ts`。
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginEntry } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { appendRaw } from './plugin-journal.fixture.js';
import type { FailedRow } from './plugin-failure-recorder.js';
import { createThreadPluginList } from './thread-plugin-list.js';
import type { ThreadPluginList } from './thread-plugin-list.js';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function reader() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-newly-dropped-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  const env = { [HARNESS_HOME_ENV]: dir };
  const startup = await loadDefaultPlugins({ serve: true, env, warn: () => {} });
  const noted: { rows: readonly FailedRow[]; at: string }[] = [];
  const reading = createThreadPluginList({
    load: (warn) => loadDefaultPlugins({ serve: true, env, warn }),
    startup,
    trialDropped: [],
    audit: { live: false },
    startupRead: [],
    log: () => {},
    recorder: {
      note: (rows, at) => void noted.push({ rows, at }),
      flush: () => Promise.resolve(),
    },
  });
  return { reading, noted, dir };
}

/** 清單上某一列的條目與它的 `AssemblyDrop` 形狀。 */
function dropOf(list: ThreadPluginList, id: string, stage: 'requires' | 'apply' = 'requires') {
  const entry = list.plugins.find((candidate) => list.loaded.rows.get(candidate)?.id === id);
  if (entry === undefined) throw new Error(`清單上沒有 ${id}`);
  return { entry: entry as PluginEntry, drop: { stage, message: '掉了', origin: { id } } };
}

describe('noteDropped 回的「新掉」', () => {
  it('啟動時掛著的列：第一次掉是新掉；再掉不是；掛回來之後再掉又是新掉', async () => {
    const { reading } = await reader();
    const list = await reading.read();
    const drop = dropOf(list, 'todo');

    // 第一次：啟動那一份它是掛著的。
    expect([...reading.noteDropped(list, [drop])]).toEqual(['todo']);
    // 同一條路再掉一次（重試照舊）：上一次就已經掉了。
    expect([...reading.noteDropped(list, [drop])]).toEqual([]);
    // 一次沒掉它的組裝：清單上沒停用、也不在 dropped 裡，就是掛上了。
    expect([...reading.noteDropped(list, [])]).toEqual([]);
    // 掛回來之後再掉：又是新掉。
    expect([...reading.noteDropped(list, [drop])]).toEqual(['todo']);
  });

  it('沒資料的列（清單上沒見過的 id）不算新掉：不套新規則', async () => {
    const { reading } = await reader();
    const list = await reading.read();
    const entry = dropOf(list, 'todo').entry;
    const stranger = {
      entry,
      drop: { stage: 'requires' as const, message: 'x', origin: { id: 'never-seen' } },
    };
    expect([...reading.noteDropped(list, [stranger])]).toEqual([]);
  });

  it('組裝失敗那一支（拋錯前先記）用同一套判斷，而且之後的 noteDropped 接著它', async () => {
    const { reading } = await reader();
    const list = await reading.read();
    const drop = dropOf(list, 'todo');
    expect([...reading.noteAssemblyFailure([drop])]).toEqual(['todo']);
    expect([...reading.noteAssemblyFailure([drop])]).toEqual([]);
    // 失敗那一次沒走完組裝，其餘的列掛沒掛上不知道，不會因此把 todo 記成掛上。
    expect([...reading.noteDropped(list, [drop])]).toEqual([]);
  });
});

describe('重讀交給記錄器的 newlyDropped', () => {
  it('讀清單時新掉（設定驗不過）：第一次是新掉，之後同一個掉法不再是新掉', async () => {
    const { reading, noted, dir } = await reader();
    await reading.read();
    expect(noted.flatMap((entry) => entry.rows)).toEqual([]);

    await appendRaw(dir, {
      op: 'config-set',
      id: 'todo',
      name: '@nexus/plugin-todo',
      before: null,
      after: { allowParallelInProgress: '不是布林' },
    });
    await reading.read();
    const first = noted.at(-1)?.rows.find((row) => row.id === 'todo');
    expect(first).toMatchObject({ stage: 'config', newlyDropped: true });

    await reading.read();
    const second = noted.at(-1)?.rows.find((row) => row.id === 'todo');
    expect(second).toMatchObject({ stage: 'config', newlyDropped: false });
  });
});
