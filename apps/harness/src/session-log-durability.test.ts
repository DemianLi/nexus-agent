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

/**
 * 檔名基底的單射性——[#174](https://github.com/DemianLi/nexus-agent/issues/174)。
 *
 * CLI 的 session id 是我們自己造的（`cli`、`cli/<runId>`），怎麼壓平都不會撞；
 * **`serve` 的是呼叫端給的**，所以壓平不再夠用。端到端那半在
 * [`serve-session-log.test.ts`](./serve-session-log.test.ts)，這裡守的是後端本身：
 * 兩條不同的 id 一定落成兩個檔，**長 id 也是**（那條路走的是截短加摘要，跟編碼那條
 * 不是同一段程式碼）。
 */
describe('檔名基底是單射的', () => {
  async function fileNames(ids: readonly string[]): Promise<readonly string[]> {
    const root = await tmp('nexus-log-');
    const store = createJsonlSessionStore({ rootDir: root });
    for (const [index, id] of ids.entries()) {
      const stored = store.create({ version: SESSION_LOG_FORMAT_VERSION, id, createdAt: index });
      await stored.append([{ type: 'turn/start', seq: 0, time: index, data: { kind: 'resume' } }]);
      await stored.close();
    }
    return (await readdir(store.directory)).filter((name) => name.endsWith('.jsonl')).sort();
  }

  it('壓平後同名的 id 各自一個檔', async () => {
    // 舊規則把三個都變成 `a_b`。`~` 與 `!` 在 URL 路徑段裡都是合法字元。
    expect(await fileNames(['a~b', 'a!b', 'a_b'])).toHaveLength(3);
  });

  it('subagent 的斜線還是不會變成子目錄，而且還讀得懂', async () => {
    const names = await fileNames(['cli/run-1']);
    expect(names).toEqual(['cli%2frun-1.jsonl']);
  });

  it('只差大小寫的 id 也各自一個檔', async () => {
    // macOS 與 Windows 的檔案系統預設不分大小寫，所以這一條在 Linux 上是恆真的，
    // 在開發機上才擋得到東西——而開發機正是 `serve` 會被跑起來的地方。
    expect(await fileNames(['Alpha', 'alpha'])).toHaveLength(2);
  });

  it('超長的 id 截短之後仍然分得開', async () => {
    const prefix = 'z'.repeat(200);
    const names = await fileNames([`${prefix}-one`, `${prefix}-two`]);
    expect(names).toHaveLength(2);
    // 截短是真的發生了，不是「剛好沒超過所以原樣寫下去」。
    for (const name of names) expect(name.length).toBeLessThan(prefix.length);
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
