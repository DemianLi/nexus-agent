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

import { mkdtemp, readdir, readFile, mkdir, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { runCli, resolveSessionLogDir, SESSION_LOG_OFF_DISCLOSURE } from './cli.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { createJsonlSessionStore } from './jsonl-session-store.js';
import { SESSION_LOG_FORMAT_VERSION, SessionAlreadyOwnedError } from '@nexus/core';
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
    expect(await readdir(runDir)).toEqual(expect.arrayContaining(['cli.header.json', 'cli.jsonl']));
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
    for (const dir of [home, root, runDir]) expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(join(runDir, 'cli.jsonl'))).toBe(0o600);
    expect(await modeOf(join(runDir, 'cli.header.json'))).toBe(0o600);
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
    const before = await readFile(join(runDir, 'cli.jsonl'), 'utf8');

    await expect(
      runOnce(['--patch', PERSISTENCE_OFF_PATCH, '--resume', runDir, '第二次。']),
    ).rejects.toThrow(/--resume 接不起來.*session-persistence.*disabled/su);
    expect(await readFile(join(runDir, 'cli.jsonl'), 'utf8')).toBe(before);
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
    expect(await readdir(runDir)).toEqual(expect.arrayContaining(['cli.header.json', 'cli.jsonl']));
    // 工作區裡只有假模型自己寫的東西，沒有任何 jsonl。
    const inWorkspace = await readdir(workspace);
    expect(inWorkspace.filter((name) => name.endsWith('.jsonl'))).toEqual([]);
    expect(inWorkspace).not.toContain('cli.header.json');
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

  it('自己就帶百分號的 id 不會撞上被編碼出來的那個', async () => {
    // **這是編碼那條規則的對抗案例**：`a~b` 編出來就是 `a%7eb`，所以一個字面上
    // 帶著 `a%7eb` 的呼叫端必須落到別的地方去——`%` 自己也被編碼（`%25`）就是為了
    // 這個。編碼錯了的話，剛修好的撞名會從這條路原封不動地回來。
    expect(await fileNames(['a~b', 'a%7eb'])).toHaveLength(2);
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
  /**
   * **撞名有兩道，各擋一個時刻。** 第一個還開著：它握著寫租約，第二個在拿租約那一步就被擋
   * （`session-lease.ts`）。第一個關了：租約放掉，擋下來的是 `wx`——`SessionStore` 檔頭那條
   * 撞名絆索。兩條都要跑，只跑前一條的話 `wx` 被拿掉也照樣綠。
   */
  it('撞名時拒絕：不覆寫、也不續寫——開著時是租約擋，關了之後是 wx 擋', async () => {
    const root = await tmp('nexus-log-');
    const store = createJsonlSessionStore({ rootDir: root });
    const header = { version: SESSION_LOG_FORMAT_VERSION, id: 'x', createdAt: 1 };
    const first = store.create(header);
    await first.append([{ type: 'turn/start', seq: 0, time: 1, data: { kind: 'resume' } }]);
    const second = store.create(header);
    await expect(
      second.append([{ type: 'turn/start', seq: 0, time: 2, data: { kind: 'resume' } }]),
    ).rejects.toThrow(SessionAlreadyOwnedError);
    await second.close();
    await first.close();

    const third = store.create(header);
    await expect(
      third.append([{ type: 'turn/start', seq: 0, time: 3, data: { kind: 'resume' } }]),
    ).rejects.toThrow(/EEXIST/);
    await third.close();
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
