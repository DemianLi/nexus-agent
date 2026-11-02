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

import { appendFile, mkdtemp, readdir, readFile, mkdir, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { runCli } from './cli.js';
import { resolveSessionLogDir, SESSION_LOG_OFF_DISCLOSURE } from './assembly-root.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { createJsonlSessionStore, sessionPathsIn } from './jsonl-session-store.js';
import { sessionHeaderOf } from './session-files.fixture.js';
import {
  generationLogFilename,
  SESSION_LOG_FORMAT_VERSION,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionSeq,
  sessionDirectoryName,
} from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

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

/** CLI 那份會話的世代檔：第一行是 header 行，事件從第二行起。 */
function cliLog(runDir: string): string {
  return sessionPathsIn(runDir, 'cli').log;
}

/** 世代檔裡 header 行之後的每一行（不含結尾的空字串）。 */
async function eventLinesOf(path: string): Promise<string[]> {
  const [, ...lines] = (await readFile(path, 'utf8')).split('\n');
  return lines.filter((line) => line.length > 0);
}

/** run 目錄裡 CLI 那份會話的目錄項：會話目錄與舊路徑上的墓碑。 */
const CLI_ENTRIES = ['cli', 'cli.header.json'];

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
    const [first] = (await readFile(cliLog(runDir), 'utf8')).split('\n');
    expect(JSON.parse(first ?? '')).toMatchObject({ type: 'session', id: 'cli' });
    const events = (await eventLinesOf(cliLog(runDir))).map(
      (line) => JSON.parse(line) as SessionEvent,
    );

    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
    expect(events.map((event) => event.type)).toContain('turn/start');
    expect(events.map((event) => event.type)).toContain('turn/end');
  });

  it('header 行帶格式版本與身分', async () => {
    const root = await tmp('nexus-log-');
    const cwd = await tmp('nexus-cwd-');
    await runOnce(['--session-log', root, '把這句話回聲一次。'], cwd);

    const runDir = await onlyRunDir(root);
    const { header, storedFormatVersion } = await sessionHeaderOf(runDir, 'cli');
    // 比磁碟上的版號：經接縫讀出來的 `header.version` 永遠是這一版（#1868）。
    expect(storedFormatVersion).toBe(SESSION_LOG_FORMAT_VERSION);
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
      expect(await readdir(join(root, entry))).toEqual(expect.arrayContaining(CLI_ENTRIES));
      expect(await readdir(join(root, entry, 'cli'))).toContain(
        generationLogFilename(SESSION_LOG_FORMAT_VERSION),
      );
    }
  });
});

/** 這條測試的 harness home（`test-home.setup.ts` 逐條換）。當場確認它不是真的那一份。 */
function testHarnessHome(): string {
  const home = process.env[HARNESS_HOME_ENV];
  expect(home).toBeDefined();
  expect(home).not.toBe(join(homedir(), '.nexus-agent'));
  expect(home!.startsWith(tmpdir())).toBe(true);
  return home!;
}

/** 權限的低九位。 */
async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/**
 * 預設落盤（[#444](https://github.com/DemianLi/nexus-agent/issues/444)）。**這一組是翻面來的**：
 * 以前這裡守的是「沒給就一個位元組都不寫」，拍板照 dsh 改成預設寫進 harness home 之後，同一個位置
 * 改守「沒給就寫進 home，而且只寫那裡」。
 */
describe('--session-log 沒給', () => {
  it('寫進 harness home 底下的 sessions，披露講得出那個位置，cwd 裡什麼都沒有', async () => {
    const home = testHarnessHome();
    const cwd = await tmp('nexus-cwd-');
    const printed = await runOnce(['把這句話回聲一次。'], cwd);

    const root = join(home, 'sessions');
    const runDir = await onlyRunDir(root);
    expect(await readdir(runDir)).toEqual(expect.arrayContaining(CLI_ENTRIES));
    expect(printed).toContain(`會話日誌：${runDir}`);
    expect(printed).not.toContain('只在記憶體裡');
    // 預設的位置是 home，不是跑的地方。
    expect(await readdir(cwd)).toEqual([]);
  });

  it('home 是這一次才建的話，一路都是 0700，檔是 0600', async () => {
    const home = testHarnessHome();
    // **前提**：這條測試的 home 還不存在，所以是落盤那一下建的（多人共用主機上，這一路的權限是承重的）。
    await expect(stat(home)).rejects.toThrow();
    await runOnce(['把這句話回聲一次。']);

    const root = join(home, 'sessions');
    const runDir = await onlyRunDir(root);
    const paths = sessionPathsIn(runDir, 'cli');
    for (const dir of [home, root, runDir, paths.sessionDirectory]) {
      expect(await modeOf(dir)).toBe(0o700);
    }
    for (const file of [paths.log, paths.lock, paths.tombstone]) {
      expect(await modeOf(file)).toBe(0o600);
    }
  });

  it('給了 --session-log 就只寫那裡，home 底下一個目錄都不開', async () => {
    const home = testHarnessHome();
    const root = await tmp('nexus-log-');
    await runOnce(['--session-log', root, '把這句話回聲一次。']);
    await onlyRunDir(root);
    await expect(stat(join(home, 'sessions'))).rejects.toThrow();
  });

  it('預設值指到 --workspace 底下時當場拒絕，訊息講得出路徑從哪來、怎麼繞', async () => {
    const workspace = await tmp('nexus-ws-');
    const env = { [HARNESS_HOME_ENV]: join(workspace, 'home') };
    expect(() => resolveSessionLogDir({ workspace }, '/', env)).toThrow(
      /預設的會話日誌目錄（NEXUS_AGENT_HOME .*不能在 --workspace 底下.*用 --session-log 指到工作區外面/su,
    );
    // --session-log 蓋過預設：它指到外面就放行，預設那一格根本不看。
    expect(resolveSessionLogDir({ sessionLog: '/elsewhere', workspace }, '/', env)).toBe(
      '/elsewhere',
    );
  });

  it('端到端：預設的根落在 --workspace 底下時，什麼都還沒建就拒絕', async () => {
    const workspace = await tmp('nexus-ws-');
    process.env[HARNESS_HOME_ENV] = join(workspace, 'home');
    await expect(runOnce(['--workspace', workspace, '嗨'])).rejects.toThrow(
      /預設的會話日誌目錄.*不能在 --workspace 底下/su,
    );
    expect(await readdir(workspace)).toEqual([]);
  });

  it('--resume 不看預設的根：它落在 --workspace 底下也照樣接得回來', async () => {
    const workspace = await tmp('nexus-ws-');
    const root = await tmp('nexus-log-');
    await runOnce(['--workspace', workspace, '--session-log', root, '第一次。']);
    const runDir = await onlyRunDir(root);
    // 預設的根這時落在工作區裡；續接寫回的是 runDir，不寫那裡，所以不該被擋。
    process.env[HARNESS_HOME_ENV] = join(workspace, 'home');
    const printed = await runOnce(['--workspace', workspace, '--resume', runDir, '第二次。']);
    expect(printed).toContain(`會話日誌：${runDir}`);
    expect(await readdir(workspace)).not.toContain('home');
  });
});

/** 把落盤那一列關掉的夾具（#612）。絕對路徑：`runCli` 的 `cwd` 是暫存目錄，不是這個套件。 */
const PERSISTENCE_OFF_PATCH = fileURLToPath(
  new URL('./settings/persistence-off.patch.yml', import.meta.url),
);

/**
 * 清單把落盤關掉（[#612](https://github.com/DemianLi/nexus-agent/issues/612)）。**這一組是 #444
 * 翻面前那條「沒給就一個位元組都不寫」的形狀**，觸發條件從「沒給旗標」換成「那一列 `disabled: true`」
 * ——照 dsh：不掛 `session-persistence-jsonl` 就是不落盤。
 */
describe('清單把落盤關掉', () => {
  it('一個位元組都不寫：home 不建、cwd 是空的，披露講只在記憶體裡與是哪一列', async () => {
    const home = testHarnessHome();
    const cwd = await tmp('nexus-cwd-');
    const printed = await runOnce(['--patch', PERSISTENCE_OFF_PATCH, '把這句話回聲一次。'], cwd);

    expect(printed).toContain(SESSION_LOG_OFF_DISCLOSURE);
    expect(printed).toContain('session-persistence');
    // 前提：這一跑真的跑完了（回聲出現），不是在落盤之前就停了。
    expect(printed).toContain('把這句話回聲一次。');
    // **home 整個不存在**——連 `sessions` 目錄都沒建，才叫一個位元組都不寫。
    await expect(stat(home)).rejects.toThrow();
    expect(await readdir(cwd)).toEqual([]);
  });

  it('預設的根落在 --workspace 底下也不擋：關掉的時候根本不解析它', async () => {
    const workspace = await tmp('nexus-ws-');
    process.env[HARNESS_HOME_ENV] = join(workspace, 'home');
    const printed = await runOnce([
      '--patch',
      PERSISTENCE_OFF_PATCH,
      '--workspace',
      workspace,
      '把這句話回聲一次。',
    ]);
    expect(printed).toContain(SESSION_LOG_OFF_DISCLOSURE);
    expect(await readdir(workspace)).not.toContain('home');
  });

  it('--resume 當場拒絕，點名那一列；那個 run 目錄一個位元組都沒動', async () => {
    const root = await tmp('nexus-log-');
    await runOnce(['--session-log', root, '第一次。']);
    const runDir = await onlyRunDir(root);
    const before = await readFile(cliLog(runDir), 'utf8');

    await expect(
      runOnce(['--patch', PERSISTENCE_OFF_PATCH, '--resume', runDir, '第二次。']),
    ).rejects.toThrow(/--resume 接不起來.*session-persistence.*disabled/su);
    expect(await readFile(cliLog(runDir), 'utf8')).toBe(before);
    // 租約也沒拿：拿了沒放的話，下一次正常的續接會撞上它。
    const printed = await runOnce(['--resume', runDir, '第三次。']);
    expect(printed).toContain(`會話日誌：${runDir}`);
  });

  it('--session-log 當場拒絕，那個目錄沒被建出來', async () => {
    const root = join(await tmp('nexus-log-'), 'not-yet');
    await expect(
      runOnce(['--patch', PERSISTENCE_OFF_PATCH, '--session-log', root, '嗨']),
    ).rejects.toThrow(/--session-log 跟設定矛盾.*session-persistence/su);
    await expect(stat(root)).rejects.toThrow();
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
    expect(() => resolveSessionLogDir({ sessionLog: '/w', workspace: '/w' }, '/', {})).toThrow(
      /不能在 --workspace 底下/,
    );
  });

  it('兩個目錄分開時跑得完，而且工作區裡一個日誌檔都沒有', async () => {
    const workspace = await tmp('nexus-ws-');
    const root = await tmp('nexus-log-');
    await runOnce(['--workspace', workspace, '--session-log', root, '把這句話回聲一次。']);

    const runDir = await onlyRunDir(root);
    expect(await readdir(runDir)).toEqual(expect.arrayContaining(CLI_ENTRIES));
    // 工作區裡只有假模型自己寫的東西，沒有任何 jsonl。
    const inWorkspace = await readdir(workspace, { recursive: true });
    expect(inWorkspace.filter((name) => name.endsWith('.jsonl'))).toEqual([]);
    expect(inWorkspace).not.toContain('cli.header.json');
    expect(inWorkspace).not.toContain('cli');
  });

  it('沒有 --workspace 時不擋——沒有圍籬就沒有「在裡面」', () => {
    expect(resolveSessionLogDir({ sessionLog: 'logs' }, '/base', {})).toBe('/base/logs');
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
      await stored.append([
        { type: 'turn/start', seq: SessionSeq(0), time: index, data: { kind: 'resume' } },
      ]);
      await stored.close();
    }
    // 會話目錄（墓碑以外的目錄項），每個裡面都有世代檔。
    const names = (await readdir(store.directory)).filter((name) => !name.endsWith('.header.json'));
    for (const name of names) {
      expect(await readdir(join(store.directory, name))).toContain(
        generationLogFilename(SESSION_LOG_FORMAT_VERSION),
      );
    }
    return names.sort();
  }

  it('壓平後同名的 id 各自一個檔', async () => {
    // 舊規則把三個都變成 `a_b`。`~` 與 `!` 在 URL 路徑段裡都是合法字元。
    expect(await fileNames(['a~b', 'a!b', 'a_b'])).toHaveLength(3);
  });

  it('subagent 的斜線還是不會變成子目錄，而且還讀得懂', async () => {
    const names = await fileNames(['cli/run-1']);
    expect(names).toEqual(['cli~002Frun-1']);
    expect(names).toEqual([sessionDirectoryName('cli/run-1')]);
  });

  it('自己就帶跳脫字元的 id 不會撞上被編碼出來的那個', async () => {
    // **這是編碼那條規則的對抗案例**：`a~b` 編出來就是 `a~007Eb`，所以一個字面上
    // 帶著 `a~007Eb` 的呼叫端必須落到別的地方去——`~` 自己也被編碼就是為了
    // 這個。編碼錯了的話，剛修好的撞名會從這條路原封不動地回來。
    expect(await fileNames(['a~b', 'a~007Eb', 'a%7eb'])).toHaveLength(3);
  });

  it('只差大小寫的短 id：分大小寫的檔案系統上各自一個目錄，不分的上面後建的那一份報撞名、不覆寫', async () => {
    // macOS 與 Windows 的檔案系統預設不分大小寫，所以這一條在 Linux 上走的是第一支，
    // 在開發機上走第二支——而開發機正是 `serve` 會被跑起來的地方。第二支：後建的那一份報撞名、不覆寫（#2132）。
    const probe = await tmp('nexus-case-');
    await mkdir(join(probe, 'A'));
    const caseInsensitive = await stat(join(probe, 'a')).then(
      () => true,
      () => false,
    );
    if (!caseInsensitive) {
      expect(await fileNames(['Alpha', 'alpha'])).toHaveLength(2);
      return;
    }
    await expect(fileNames(['Alpha', 'alpha'])).rejects.toThrow(SessionAlreadyExistsError);
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
  /**
   * **撞名在 `create` 當下就拒**（#1559 N0622）：第一個開著或關了都一樣，磁碟上已經有這份，`create` 同步拋
   * `SessionAlreadyExistsError`、不交出把手，一個位元組都不寫。**接著寫要走續接**，而第一個還開著時續接被寫租約擋
   * （`session-lease.ts`）。`create` 之後才出現的同名（`link`／`wx` 那兩道）見 `jsonl-session-store-hardening.test.ts`。
   */
  it('撞名時拒絕：不覆寫、也不續寫——create 當下就拒，開著時續接被租約擋', async () => {
    const root = await tmp('nexus-log-');
    const store = createJsonlSessionStore({ rootDir: root });
    const header: StoredSessionHeader = {
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'x',
      createdAt: 1,
    };
    const first = store.create(header);
    await first.append([
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { kind: 'resume' } },
    ]);
    expect(() => store.create(header)).toThrow(SessionAlreadyExistsError);
    await expect(store.resume('x')).rejects.toThrow(SessionAlreadyOwnedError);
    await first.close();

    expect(() => store.create(header)).toThrow(SessionAlreadyExistsError);
    // 磁碟上還是第一個寫的那一筆：沒被覆寫、也沒被續寫。
    const events = await (await store.open('x', 'read')).read();
    expect(events.map((event) => event.time)).toEqual([1]);
  });

  it('seq 不連續時拒絕，訊息說得出應該是幾', async () => {
    const root = await tmp('nexus-log-');
    const store = createJsonlSessionStore({ rootDir: root });
    const stored = store.create({ version: SESSION_LOG_FORMAT_VERSION, id: 'y', createdAt: 1 });
    await expect(
      stored.append([
        { type: 'turn/start', seq: SessionSeq(3), time: 1, data: { kind: 'resume' } },
      ]),
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

/**
 * `--resume` 碰到這一版不認得的事件種類（[#507](https://github.com/DemianLi/nexus-agent/issues/507)）。**整條產品路徑**：
 * CLI 寫一份真的日誌、事後補一行更新的版本才會寫的種類、再 `--resume`。單元層的斷言在 `session-store-read.test.ts`。
 */
describe('--resume 碰到不認得的事件種類', () => {
  /** 在一份剛寫完的日誌尾巴補一行 `future/thing`。回傳補之前有幾顆事件。 */
  async function plantFutureEvent(runDir: string, extra: Record<string, unknown>): Promise<number> {
    const path = cliLog(runDir);
    const lines = await eventLinesOf(path);
    await appendFile(
      path,
      `${JSON.stringify({ type: 'future/thing', seq: lines.length, time: 1, data: {}, ...extra })}\n`,
    );
    return lines.length;
  }

  it('沒標可忽略：當場拒絕，點名種類與第幾筆；日誌一個位元組都沒動', async () => {
    const root = await tmp('nexus-log-');
    await runOnce(['--session-log', root, '第一次。']);
    const runDir = await onlyRunDir(root);
    const seq = await plantFutureEvent(runDir, {});
    const before = await readFile(cliLog(runDir), 'utf8');

    await expect(runOnce(['--resume', runDir, '第二次。'])).rejects.toThrow(
      new RegExp(`第 ${seq} 筆事件種類是 "future/thing".*不認得.*沒標可忽略`, 'su'),
    );
    expect(await readFile(cliLog(runDir), 'utf8')).toBe(before);
  });

  it('標了 ignorable: true：接得回來，那一行原樣留著，新事件接在它後面、seq 連續', async () => {
    const root = await tmp('nexus-log-');
    await runOnce(['--session-log', root, '第一次。']);
    const runDir = await onlyRunDir(root);
    const seq = await plantFutureEvent(runDir, { ignorable: true });
    const planted = (await eventLinesOf(cliLog(runDir)))[seq];

    const printed = await runOnce(['--resume', runDir, '第二次。']);
    expect(printed).toContain('第二次。');

    const lines = await eventLinesOf(cliLog(runDir));
    expect(lines[seq]).toBe(planted);
    const events = lines.map((line) => JSON.parse(line) as SessionEvent);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
    expect(events.length).toBeGreaterThan(seq + 1);
    // 續接蓋成這一版（沒升版的詞彙成長也一樣：header 描述的是「現在這個 runtime 讀得懂的最新號」）。
    // 比磁碟上的版號：經接縫讀出來的 `header.version` 永遠是這一版（#1868）。
    expect((await sessionHeaderOf(runDir, 'cli')).storedFormatVersion).toBe(
      SESSION_LOG_FORMAT_VERSION,
    );
  });
});
