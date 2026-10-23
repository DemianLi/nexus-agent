/**
 * 有些檔讀不到時，`grep`／`glob` 不整次失敗（[#1704](https://github.com/DemianLi/nexus-agent/issues/1704)，偏離 dsh 的理由 2）。
 *
 * rg 碰到讀不到的檔會回 2，stdout 其實已經有其餘檔的命中。dsh 一律判成 `SEARCH_FAILED`；多人共用一台主機時，
 * 工作區裡一個別人的 0600 檔就能讓搜根的 grep 整個不能用。`ripgrep-runner.ts` 檔頭「偏離 1」寫了判準：結束碼 2、
 * stderr 沒被截尾、每個非空行都是 `rg: <路徑>: Permission denied (os error 13)`。
 *
 * 三層：
 *
 * 1. **runner**（假 rg 腳本）：判準的每一個條件各一條反例——拿掉任何一個，對應那條會紅。
 * 2. **backend 與真的組裝**：假 rg 是「真的 rg 加一段 stderr 與結束碼 2」，所以 stdout 是 rg 自己排的、不是手寫的 JSON；
 *    這一層不依賴檔案權限，root 跑也成立。
 * 3. **真的 `chmod 000`**：真 rg 碰真的讀不到的檔。root 讀得到 0000 的檔，所以 `process.getuid() === 0` 時跳過；
 *    第 2 層就是為了讓這件事在 root 的 CI 上也有東西盯著。
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages';
import { SEARCH_FAILED, SEARCH_INVALID_PATTERN } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';

import { createCliAgent } from './assembly-root.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ripgrepStatus } from './rg-path.js';
import { runRipgrep, STDERR_MAX_BYTES } from './ripgrep-runner.js';

vi.mock('./rg-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rg-path.js')>();
  return { ...actual, resolveRgPath: vi.fn(actual.resolveRgPath) };
});
const { resolveRgPath } = await import('./rg-path.js');
const realResolveRgPath = (await vi.importActual<typeof import('./rg-path.js')>('./rg-path.js'))
  .resolveRgPath;

const shipped = await shippedPlugins();

/** 這一句是 rg 寫的「讀不到」，字樣在 macOS 與 Linux 實測過（見 PR 內文）。 */
const denied = (path: string): string => `rg: ${path}: Permission denied (os error 13)`;
const isRoot = process.getuid?.() === 0;

let base: string;
let root: string;
let rg: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nexus-rg-unreadable-'));
  root = join(base, 'ws');
  await mkdir(root);
  await writeFile(join(root, 'a.log'), 'needle 一\nplain\nneedle 二\n');
  await writeFile(join(root, 'notes.txt'), 'needle 在 txt 裡\n');
  vi.mocked(resolveRgPath).mockImplementation(realResolveRgPath);
  const status = await ripgrepStatus();
  if (status.kind !== 'bundled') throw new Error(`內附 rg 不可用：${status.reason}`);
  rg = status.path;
});

afterEach(async () => {
  vi.restoreAllMocks();
  // 還原權限再刪，否則 rm 刪不掉 0000 的目錄。
  await chmod(join(root, 'locked-dir'), 0o755).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

/** 一個可執行的腳本。 */
async function script(name: string, body: string): Promise<string> {
  const file = join(base, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/** 真的 rg 照常跑，跑完另外寫 stderr、結束碼換成 2：stdout 是 rg 自己排的。 */
async function rgThatCannotRead(stderr: readonly string[], exit = 2): Promise<string> {
  const lines = stderr.map((line) => `echo '${line}' >&2`).join('\n');
  return script('rg-with-unreadable.sh', `"${rg}" "$@"\n${lines}\nexit ${String(exit)}`);
}

const paths = (result: { matches?: Array<{ path: string }> }): string[] =>
  [...new Set((result.matches ?? []).map((match) => match.path))].sort();

describe('runner：判準的每個條件各有一條反例', () => {
  const run = async (executable: string) =>
    runRipgrep({
      argv: ['--json'],
      cwd: root,
      executable,
      tolerateUnreadable: { searchRoots: ['.'] },
    });

  it('結束碼 2、stderr 全是「讀不到」：交出 stdout，並數出讀不到幾條', async () => {
    const executable = await script(
      'ok.sh',
      `echo '{"type":"summary"}'\n${[denied('./b.txt'), denied('./sub')].map((l) => `echo '${l}' >&2`).join('\n')}\nexit 2`,
    );
    expect(await run(executable)).toEqual({
      kind: 'ok',
      stdout: '{"type":"summary"}\n',
      noMatches: false,
      unreadable: 2,
    });
  });

  it('反例：`$` 錨點——`Permission denied (os error 13)` 後面還接了別的字：照舊 SEARCH_FAILED（B1）', async () => {
    // 檔名剛好長得像一條「讀不到」（`x: Permission denied (os error 13)`），搜到一半被刪掉時 rg 印的是這個形狀。
    // 沒有行尾錨點的話，子字串比對會放行它。
    const executable = await script(
      'anchor.sh',
      `echo 'rg: ./x: Permission denied (os error 13): No such file or directory (os error 2)' >&2\nexit 2`,
    );
    expect(await run(executable)).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
  });

  it('路徑裡有冒號也取得到完整路徑（貪婪比到最後一個）：放行', async () => {
    const executable = await script('colon.sh', `echo '${denied('./a: b/c')}' >&2\nexit 2`);
    expect(await run(executable)).toMatchObject({ kind: 'ok', unreadable: 1 });
  });

  it('搜尋起點本身讀不到（`.`）：照舊 SEARCH_FAILED，整個起點都沒搜到不能當成沒有命中（B3，dsh search.ts:211-217）', async () => {
    const executable = await script(
      'root.sh',
      `echo '{"type":"summary"}'\necho '${denied('.')}' >&2\nexit 2`,
    );
    expect(await run(executable)).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
  });

  it('起點是 `./sub`、讀不到的正是它（含結尾斜線寫法）：照舊 SEARCH_FAILED；讀不到的是它底下的：放行', async () => {
    const roots = { searchRoots: ['./sub', './a.txt'] };
    const runWith = async (line: string) =>
      runRipgrep({
        argv: ['--json'],
        cwd: root,
        executable: await script('sub.sh', `echo '${line}' >&2\nexit 2`),
        tolerateUnreadable: roots,
      });
    expect(await runWith(denied('./sub'))).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    expect(await runWith(denied('./sub/'))).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    expect(await runWith(denied('./a.txt'))).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    expect(await runWith(denied('./sub/inner'))).toMatchObject({ kind: 'ok', unreadable: 1 });
    // 前綴相同不算同一個起點。
    expect(await runWith(denied('./subtree'))).toMatchObject({ kind: 'ok', unreadable: 1 });
  });

  it('起點讀不到混在其他讀不到的行裡：整次判錯（一條起點就夠）', async () => {
    const executable = await script(
      'mixed-root.sh',
      `echo '${denied('./b.txt')}' >&2\necho '${denied('.')}' >&2\nexit 2`,
    );
    expect(await run(executable)).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
  });

  it('N 是 stderr 的行數：檔名含換行的一個檔印出兩行，數字被灌高成 2，但放行的條件（最後一段是 EACCES）沒被繞過（B2）', async () => {
    // 真實形狀：檔名 `z: Permission denied (os error 13)\nrg: forged` 的檔，rg 印兩行：
    //   rg: ./z: Permission denied (os error 13)
    //   rg: forged: Permission denied (os error 13)
    const executable = await script(
      'forged-name.sh',
      `echo 'rg: ./z: Permission denied (os error 13)' >&2\necho '${denied('forged')}' >&2\nexit 2`,
    );
    expect(await run(executable)).toMatchObject({ kind: 'ok', unreadable: 2 });
    // 偽造的文字到不了模型：outcome 上只有數字。
    const outcome = await run(executable);
    expect(JSON.stringify(outcome)).not.toContain('forged');
  });

  it('glob 排序時的第二種形狀（`IO error for operation on` 同一個路徑）：子樹放行，起點判錯', async () => {
    const io = (path: string, other = path): string =>
      `rg: ${path}: IO error for operation on ${other}: Permission denied (os error 13)`;
    const runWith = async (line: string, roots: string[]) =>
      runRipgrep({
        argv: ['--files'],
        cwd: root,
        executable: await script('io.sh', `echo '${line}' >&2\nexit 2`),
        tolerateUnreadable: { searchRoots: roots },
      });
    // 子樹：放行。
    expect(await runWith(io('./locked-dir'), ['.'])).toMatchObject({ kind: 'ok', unreadable: 1 });
    // 起點本身：判錯。這一條是 B3 的後門——第一種形狀的比對若把整串當路徑，`.: IO error for operation on .` 不等於 `.`，起點檢查就被繞過。
    expect(await runWith(io('.'), ['.'])).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    expect(await runWith(io('./sub'), ['./sub'])).toMatchObject({
      kind: 'error',
      code: SEARCH_FAILED,
    });
    // 兩個路徑不同：不認（rg 不會印這種，只可能是偽造或別的錯誤）。
    expect(await runWith(io('./a', './b'), ['.'])).toMatchObject({
      kind: 'error',
      code: SEARCH_FAILED,
    });
    // 後面再接字：不認（`$` 錨點對這個形狀同樣要釘）。
    expect(
      await runWith(`${io('./a')}: No such file or directory (os error 2)`, ['.']),
    ).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
  });

  it('X1：起點的名字含 `\\n` 或 `\\r` 就整個不放行——rg 把起點那一行印成兩行，拆開的路徑都不等於起點', async () => {
    // 起點 `./x: Permission denied (os error 13)\nrg: y` 讀不到時 rg 實際印的兩行。
    const forged = [
      'rg: ./x: Permission denied (os error 13)',
      'rg: y: Permission denied (os error 13)',
    ];
    const runWith = async (roots: string[]) =>
      runRipgrep({
        argv: ['--json'],
        cwd: root,
        executable: await script(
          'newline-root.sh',
          `echo '${forged[0]}' >&2\necho '${forged[1]}' >&2\nexit 2`,
        ),
        tolerateUnreadable: { searchRoots: roots },
      });
    const withNewline = './x: Permission denied (os error 13)\nrg: y';
    expect(await runWith([withNewline])).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    expect(await runWith(['.', withNewline])).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    expect(await runWith(['./a\rb'])).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    // 起點完整、沒有換行：同一份 stderr 是起點底下的兩個檔，放行，N=2（檔名可以灌高 N，見檔頭）。
    expect(await runWith(['.'])).toMatchObject({ kind: 'ok', unreadable: 2 });
  });

  it('grep（--json）搭第二種形狀、起點 `.`：照舊 SEARCH_FAILED（Linux 非 root、根 chmod 000 實測，rg 15.0.0 arm64／x64）', async () => {
    // 實測輸出（~/.nexus-agent-evidence/2026-10-23/rg-unreadable-1704/linux3.txt）：根 0000 時 grep 也印第二種形狀，
    // stdout 只有 begin／end／summary 的 JSON、零命中，結束碼 2。
    const executable = await script(
      'grep-io-root.sh',
      `echo '{"type":"summary","data":{"stats":{"matches":0}}}'\n` +
        `echo 'rg: .: IO error for operation on .: Permission denied (os error 13)' >&2\nexit 2`,
    );
    expect(await run(executable)).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    // 同一行出現在起點底下的子路徑：放行（只差路徑，形狀與 argv 都相同）。
    const sub = await script(
      'grep-io-sub.sh',
      `echo 'rg: ./sub: IO error for operation on ./sub: Permission denied (os error 13)' >&2\nexit 2`,
    );
    expect(await run(sub)).toMatchObject({ kind: 'ok', unreadable: 1 });
  });

  it('預設不放行（dsh 的做法）：沒開 tolerateUnreadable 時，同一份「全是讀不到」的 stderr 照舊 SEARCH_FAILED', async () => {
    const executable = await script(
      'default.sh',
      `echo '{"type":"summary"}'\necho '${denied('./b.txt')}' >&2\nexit 2`,
    );
    expect(await runRipgrep({ argv: ['--json'], cwd: root, executable })).toMatchObject({
      kind: 'error',
      code: SEARCH_FAILED,
    });
  });

  it('反例：stderr 裡混了一行別種錯誤（路徑不存在）：照舊 SEARCH_FAILED', async () => {
    const executable = await script(
      'mixed.sh',
      `echo '${denied('./b.txt')}' >&2\necho 'rg: nope: IO error for operation on nope: No such file or directory (os error 2)' >&2\nexit 2`,
    );
    expect(await run(executable)).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
  });

  it('反例：regex 解析錯誤：照舊 SEARCH_INVALID_PATTERN，即使同時有讀不到的檔', async () => {
    const executable = await script(
      'regex.sh',
      `echo '${denied('./b.txt')}' >&2\necho 'rg: regex parse error:' >&2\necho '    (?:()' >&2\necho 'error: unclosed group' >&2\nexit 2`,
    );
    expect(await run(executable)).toMatchObject({ kind: 'error', code: SEARCH_INVALID_PATTERN });
  });

  it('反例：stderr 是空的：照舊 SEARCH_FAILED（沒有證據說是讀不到）', async () => {
    const executable = await script('empty.sh', 'exit 2');
    expect(await run(executable)).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
  });

  it('反例：結束碼不是 2（3），stderr 再像「讀不到」也照舊 SEARCH_FAILED', async () => {
    const executable = await script('exit3.sh', `echo '${denied('./b.txt')}' >&2\nexit 3`);
    expect(await run(executable)).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
  });

  it('反例：errno 不是 13：不是這個判準要放行的那一種（EPERM 的字樣，與同樣字樣卻是別的 errno）', async () => {
    for (const line of [
      'rg: ./x: Operation not permitted (os error 1)',
      'rg: ./x: Permission denied (os error 1)',
    ]) {
      const executable = await script('errno.sh', `echo '${line}' >&2\nexit 2`);
      expect(await run(executable)).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    }
  });

  it('反例：stderr 被截尾（別種錯誤在被截掉的前段）：照舊 SEARCH_FAILED，訊息帶截尾註記', async () => {
    // 別種錯誤只出現在最前面，後面 3000 行都是「讀不到」。每行固定 64 位元組（含換行），64 整除 STDERR_MAX_BYTES，
    // 所以留下的尾巴是最後 1024 整行、每一行都符合判準——只有「stderr 被截尾就不放行」這個條件能擋住它。
    expect(STDERR_MAX_BYTES % 64).toBe(0);
    const executable = await script(
      'flood-stderr.sh',
      `echo 'rg: boom: something else' >&2\nawk 'BEGIN{for(i=0;i<3000;i++) printf "rg: ./dir/%020d: Permission denied (os error 13)\\n", i}' >&2\nexit 2`,
    );
    const outcome = await run(executable);
    expect(outcome).toMatchObject({ kind: 'error', code: SEARCH_FAILED });
    expect(outcome.kind === 'error' ? outcome.message : '').toContain('[stderr truncated]');
    expect(outcome.kind === 'error' ? outcome.message : '').not.toContain('boom');
  });

  it('結束碼 0 與 1 照舊：unreadable 是 0', async () => {
    expect(await run(await script('zero.sh', 'echo hi\nexit 0'))).toMatchObject({
      kind: 'ok',
      noMatches: false,
      unreadable: 0,
    });
    expect(await run(await script('one.sh', 'exit 1'))).toMatchObject({
      kind: 'ok',
      noMatches: true,
      unreadable: 0,
    });
  });
});

describe('backend：假 rg（真的 rg 加 stderr 與結束碼 2），不依賴檔案權限', () => {
  it('grep：其餘檔的命中照樣回來，不是錯誤', async () => {
    const executable = await rgThatCannotRead([denied('./locked.txt')]);
    const backend = new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable },
      tolerateUnreadable: true,
    });

    const result = await backend.grep('needle', '/');

    expect(result.error).toBeUndefined();
    expect(paths(result)).toEqual(['/a.log', '/notes.txt']);
    expect(result.matches).toHaveLength(3);
  });

  it('grep：全部讀不到、零命中：空結果，不是錯誤（提示由 middleware 接上）', async () => {
    const executable = await rgThatCannotRead([denied('./locked.txt')]);
    const backend = new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable },
      tolerateUnreadable: true,
    });

    const result = await backend.grep('並不存在的字串', '/');

    expect(result.error).toBeUndefined();
    expect(result.matches ?? []).toEqual([]);
  });

  it('glob：其餘檔照樣列出', async () => {
    const executable = await rgThatCannotRead([denied('./locked-dir')]);
    const backend = new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable },
      tolerateUnreadable: true,
    });

    const result = await backend.glob('**/*.log', '/');

    expect(result.error).toBeUndefined();
    expect((result.files ?? []).map((file) => file.path)).toEqual(['/a.log']);
  });

  it('反例：stderr 混了別種錯誤：grep 照舊回錯誤，已經找到的不假裝是完整結果', async () => {
    const executable = await rgThatCannotRead([denied('./locked.txt'), 'rg: boom: something else']);
    const backend = new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable },
      tolerateUnreadable: true,
    });

    const result = await backend.grep('needle', '/');

    expect(result.matches).toBeUndefined();
    expect(result.error).toContain('search failed (exit 2)');
  });
});

describe('backend：預設與搜尋起點', () => {
  const tolerant = async (extra: string[] = [denied('./locked.txt')]) => ({
    executable: await rgThatCannotRead(extra),
  });

  it('預設不放行（dsh 的做法）：沒明確打開 tolerateUnreadable 的 backend，同一份 stderr 照舊 SEARCH_FAILED', async () => {
    // 暫存目錄（HostStashBackend）與附件路由都走這條：理由 2（多人共用主機）套不上 serve 自己的目錄。
    const { executable } = await tolerant();
    const backend = new ContainedFilesystemBackend({ rootDir: root, ripgrep: { executable } });

    const result = await backend.grep('needle', '/');

    expect(result.matches).toBeUndefined();
    expect(result.error).toContain('search failed (exit 2)');
  });

  it('搜尋起點（工作區根）讀不到：grep 與 glob 都判錯，不是空的成功（B3）', async () => {
    const { executable } = await tolerant([denied('.')]);
    const backend = new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable },
      tolerateUnreadable: true,
    });

    const grep = await backend.grep('needle', '/');
    expect(grep.matches).toBeUndefined();
    expect(grep.error).toContain('search failed (exit 2)');
    const glob = await backend.glob('*', '/');
    expect(glob.files).toBeUndefined();
    expect(glob.error).toContain('glob search failed (exit 2)');
  });

  it('明指一個讀不到的檔當起點：判錯（起點是 `./notes.txt`，rg 印的路徑正是它）；起點是目錄、底下的檔讀不到：放行', async () => {
    const asStart = await tolerant([denied('./notes.txt')]);
    const failing = new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable: asStart.executable },
      tolerateUnreadable: true,
    });
    expect((await failing.grep('needle', '/notes.txt')).error).toContain('search failed (exit 2)');

    const below = await tolerant([denied('./locked.txt')]);
    const passing = new ContainedFilesystemBackend({
      rootDir: root,
      ripgrep: { executable: below.executable },
      tolerateUnreadable: true,
    });
    expect((await passing.grep('needle', '/')).error).toBeUndefined();
  });
});

describe('掛進真的組裝：模型看得到「有幾條路徑沒搜到」', () => {
  async function runAgent(
    turns: Array<{ name: string; args: Record<string, unknown> }>,
  ): Promise<{ messages: ToolMessage[]; results: Array<Record<string, unknown>> }> {
    const built = await createCliAgent(
      { live: false, workspace: root },
      withScriptedModel(shipped, [
        ...turns.map((call) => ({ content: '', toolCalls: [call] })),
        { content: '收工。' },
      ]),
      root,
    );
    const detach = built.attachSession(built.sessions);
    let state: { messages: BaseMessage[] } = { messages: [] };
    try {
      state = (await built.agent
        .invoke(toAgentInvocation('搜尋'), { configurable: { thread_id: 'rg-unreadable' } })
        .catch(() => state)) as { messages: BaseMessage[] };
    } finally {
      detach();
      await built.dispose();
    }
    const log = built.sessions.list().find((entry) => entry.address.kind === 'root');
    const events: readonly SessionEvent[] = log?.log.events ?? [];
    return {
      messages: state.messages.filter((m): m is ToolMessage => ToolMessage.isInstance(m)),
      results: events.flatMap((event) =>
        event.type === 'tool/result' ? [event.data as Record<string, unknown>] : [],
      ),
    };
  }

  it('grep：命中照樣回給模型，後面接一句「2 paths were unreadable … skipped」，日誌上不是錯誤', async () => {
    const executable = await rgThatCannotRead([denied('./locked.txt'), denied('./locked-dir')]);
    vi.mocked(resolveRgPath).mockResolvedValue(executable);

    const { messages, results } = await runAgent([
      { name: 'grep', args: { pattern: 'needle', path: '/', output_mode: 'content' } },
    ]);

    const text = String(messages[0]?.content);
    expect(messages[0]?.status).not.toBe('error');
    expect(text).toContain('/a.log');
    expect(text).toContain('/notes.txt');
    expect(text).toMatch(
      /\n\n\(2 paths were unreadable \(permission denied\) and skipped; results cover only the readable files\)$/u,
    );
    // 路徑是主機上別人的檔名，不交給模型。
    expect(text).not.toContain('locked');
    expect(results[0]?.['isError']).not.toBe(true);
    expect(results[0]?.['error']).toBeUndefined();
  }, 60_000);

  it('glob：同樣接一句（單數）', async () => {
    const executable = await rgThatCannotRead([denied('./locked-dir')]);
    vi.mocked(resolveRgPath).mockResolvedValue(executable);

    const { messages } = await runAgent([
      { name: 'glob', args: { pattern: '**/*.log', path: '/' } },
    ]);

    const text = String(messages[0]?.content);
    expect(messages[0]?.status).not.toBe('error');
    expect(text).toContain('/a.log');
    expect(text).toContain('(1 path was unreadable (permission denied) and skipped;');
  }, 60_000);

  it('反例：沒有讀不到的路徑時，結果後面什麼都不接', async () => {
    const { messages } = await runAgent([
      { name: 'grep', args: { pattern: 'needle', path: '/', output_mode: 'content' } },
    ]);

    expect(String(messages[0]?.content)).not.toContain('unreadable');
  }, 60_000);

  it('反例：stderr 混了別種錯誤：工具結果是錯誤，沒有「skipped」那句', async () => {
    const executable = await rgThatCannotRead([denied('./locked.txt'), 'rg: boom: something else']);
    vi.mocked(resolveRgPath).mockResolvedValue(executable);

    const { messages, results } = await runAgent([
      { name: 'grep', args: { pattern: 'needle', path: '/', output_mode: 'content' } },
    ]);

    expect(messages[0]?.status).toBe('error');
    expect(String(messages[0]?.content)).not.toContain('skipped');
    expect(results[0]).toMatchObject({ isError: true, error: { code: SEARCH_FAILED } });
  }, 60_000);
});

describe('掛進真的組裝：工作區明確打開、搜尋起點讀不到仍是錯誤', () => {
  it('工作區根讀不到：模型拿到的是錯誤（日誌帶 SEARCH_FAILED），沒有「skipped」那句（B3）', async () => {
    const executable = await rgThatCannotRead([denied('.')]);
    vi.mocked(resolveRgPath).mockResolvedValue(executable);
    const built = await createCliAgent(
      { live: false, workspace: root },
      withScriptedModel(shipped, [
        {
          content: '',
          toolCalls: [
            { name: 'grep', args: { pattern: 'needle', path: '/', output_mode: 'content' } },
          ],
        },
        { content: '收工。' },
      ]),
      root,
    );
    const detach = built.attachSession(built.sessions);
    let messages: ToolMessage[] = [];
    try {
      const state = (await built.agent
        .invoke(toAgentInvocation('搜尋'), { configurable: { thread_id: 'rg-root-unreadable' } })
        .catch(() => ({ messages: [] }))) as { messages: BaseMessage[] };
      messages = state.messages.filter((m): m is ToolMessage => ToolMessage.isInstance(m));
    } finally {
      detach();
      await built.dispose();
    }
    expect(messages[0]?.status).toBe('error');
    expect(String(messages[0]?.content)).not.toContain('skipped');
    expect(String(messages[0]?.content)).toContain('search failed (exit 2)');
  }, 60_000);
});

describe.skipIf(isRoot)(
  '真的 chmod 000（root 讀得到 0000 的檔，所以 root 跳過；上一組是它的替身）',
  () => {
    beforeEach(async () => {
      await writeFile(join(root, 'locked.txt'), 'needle 在讀不到的檔裡\n');
      await chmod(join(root, 'locked.txt'), 0o000);
      await mkdir(join(root, 'locked-dir'));
      await writeFile(join(root, 'locked-dir', 'inner.txt'), 'needle 在讀不到的目錄裡\n');
      await chmod(join(root, 'locked-dir'), 0o000);
    });

    it('夾具真的讀不到（不然下面的斷言是白綠）', async () => {
      const outcome = await runRipgrep({
        argv: ['--json', '--regexp=needle', '--', './locked.txt'],
        cwd: root,
        executable: rg,
        tolerateUnreadable: { searchRoots: ['.'] },
      });
      // 沒有放行機制之前，這一格是 error；現在是 ok 且 unreadable 為 1。兩者都證明 rg 真的碰到了讀不到的檔。
      expect(outcome).toMatchObject({ kind: 'ok', unreadable: 1 });
    });

    it('grep：讀不到的檔與目錄各一個，可讀的命中照樣回來', async () => {
      const result = await new ContainedFilesystemBackend({
        rootDir: root,
        tolerateUnreadable: true,
      }).grep('needle', '/');

      expect(result.error).toBeUndefined();
      expect(paths(result)).toEqual(['/a.log', '/notes.txt']);
    });

    it('反例：正規式壞掉（`(`）、同時有讀不到的檔：照舊 SEARCH_INVALID_PATTERN', async () => {
      const result = await new ContainedFilesystemBackend({
        rootDir: root,
        tolerateUnreadable: true,
      }).grep('(', '/');

      expect(result.matches).toBeUndefined();
      expect(result.error).toMatch(/^grep pattern rejected by ripgrep: /);
    });

    it('grep：明指一個讀不到的檔當起點：判錯（起點本身沒搜到，不是「零命中」）', async () => {
      const result = await new ContainedFilesystemBackend({
        rootDir: root,
        tolerateUnreadable: true,
      }).grep('needle', '/locked.txt');

      expect(result.matches).toBeUndefined();
      expect(result.error).toContain('search failed (exit 2)');
    });

    it('X1：起點的名字含換行、本身讀不到：判錯，不被拆成兩段路徑繞過起點比對', async () => {
      // 目錄名 `x: Permission denied (os error 13)\nrg: y`：rg 把「起點本身讀不到」那一行印成兩行，
      // 路徑被讀成 `./x` 與 `y`，都不等於起點。
      const name = 'x: Permission denied (os error 13)\nrg: y';
      await mkdir(join(root, name));
      await chmod(join(root, name), 0o000);
      const backend = new ContainedFilesystemBackend({ rootDir: root, tolerateUnreadable: true });
      try {
        const result = await backend.grep('needle', `/${name}`);
        expect(result.matches).toBeUndefined();
        expect(result.error).toContain('search failed (exit 2)');
      } finally {
        await chmod(join(root, name), 0o755);
      }
    });

    it('工作區根本身讀不到（chmod 0300）：grep 與 glob 都是錯誤，不是空的成功（B3）', async () => {
      // **根放在 /var/tmp，不用 `os.tmpdir()`**：macOS 的 TMPDIR（/var/folders/…）底下，cwd 讀不到的 rg 15.0.0 不結束、
      // 一直掛到 runner 的 30 秒逾時；/var/tmp 與 /private/tmp 都立刻回 exit 2。原因（複審查到的）：getcwd 讀不到 cwd 時
      // 改去逐項掃父目錄找回路徑，而 TMPDIR 底下有約 57.5 萬個項目，父目錄小的位置就不會卡。
      const unreadableRoot = await mkdtemp('/var/tmp/nexus-rg-root-');
      await writeFile(join(unreadableRoot, 'a.log'), 'needle\n');
      const backend = new ContainedFilesystemBackend({
        rootDir: unreadableRoot,
        tolerateUnreadable: true,
      });
      await chmod(unreadableRoot, 0o300);
      try {
        const grep = await backend.grep('needle', '/');
        expect(grep.matches).toBeUndefined();
        expect(grep.error).toContain('search failed (exit 2)');
        const glob = await backend.glob('*', '/');
        expect(glob.files).toBeUndefined();
        expect(glob.error).toContain('glob search failed (exit 2)');
      } finally {
        await chmod(unreadableRoot, 0o755);
        await rm(unreadableRoot, { recursive: true, force: true });
      }
    });

    it('起點是目錄、底下有讀不到的子目錄：放行；起點換成那個讀不到的子目錄：判錯', async () => {
      const backend = new ContainedFilesystemBackend({ rootDir: root, tolerateUnreadable: true });
      expect((await backend.grep('needle', '/')).error).toBeUndefined();
      expect((await backend.grep('needle', '/locked-dir')).error).toContain(
        'search failed (exit 2)',
      );
    });

    it('glob：讀不到的目錄不讓整次列檔失敗', async () => {
      const result = await new ContainedFilesystemBackend({
        rootDir: root,
        tolerateUnreadable: true,
      }).glob('*.log', '/');

      expect(result.error).toBeUndefined();
      expect((result.files ?? []).map((file) => file.path)).toEqual(['/a.log']);
    });
  },
);
