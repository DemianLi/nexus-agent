/**
 * 會話日誌真的落到磁碟上了——[#172](https://github.com/DemianLi/nexus-agent/issues/172)
 * 的端到端驗收。
 *
 * 上游那一半（批次窗口、圍堵翻面、暫停與重試）在
 * `@nexus/core` 的 `session-persistence.test.ts`；這一檔只問**檔案**：寫沒寫、寫了什麼、
 * 寫在哪、以及**沒寫在哪**。
 *
 * 最後那一條不是湊數的。日誌寫進 `--workspace` 底下的話，模型一個 `read_file` 就讀得到
 * 整份對話史、也改得動它——那正是 [#170](https://github.com/DemianLi/nexus-agent/issues/170)
 * 立下的那條線（`fold.ts:252`：「歷史是基礎建設，不是 agent 的工作區」）的第二次應用。
 */

import { mkdtemp, readdir, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { runCli, resolveSessionLogDir } from './cli.js';
import { createJsonlSessionStore } from './jsonl-session-store.js';
import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';

function recorder(): {
  printer: { log(l: string): void; error(l: string): void };
  stdout(): string;
} {
  const lines: string[] = [];
  return {
    printer: {
      log(line: string) {
        lines.push(line);
      },
      error(line: string) {
        lines.push(line);
      },
    },
    stdout: () => lines.join('\n'),
  };
}

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 跑一輪一次性模式，回傳印出來的東西。 */
async function runOnce(argv: readonly string[], cwd?: string): Promise<string> {
  const { printer, stdout } = recorder();
  await runCli({
    argv: [...argv],
    input: new PassThrough(),
    output: new PassThrough(),
    printer,
    ...(cwd !== undefined && { cwd }),
  });
  return stdout();
}

/** run 目錄底下唯一的那一個。 */
async function onlyRunDir(root: string): Promise<string> {
  const entries = await readdir(root);
  expect(entries).toHaveLength(1);
  return join(root, entries[0]!);
}

describe('--session-log 給了', () => {
  it('日誌寫成 jsonl，seq 從 0 連續，事件讀得回來', async () => {
    const root = await tmp('nexus-log-');
    await runOnce(['--session-log', root, '把這句話回聲一次。']);

    const runDir = await onlyRunDir(root);
    const body = await readFile(join(runDir, 'cli.jsonl'), 'utf8');
    const events = body
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as SessionEvent);

    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
    expect(events.map((event) => event.type)).toContain('turn/start');
    expect(events.map((event) => event.type)).toContain('turn/end');
  });

  it('header 跟日誌分開存，帶格式版本與身分', async () => {
    const root = await tmp('nexus-log-');
    const cwd = await tmp('nexus-cwd-');
    await runOnce(['--session-log', root, '把這句話回聲一次。'], cwd);

    const runDir = await onlyRunDir(root);
    const header = JSON.parse(await readFile(join(runDir, 'cli.header.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(header.version).toBe(SESSION_LOG_FORMAT_VERSION);
    expect(header.id).toBe('cli');
    expect(header.cwd).toBe(cwd);
    expect(typeof header.createdAt).toBe('number');
    // 血緣欄位在 root 上不該出現——它是 subagent 才有的東西。
    expect(header.parentSession).toBeUndefined();
  });

  it('披露那一行說得出寫去哪', async () => {
    const root = await tmp('nexus-log-');
    const printed = await runOnce(['--session-log', root, '把這句話回聲一次。']);
    expect(printed).toContain(`會話日誌：${root}`);
  });

  it('跑兩次不會撞——每一次組裝各自一個 run 目錄', async () => {
    const root = await tmp('nexus-log-');
    await runOnce(['--session-log', root, '第一次。']);
    await runOnce(['--session-log', root, '第二次。']);
    const entries = await readdir(root);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(await readdir(join(root, entry))).toEqual(
        expect.arrayContaining(['cli.header.json', 'cli.jsonl']),
      );
    }
  });
});

describe('--session-log 沒給', () => {
  it('什麼都不寫，而且披露明說只在記憶體裡', async () => {
    const cwd = await tmp('nexus-cwd-');
    const printed = await runOnce(['把這句話回聲一次。'], cwd);
    expect(printed).toContain('會話日誌：只在記憶體裡');
    expect(printed).not.toContain('會話日誌：/');
    // **「缺席就是關掉」要驗到磁碟上**，不能只驗那一行字——印對了但照樣偷偷寫，
    // 這一條才是唯一擋得住的。
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe('日誌不落在 agent 的工作區裡', () => {
  it('指到 --workspace 底下時當場拒絕，訊息指得出兩個路徑', async () => {
    const workspace = await tmp('nexus-ws-');
    const inside = join(workspace, 'logs');
    await expect(
      runOnce(['--workspace', workspace, '--session-log', inside, '嗨']),
    ).rejects.toThrow(/--session-log 不能在 --workspace 底下/);
    // **什麼都還沒建**：這道檢查排在載 plugin 與組 agent 之前。
    expect(await readdir(workspace)).toEqual([]);
  });

  it('工作區本身也算在底下', () => {
    expect(() => resolveSessionLogDir({ sessionLog: '/w', workspace: '/w' }, '/')).toThrow(
      /不能在 --workspace 底下/,
    );
  });

  it('兩個目錄分開時跑得完，而且工作區裡一個日誌檔都沒有', async () => {
    const workspace = await tmp('nexus-ws-');
    const root = await tmp('nexus-log-');
    await runOnce(['--workspace', workspace, '--session-log', root, '把這句話回聲一次。']);

    const runDir = await onlyRunDir(root);
    expect(await readdir(runDir)).toEqual(expect.arrayContaining(['cli.header.json', 'cli.jsonl']));
    // 工作區裡只有假模型自己寫的東西，沒有任何 jsonl。
    const inWorkspace = await readdir(workspace);
    expect(inWorkspace.filter((name) => name.endsWith('.jsonl'))).toEqual([]);
    expect(inWorkspace).not.toContain('cli.header.json');
  });

  it('沒有 --workspace 時不擋——沒有圍籬就沒有「在裡面」', () => {
    expect(resolveSessionLogDir({ sessionLog: 'logs' }, '/base')).toBe('/base/logs');
  });
});

describe('後端的兩條拒絕', () => {
  it('撞名時拒絕：不覆寫、也不續寫', async () => {
    const root = await tmp('nexus-log-');
    const store = createJsonlSessionStore({ rootDir: root });
    const header = { version: SESSION_LOG_FORMAT_VERSION, id: 'x', createdAt: 1 };
    const first = store.create(header);
    await first.append([{ type: 'turn/start', seq: 0, time: 1, data: { kind: 'resume' } }]);
    const second = store.create(header);
    await expect(
      second.append([{ type: 'turn/start', seq: 0, time: 2, data: { kind: 'resume' } }]),
    ).rejects.toThrow(/EEXIST/);
    await first.close();
  });

  it('seq 不連續時拒絕，訊息說得出應該是幾', async () => {
    const root = await tmp('nexus-log-');
    const store = createJsonlSessionStore({ rootDir: root });
    const stored = store.create({ version: SESSION_LOG_FORMAT_VERSION, id: 'y', createdAt: 1 });
    await expect(
      stored.append([{ type: 'turn/start', seq: 3, time: 1, data: { kind: 'resume' } }]),
    ).rejects.toThrow(/seq 是 3，應該是 0/);
    await stored.close();
  });

  it('關掉之後每個操作都拒絕', async () => {
    const root = await tmp('nexus-log-');
    await mkdir(root, { recursive: true });
    const store = createJsonlSessionStore({ rootDir: root });
    const stored = store.create({ version: SESSION_LOG_FORMAT_VERSION, id: 'z', createdAt: 1 });
    await stored.close();
    await expect(stored.flush()).rejects.toThrow(/已經關掉/);
  });
});
