/**
 * 同一個 home 只能起一個 serve（[#1503](https://github.com/DemianLi/nexus-agent/issues/1503)）：量的是產品路徑
 * （`runServe` 加真的 wire client），鎖本身是真的 kernel flock，沒有替身——同一個行程對同一個鎖檔開兩次，
 * flock 一樣互斥（以 open file description 為單位），兩台 `runServe` 就是兩個行程的縮影。只有「這個平台拿不到」與
 * `EACCES` 兩條路換了拿鎖的那一下（`RunServeOptions.homeLock`）：macOS 與 CI 的 Linux 上走不到它們。
 * 行程死了 kernel 放鎖、致命退出之後重啟拿得到，要真的有另一個行程，在 `serve-shutdown.test.ts`。
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { HOME_LOCK_FILE_NAME, HomeInUseError } from './home-lock.js';
import { changePlugin } from './plugin-change.js';
import { PLUGIN_JOURNAL_FILE_NAME } from './plugin-journal.js';
import { PLUGIN_SNAPSHOT_FILE_NAME } from './plugin-snapshot.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { THREAD_ORGANIZATION_FILE } from './thread-organization.js';

const probePatch = fileURLToPath(new URL('./home-lock-probe.patch.yml', import.meta.url));
const temporary: string[] = [];
const servers: RunningServe[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => undefined);
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newHome(): { readonly dir: string; readonly env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-home-lock-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

async function start(
  env: NodeJS.ProcessEnv,
  extra: { readonly lines?: string[]; readonly homeLock?: (fd: number) => Promise<void> } = {},
): Promise<RunningServe> {
  const server = await runServe({
    argv: ['--port', '0'],
    log: (line) => extra.lines?.push(line),
    env,
    ...(extra.homeLock !== undefined && { homeLock: extra.homeLock }),
  });
  if (server === undefined) throw new Error('runServe 沒有起來');
  servers.push(server);
  return server;
}

/** 一棵目錄樹的指紋：相對路徑 → 位元組與 mtime。鎖檔不算（見 {@link tree}）。 */
function tree(root: string): Record<string, { readonly bytes: string; readonly mtimeMs: number }> {
  const out: Record<string, { readonly bytes: string; readonly mtimeMs: number }> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      // 被拒的那一台為了拿鎖會 `open(…, 'w')` 鎖檔一次：它是空的、不帶任何狀態，mtime 會動，不是這一條要擋的寫入。
      if (entry.name === HOME_LOCK_FILE_NAME) continue;
      out[relative(root, path)] = {
        bytes: readFileSync(path).toString('base64'),
        mtimeMs: statSync(path).mtimeMs,
      };
    }
  };
  walk(root);
  return out;
}

/** 說一句話並把這一輪折完。 */
async function say(server: RunningServe, threadId: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, '說點什麼');
  await foldTurn(events);
  void events.return?.(undefined).catch(() => undefined);
}

describe('同一個 home 起兩台 serve', () => {
  it('第二台丟 HomeInUseError，訊息講出 home、鎖檔、lsof', async () => {
    const { dir, env } = newHome();
    await start(env);

    const second = start(env);
    await expect(second).rejects.toThrow(HomeInUseError);
    const lockPath = join(dir, HOME_LOCK_FILE_NAME);
    await expect(second).rejects.toThrow(dir);
    await expect(second).rejects.toThrow(`lsof ${lockPath}`);
    await expect(second).rejects.toThrow(HARNESS_HOME_ENV);
  });

  it('第二台被拒之後，home 底下一個位元組、一個 mtime 都沒動（釘選與插件快照都在）', async () => {
    const { dir, env } = newHome();
    const first = await start(env);
    await say(first, 'pinned');
    const client = await serveClient(first);
    await client.threadPin('pinned');
    expect(existsSync(join(dir, THREAD_ORGANIZATION_FILE))).toBe(true);
    expect(existsSync(join(dir, PLUGIN_SNAPSHOT_FILE_NAME))).toBe(true);
    const before = tree(dir);

    // 換一組 `--patch` 的話，沒擋住的第二台會把快照換成自己那一份（卡上失敗情境 3）；這裡不給 `--patch` 也一樣要擋。
    await expect(start(env)).rejects.toThrow(HomeInUseError);

    expect(tree(dir)).toEqual(before);
  }, 60000);

  it('第二台被拒之前，連變更紀錄的遷移都沒做（鎖排在 prepareJournal 之前）', async () => {
    const { dir, env } = newHome();
    await start(env);
    // 模擬「第二台一上來就會遷移」的狀態：沒有紀錄、舊的 patch 檔在。沒擋住的第二台會把它遷進紀錄、舊檔改名。
    const journal = join(dir, PLUGIN_JOURNAL_FILE_NAME);
    rmSync(journal, { force: true });
    const legacy = join(dir, 'cordis.patch.yml');
    writeFileSync(legacy, '- id: todo\n  disabled: true\n');
    chmodSync(legacy, 0o600);

    await expect(start(env)).rejects.toThrow(HomeInUseError);

    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(journal)).toBe(false);
  });

  it('第一台 close() 之後，同一個 home 第二台起得來', async () => {
    const { env } = newHome();
    const first = await start(env);
    await first.close();
    servers.length = 0;

    const second = await start(env);
    await say(second, 'a');
  });

  it('第一台在拿鎖之後起不來，也放鎖：修好之後同一個行程裡再起一台，起得來', async () => {
    const { dir, env } = newHome();
    // 權限過寬的整理檔：`ThreadOrganization.open` 拒絕，發生在拿鎖之後、綁 port 之前。
    const organization = join(dir, THREAD_ORGANIZATION_FILE);
    writeFileSync(organization, '{"version":1,"pinnedThreadIds":[],"archivedThreadIds":[]}');
    chmodSync(organization, 0o644);
    await expect(start(env)).rejects.toThrow(/其他使用者讀得到/u);

    chmodSync(organization, 0o600);
    await say(await start(env), 'a');
  });

  it('不同的 home 互不影響', async () => {
    await start(newHome().env);
    await start(newHome().env);
  });
});

describe('放鎖是 close() 的最後一步', () => {
  it('收尾期間（thread、插件、根都在卸載）鎖一直握著；close() 回來之後才放', async () => {
    const { dir, env } = newHome();
    const marker = join(dir, 'probe.marker');
    const arm = join(dir, 'probe.arm');
    process.env['HOME_LOCK_PROBE_MARKER'] = marker;
    process.env['HOME_LOCK_PROBE_ARM'] = arm;
    process.env['HOME_LOCK_PROBE_HOME'] = dir;
    try {
      const server = await runServe({
        argv: ['--port', '0', '--patch', probePatch],
        log: () => undefined,
        env,
      });
      if (server === undefined) throw new Error('runServe 沒有起來');
      servers.push(server);
      await say(server, 'a');

      writeFileSync(arm, '');
      await server.close();
      servers.length = 0;

      const reports = readFileSync(marker, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0);
      // 至少一次收尾回報過，而且每一次鎖都還握著。
      expect(reports.length).toBeGreaterThan(0);
      expect(reports).toEqual(reports.map(() => 'held'));
      // 收完之後鎖放了。
      const after = await start(env);
      await after.close();
    } finally {
      delete process.env['HOME_LOCK_PROBE_MARKER'];
      delete process.env['HOME_LOCK_PROBE_ARM'];
      delete process.env['HOME_LOCK_PROBE_HOME'];
    }
  }, 60000);
});

describe('一次性的 CLI 與 plugin-change 不被 serve 的鎖擋', () => {
  it('serve 跑著時，同一個 home 的 plugin-change 照常寫進變更紀錄', async () => {
    const { env } = newHome();
    await start(env);
    const result = await changePlugin({ op: 'disable', id: 'todo' }, { env });
    expect(result).toMatchObject({ outcome: 'recorded' });
  });
});

describe('平台拿不到 flock 與其他錯誤分得開', () => {
  const failing = (code: string) => async (): Promise<void> => {
    throw Object.assign(new Error(`boom ${code}`), { code });
  };

  it('ERR_FLOCK_UNSUPPORTED_PLATFORM：照常起來，伺服器日誌講一行；第二台也不被擋', async () => {
    const { env } = newHome();
    const lines: string[] = [];
    await start(env, { lines, homeLock: failing('ERR_FLOCK_UNSUPPORTED_PLATFORM') });
    const notice = lines.filter((line) => line.includes('[home 鎖]'));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain('不擋第二個 serve');
    expect(notice[0]).toContain('boom ERR_FLOCK_UNSUPPORTED_PLATFORM');

    await start(env, { homeLock: failing('ERR_FLOCK_UNSUPPORTED_PLATFORM') });
  });

  it('原生模組載不起來（ERR_DLOPEN_FAILED）同一條：照常起來', async () => {
    const { env } = newHome();
    const lines: string[] = [];
    await start(env, { lines, homeLock: failing('ERR_DLOPEN_FAILED') });
    expect(lines.some((line) => line.includes('[home 鎖]'))).toBe(true);
  });

  it('EACCES：serve 起不來，錯誤原樣，不是 HomeInUseError，也不吞成「退到不鎖」', async () => {
    const { env } = newHome();
    const lines: string[] = [];
    const attempt = start(env, { lines, homeLock: failing('EACCES') });
    await expect(attempt).rejects.toThrow('boom EACCES');
    await expect(attempt).rejects.not.toThrow(HomeInUseError);
    expect(lines.some((line) => line.includes('[home 鎖]'))).toBe(false);
  });
});
