/**
 * 刪除會話的 SIGKILL 測試（[#2957](https://github.com/DemianLi/nexus-agent/issues/2957)）：刪除在子行程裡跑，停在一個點上被 SIGKILL，
 * 再開一個新行程做恢復。結果只能是兩種一致的狀態之一：全在原處、索引沒有；或全在存放區、索引有、刪除記錄有一筆。
 * 用 throw 模擬當機不算數：這裡真的殺行程。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SESSION_LOG_FORMAT_VERSION, sessionDirectoryName } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openJsonlSessionStore, projectKey, sessionPathsIn } from './jsonl-session-store.js';
import {
  readThreadDeletionState,
  THREAD_DELETIONS_FILE,
  THREAD_DELETIONS_LOG_FILE,
} from './thread-deletion.js';

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'thread-deletion-crash.fixture.ts');
const THREAD = 'crash-thread';
const CHILD = `${THREAD}/run-1`;
const CWD = '/work/crash';
const PROJECT = projectKey(CWD);

let root: string;
let home: string;
let sessionsRoot: string;
let deletedRoot: string;
let projectDir: string;
let marker: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'thread-deletion-crash-'));
  home = join(root, 'home');
  sessionsRoot = join(home, 'sessions');
  deletedRoot = join(home, 'sessions-deleted');
  projectDir = join(sessionsRoot, PROJECT);
  marker = join(root, 'marker');
  mkdirSync(home, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function seed(id: string, parentSession?: string): Promise<void> {
  const stored = openJsonlSessionStore({ directory: projectDir }).create({
    version: SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: CWD,
    ...(parentSession !== undefined && { parentSession }),
  });
  await stored.append([{ type: 'model/usage', seq: 0, time: 1, data: {} } as SessionEvent]);
  await stored.close();
}

function envFor(mode: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    THREAD_DELETION_MODE: mode,
    THREAD_DELETION_MARKER: marker,
    THREAD_DELETION_HOME: home,
    THREAD_DELETION_SESSIONS: sessionsRoot,
    THREAD_DELETION_DELETED: deletedRoot,
    THREAD_DELETION_PROJECT: PROJECT,
    THREAD_DELETION_THREAD: THREAD,
  };
}

function run(mode: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
    cwd: HARNESS_DIR,
    env: envFor(mode),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function waitForMarker(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error('子行程沒有走到停住的那一點');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function killAndWait(child: ChildProcess): Promise<void> {
  // 停住的那一點應該還活著；若已經結束，就不是「殺掉停住的行程」，要明白講出來。
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`子行程已經結束（code ${String(child.exitCode)}），沒有停在那一點`);
  }
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}

async function recoverInFreshProcess(): Promise<void> {
  const child = run('recover');
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
}

/** 兩種一致的狀態之一；其餘（兩邊都有、兩邊都沒有、索引與檔案對不上）都拋。 */
async function consistentState(ids: readonly string[]): Promise<'original' | 'deleted'> {
  const names = ids.flatMap((id) => [
    sessionDirectoryName(id),
    basename(sessionPathsIn(projectDir, id).tombstone),
  ]);
  const atOriginal = names.map((name) => existsSync(join(projectDir, name)));
  const atDeleted = names.map((name) => existsSync(join(deletedRoot, PROJECT, name)));
  const state = await readThreadDeletionState(join(home, THREAD_DELETIONS_FILE));
  const logCount = existsSync(join(home, THREAD_DELETIONS_LOG_FILE))
    ? readFileSync(join(home, THREAD_DELETIONS_LOG_FILE), 'utf8')
        .split('\n')
        .filter((l) => l.includes(`"threadId":"${THREAD}"`)).length
    : 0;
  expect(state.intent).toBeNull();
  if (
    atOriginal.every(Boolean) &&
    atDeleted.every((x) => !x) &&
    state.deleted.length === 0 &&
    logCount === 0
  ) {
    return 'original';
  }
  if (
    atOriginal.every((x) => !x) &&
    atDeleted.every(Boolean) &&
    state.deleted.length === 1 &&
    logCount === 1
  ) {
    return 'deleted';
  }
  throw new Error(
    `既不是原處也不是存放區：原處 ${JSON.stringify(atOriginal)}，存放區 ${JSON.stringify(atDeleted)}，索引 ${String(state.deleted.length)}，記錄 ${String(logCount)}`,
  );
}

describe('刪除中途被 SIGKILL，新行程恢復', () => {
  it('跨磁碟複製完、刪來源之前殺掉：恢復之後只會是兩種一致的狀態之一（此處是往前做完）', async () => {
    await seed(THREAD);
    await seed(CHILD, THREAD);
    const child = run('delete-after-copy');
    await waitForMarker();
    // 殺之前的樣子：目的地已經完整、來源還在（複製完、刪來源之前）。
    expect(existsSync(join(projectDir, sessionDirectoryName(THREAD)))).toBe(true);
    expect(existsSync(join(deletedRoot, PROJECT, sessionDirectoryName(THREAD)))).toBe(true);
    await killAndWait(child);

    await recoverInFreshProcess();
    expect(await consistentState([THREAD, CHILD])).toBe('deleted');
    expect(existsSync(join(projectDir, sessionDirectoryName(THREAD)))).toBe(false);
  }, 60_000);

  it('寫入方放手之前殺掉（還沒列檔、還沒搬）：恢復之後也只會是兩種一致的狀態之一', async () => {
    await seed(THREAD);
    const child = run('delete-before-move');
    await waitForMarker();
    await killAndWait(child);

    await recoverInFreshProcess();
    expect(await consistentState([THREAD])).toBe('deleted');
  }, 60_000);

  it('恢復本身跑兩次結果不變', async () => {
    await seed(THREAD);
    const child = run('delete-after-copy');
    await waitForMarker();
    await killAndWait(child);
    await recoverInFreshProcess();
    const once = await consistentState([THREAD]);
    await recoverInFreshProcess();
    expect(await consistentState([THREAD])).toBe(once);
  }, 60_000);
});
