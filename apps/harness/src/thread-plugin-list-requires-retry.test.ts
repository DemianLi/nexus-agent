/**
 * 試組掉在 `requires` 的列，紀錄有新的被接受改動時重試一次
 * （[#1426](https://github.com/DemianLi/nexus-agent/issues/1426)）：量 `createThreadPluginList` 的記憶本身，不經 serve。
 * 端到端的版本在 `serve-requires-retry.test.ts`。
 *
 * 量具：啟動那一份用真的 `loadDefaultPlugins`（空的家目錄），把其中一列（`todo`）說成「試組掉了」，掉在哪一步由各條測試自己給。
 * 「被重試」的觀察量是 `read()` 交出的那一列有沒有被標成停用——標了就是記憶說「已知掉了、這一條不組裝」。
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginEntry } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin } from './plugin-change.js';
import { loadDefaultPlugins } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { appendRaw } from './plugin-journal.fixture.js';
import { createThreadPluginList } from './thread-plugin-list.js';
import type { ThreadPluginList } from './thread-plugin-list.js';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Stage = 'module' | 'config' | 'apply' | 'requires';

async function reader(stage: Stage) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-requires-retry-unit-'));
  temporary.push(dir);
  chmodSync(dir, 0o700);
  const env = { [HARNESS_HOME_ENV]: dir };
  const startup = await loadDefaultPlugins({ serve: true, env, warn: () => {} });
  const tripped = [...startup.plugins].find((entry) => startup.rows.get(entry)?.id === 'todo');
  if (tripped === undefined) throw new Error('啟動那一份沒有 todo 這一列');
  const reading = createThreadPluginList({
    load: (warn) => loadDefaultPlugins({ serve: true, env, warn }),
    startup,
    trialDropped: [tripped],
    trialDrops: [{ id: 'todo', stage, message: '試組掉了' }],
    audit: { live: false },
    startupRead: [],
    log: () => {},
  });
  return { reading, startup, env, dir };
}

/** 這一份清單上 `todo` 那一列有沒有被標成「已知掉了、不組裝」。 */
function todoOff(list: ThreadPluginList): boolean {
  const entry = list.plugins.find((candidate) => list.loaded.rows.get(candidate)?.id === 'todo');
  if (entry === undefined) throw new Error('清單上沒有 todo');
  return entry.disabled === true;
}

function todoEntry(list: ThreadPluginList): PluginEntry {
  const entry = list.plugins.find((candidate) => list.loaded.rows.get(candidate)?.id === 'todo');
  if (entry === undefined) throw new Error('清單上沒有 todo');
  return entry;
}

/** 紀錄裡多一筆不相干、被接受的改動：對 `skills` 交替停用與啟用，每一次都是真的改動。 */
const skillsOff = new Map<string, boolean>();
async function accepted(env: NodeJS.ProcessEnv): Promise<number> {
  const key = env[HARNESS_HOME_ENV] ?? '';
  const off = skillsOff.get(key) === true;
  const seq = (await changePlugin({ op: off ? 'enable' : 'disable', id: 'skills' }, { env })).record
    ?.seq;
  if (seq === undefined) throw new Error('沒有寫進紀錄');
  skillsOff.set(key, !off);
  return seq;
}

describe('掉在 requires 的列：鍵帶「最新被接受的 seq」', () => {
  it('沒有新的被接受改動就一直算掉了；有了就放行重試一次，又掉就用新的 seq 記住', async () => {
    const { reading, env } = await reader('requires');
    const first = await reading.read();
    expect(todoOff(first)).toBe(true);
    expect(todoOff(await reading.read())).toBe(true);

    const seq = await accepted(env);
    const second = await reading.read();
    expect(second.loaded.acceptedSeq).toBe(seq);
    // 紀錄有新的被接受改動：這一條放行重試。
    expect(todoOff(second)).toBe(false);
    // 重試又掉在 requires：用這一條讀到的 seq 記住。
    reading.noteDropped(second, [
      {
        entry: todoEntry(second),
        drop: { stage: 'requires', message: '又掉', origin: { id: 'todo' } },
      },
    ]);
    expect(todoOff(await reading.read())).toBe(true);
    expect(todoOff(await reading.read())).toBe(true);

    // 又有新的被接受改動：再放行一次。
    await accepted(env);
    expect(todoOff(await reading.read())).toBe(false);
  });

  it('重試掛上了：之後不再被標成停用', async () => {
    const { reading, env } = await reader('requires');
    expect(todoOff(await reading.read())).toBe(true);
    await accepted(env);
    const retried = await reading.read();
    expect(todoOff(retried)).toBe(false);
    // 這一條組裝沒有掉它：記憶不用動。
    reading.noteDropped(retried, []);
    expect(todoOff(await reading.read())).toBe(false);
  });

  it.each<Stage>(['module', 'config', 'apply'])(
    '掉在 %s 的列：紀錄有新的被接受改動也不重試（#1405 Q2 不變）',
    async (stage) => {
      const { reading, env } = await reader(stage);
      expect(todoOff(await reading.read())).toBe(true);
      await accepted(env);
      expect(todoOff(await reading.read())).toBe(true);
      await accepted(env);
      expect(todoOff(await reading.read())).toBe(true);
    },
  );

  it('重試時改掉在別的階段：之後只看宣告，不再因為紀錄的改動重試', async () => {
    const { reading, env } = await reader('requires');
    expect(todoOff(await reading.read())).toBe(true);
    await accepted(env);
    const retried = await reading.read();
    expect(todoOff(retried)).toBe(false);
    reading.noteDropped(retried, [
      {
        entry: todoEntry(retried),
        drop: { stage: 'apply', message: '這次壞在 apply', origin: { id: 'todo' } },
      },
    ]);
    expect(todoOff(await reading.read())).toBe(true);
    await accepted(env);
    expect(todoOff(await reading.read())).toBe(true);
  });
});

describe('acceptedSeq 只算被接受的紀錄', () => {
  async function acceptedSeqOf(env: NodeJS.ProcessEnv): Promise<LoadedPluginConfig['acceptedSeq']> {
    return (await loadDefaultPlugins({ serve: true, env, warn: () => {} })).acceptedSeq;
  }

  it('沒有紀錄檔：null', async () => {
    const { env } = await reader('requires');
    expect(await acceptedSeqOf(env)).toBeNull();
  });

  it('failed、rejected 不改它（不然重試又掉記下的那一筆 failed 會讓下一條再試一次）', async () => {
    const { env, dir } = await reader('requires');
    const seq = await accepted(env);
    expect(await acceptedSeqOf(env)).toBe(seq);

    await appendRaw(dir, { op: 'rejected', requested: 'enable', id: 'nope', reason: '沒有這一列' });
    await appendRaw(dir, {
      op: 'failed',
      id: 'todo',
      triggerSeq: seq,
      stage: 'requires',
      reason: '缺能力',
    });
    expect(await acceptedSeqOf(env)).toBe(seq);

    // 被接受的筆再來一筆，它就往前走。
    const next = await accepted(env);
    expect(next).toBeGreaterThan(seq);
    expect(await acceptedSeqOf(env)).toBe(next);
  });
});
