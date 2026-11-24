/**
 * 祖先被刪之後，分叉的子會話仍然沿祖先鏈找得到更早的外溢來源（[#2957](https://github.com/DemianLi/nexus-agent/issues/2957)）。
 *
 * 鏈是 Z ← A ← B（B 從 A 分叉、A 從 Z 分叉）。刪掉 A 之後，B 的祖先鏈要退回已刪除存放區去找 A 的 header，
 * 才會繼續找到 Z。外溢檔本身不搬，所以 Z 的外溢內容照原處讀得到；這裡只驗祖先鏈不斷。
 */

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSION_LOG_FORMAT_VERSION, SessionNotFoundError } from '@nexus/core';
import type { StoredSessionHeader } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forkAncestors, withDeletedFallback } from './fork-stash.js';
import { openJsonlSessionStore, projectKey } from './jsonl-session-store.js';
import { ThreadDeletions, graceMsOfDays } from './thread-deletion.js';

const CWD = '/work/fork';
const PROJECT = projectKey(CWD);
const OWNER = { kind: 'owner' } as const;

let root: string;
let home: string;
let projectDir: string;
let deletedRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fork-stash-deleted-'));
  home = join(root, 'home');
  projectDir = join(home, 'sessions', PROJECT);
  deletedRoot = join(home, 'sessions-deleted');
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function seedChain(): Promise<void> {
  const store = openJsonlSessionStore({ directory: projectDir });
  const z = store.create({ version: SESSION_LOG_FORMAT_VERSION, id: 'Z', createdAt: 1, cwd: CWD });
  await z.append([{ type: 'model/usage', seq: 0, time: 1, data: {} } as never]);
  await z.close();
  const a = store.create({
    version: SESSION_LOG_FORMAT_VERSION,
    id: 'A',
    createdAt: 2,
    cwd: CWD,
    parentSession: 'Z',
    isSeeded: true,
  } as StoredSessionHeader);
  await a.append([{ type: 'model/usage', seq: 0, time: 1, data: {} } as never]);
  await a.close();
  const b = store.create({
    version: SESSION_LOG_FORMAT_VERSION,
    id: 'B',
    createdAt: 3,
    cwd: CWD,
    parentSession: 'A',
    isSeeded: true,
  } as StoredSessionHeader);
  await b.append([{ type: 'model/usage', seq: 0, time: 1, data: {} } as never]);
  await b.close();
}

/** 活的目錄冷讀，找不到回 undefined（同 serve 的 `coldSessionHeader`）。 */
function liveReader(): (id: string) => Promise<StoredSessionHeader | undefined> {
  const store = openJsonlSessionStore({ directory: projectDir });
  return async (id) => {
    try {
      return (await store.open(id, 'read')).header;
    } catch (error: unknown) {
      if (error instanceof SessionNotFoundError) return undefined;
      throw error;
    }
  };
}

describe('分叉祖先鏈：祖先被刪之後', () => {
  it('刪掉中間那一代之後，沿鏈仍找到更早的祖先（退回已刪除存放區查 header）', async () => {
    await seedChain();
    const deletions = new ThreadDeletions({
      home,
      sessionsRoot: join(home, 'sessions'),
      deletedRoot,
      graceMs: graceMsOfDays(30),
      now: () => Date.now(),
    });
    await deletions.delete({ threadId: 'A', projectKey: PROJECT, actor: OWNER });

    const headerB = (await openJsonlSessionStore({ directory: projectDir }).open('B', 'read'))
      .header;
    // 活的目錄裡 A 已經不在了：不退回去查的話，鏈在 A 斷掉。
    expect(await liveReader()('A')).toBeUndefined();

    const broken: string[] = [];
    const withoutFallback = await forkAncestors(headerB, liveReader(), (m) => broken.push(m));
    expect(withoutFallback).toEqual(['A']);
    expect(broken).toHaveLength(1);

    const warnings: string[] = [];
    const fallback = withDeletedFallback(liveReader(), join(deletedRoot, PROJECT), (directory) =>
      openJsonlSessionStore({ directory }),
    );
    const chain = await forkAncestors(headerB, fallback, (m) => warnings.push(m));
    expect(chain).toEqual(['A', 'Z']);
    expect(warnings).toEqual([]);
  });

  it('祖先在活的目錄與存放區都找不到：照舊停下來講一聲，不拋', async () => {
    const headerB = {
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'B',
      createdAt: 3,
      cwd: CWD,
      parentSession: 'ghost',
      isSeeded: true,
    } as StoredSessionHeader;
    const fallback = withDeletedFallback(liveReader(), join(deletedRoot, PROJECT), (directory) =>
      openJsonlSessionStore({ directory }),
    );
    const warnings: string[] = [];
    expect(await forkAncestors(headerB, fallback, (m) => warnings.push(m))).toEqual(['ghost']);
    expect(warnings).toHaveLength(1);
  });
});
