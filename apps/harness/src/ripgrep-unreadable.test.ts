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
    runRipgrep({ argv: ['--json'], cwd: root, executable, tolerateUnreadable: true });

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
    const backend = new ContainedFilesystemBackend({ rootDir: root, ripgrep: { executable } });

    const result = await backend.grep('needle', '/');

    expect(result.error).toBeUndefined();
    expect(paths(result)).toEqual(['/a.log', '/notes.txt']);
    expect(result.matches).toHaveLength(3);
  });

  it('grep：全部讀不到、零命中：空結果，不是錯誤（提示由 middleware 接上）', async () => {
    const executable = await rgThatCannotRead([denied('./locked.txt')]);
    const backend = new ContainedFilesystemBackend({ rootDir: root, ripgrep: { executable } });

    const result = await backend.grep('並不存在的字串', '/');

    expect(result.error).toBeUndefined();
    expect(result.matches ?? []).toEqual([]);
  });

  it('glob：其餘檔照樣列出', async () => {
    const executable = await rgThatCannotRead([denied('./locked-dir')]);
    const backend = new ContainedFilesystemBackend({ rootDir: root, ripgrep: { executable } });

    const result = await backend.glob('**/*.log', '/');

    expect(result.error).toBeUndefined();
    expect((result.files ?? []).map((file) => file.path)).toEqual(['/a.log']);
  });

  it('反例：stderr 混了別種錯誤：grep 照舊回錯誤，已經找到的不假裝是完整結果', async () => {
    const executable = await rgThatCannotRead([denied('./locked.txt'), 'rg: boom: something else']);
    const backend = new ContainedFilesystemBackend({ rootDir: root, ripgrep: { executable } });

    const result = await backend.grep('needle', '/');

    expect(result.matches).toBeUndefined();
    expect(result.error).toContain('search failed (exit 2)');
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
        tolerateUnreadable: true,
      });
      // 沒有放行機制之前，這一格是 error；現在是 ok 且 unreadable 為 1。兩者都證明 rg 真的碰到了讀不到的檔。
      expect(outcome).toMatchObject({ kind: 'ok', unreadable: 1 });
    });

    it('grep：讀不到的檔與目錄各一個，可讀的命中照樣回來', async () => {
      const result = await new ContainedFilesystemBackend({ rootDir: root }).grep('needle', '/');

      expect(result.error).toBeUndefined();
      expect(paths(result)).toEqual(['/a.log', '/notes.txt']);
    });

    it('反例：正規式壞掉（`(`）、同時有讀不到的檔：照舊 SEARCH_INVALID_PATTERN', async () => {
      const result = await new ContainedFilesystemBackend({ rootDir: root }).grep('(', '/');

      expect(result.matches).toBeUndefined();
      expect(result.error).toMatch(/^grep pattern rejected by ripgrep: /);
    });

    it('grep：明指一個讀不到的檔，零命中、不是錯誤', async () => {
      const result = await new ContainedFilesystemBackend({ rootDir: root }).grep(
        'needle',
        '/locked.txt',
      );

      expect(result.error).toBeUndefined();
      expect(result.matches ?? []).toEqual([]);
    });

    it('glob：讀不到的目錄不讓整次列檔失敗', async () => {
      const result = await new ContainedFilesystemBackend({ rootDir: root }).glob('*.log', '/');

      expect(result.error).toBeUndefined();
      expect((result.files ?? []).map((file) => file.path)).toEqual(['/a.log']);
    });
  },
);
