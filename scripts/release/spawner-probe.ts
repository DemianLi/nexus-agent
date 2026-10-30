/**
 * 安裝樹裡的沙箱 spawner 真的起得來，也真的起得了主機上的程式（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）：
 * `verify-packed-install.ts` 的步驟 4e。
 *
 * 出貨的 spawner 是靜態連結 musl 的執行檔，工具子行程卻是主機上動態連 glibc 的程式（git 就是一支）。這一步起產物裡那支
 * spawner，等它送 `Ready`，再經它起一次主機的 `/usr/bin/git --version`，收 stdout 與結局。判斷是純函式
 * {@link spawnerProbeProblems}，單元測試在 `apps/harness/src/verify-packed-install.test.ts`。
 *
 * 控制通道的編解碼與 harness 共用 `apps/harness/src/sandbox-protocol.ts`。stdio 連線要由起 spawner 的這個行程自己 connect：
 * spawner 用 `SO_PEERCRED` 核對對方是不是它的父行程。
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import {
  type SpawnerEvent,
  decodeEvent,
  encodeRequest,
  frame,
  stdioHeader,
  takeFrames,
} from '../../apps/harness/src/sandbox-protocol.js';
import { SPAWNER_PATH } from './spawner.js';

/** 經 spawner 起的主機程式。 */
export const SPAWNER_PROBE_ARGV = ['/usr/bin/git', '--version'] as const;

/**
 * 給它的讀根：主機上 exec 一支動態連 glibc 的程式要的執行檔、載入器、函式庫與 `ld.so.cache`。主機上不存在的路徑不給
 * （spawner 打不開授權路徑就整筆回 `SandboxUnavailable`）。
 */
export const SPAWNER_PROBE_READABLE = ['/usr', '/lib', '/lib64', '/etc/ld.so.cache'] as const;

/** {@link probeInstalledSpawner} 收到的東西。 */
export interface SpawnerProbeOutcome {
  readonly events: readonly SpawnerEvent[];
  /** 經 spawner 起的程式寫到 stdout 的內容。 */
  readonly stdout: string;
  /** spawner 自己的 stderr。 */
  readonly stderr: string;
  /** 中途出的錯（逾時、spawner 起不來、看不懂的框）；沒出錯就沒有這一格。 */
  readonly error?: string;
}

/** 步驟 4e 的判斷：先 `Ready`，id 1 的那支 `Started`、`Exited` 0，stdout 是 git 的版本。 */
export function spawnerProbeProblems(outcome: SpawnerProbeOutcome): string[] {
  const tail = `stderr ${JSON.stringify(outcome.stderr.slice(-400))}`;
  if (outcome.error !== undefined) return [`沙箱 spawner 驗證中途出錯：${outcome.error}；${tail}`];
  const [first] = outcome.events;
  if (first?.type !== 'ready') {
    return [`產物裡的沙箱 spawner 沒有送 Ready：${JSON.stringify(first)}；${tail}`];
  }
  if (first.landlockAbi < 1)
    return ['這台主機沒有 Landlock，產物裡的沙箱 spawner 驗不到套上沙箱的那一條路'];
  const mine = outcome.events.filter((e) => 'id' in e && e.id === 1);
  const started = mine.find((e) => e.type === 'started');
  const exited = mine.find((e) => e.type === 'exited');
  if (started === undefined || exited?.type !== 'exited' || exited.code !== 0) {
    return [
      `經沙箱 spawner 起 ${SPAWNER_PROBE_ARGV.join(' ')} 沒有正常結束：${JSON.stringify(mine)}；${tail}`,
    ];
  }
  if (!outcome.stdout.startsWith('git version ')) {
    return [
      `經沙箱 spawner 起的 git 沒有印出版本：stdout ${JSON.stringify(outcome.stdout.slice(0, 200))}`,
    ];
  }
  return [];
}

/**
 * 起 `<root>/native/nexus-sandbox-spawner`，等 `Ready`，經它在 `scratch` 底下的工作區起 {@link SPAWNER_PROBE_ARGV}，
 * 收到結局、stdout 讀完為止。收尾一律關掉 spawner 的 stdin（它收到 EOF 就殺掉所有工具、結束），等不到就 `SIGKILL`。
 */
export async function probeInstalledSpawner(
  root: string,
  scratch: string,
  timeoutMs = 30_000,
): Promise<SpawnerProbeOutcome> {
  const socket = join(scratch, 'spawner.sock');
  const ws = join(scratch, 'spawner-ws');
  mkdirSync(ws, { recursive: true });
  const events: SpawnerEvent[] = [];
  let stdout = '';
  let stderr = '';
  let error: string | undefined;
  let pending = Buffer.alloc(0);
  let stdoutClosed = false;
  let wake = (): void => {};
  const child = spawn(join(root, SPAWNER_PATH), ['--listen', socket], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {},
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.once('close', () => wake());
  child.once('error', (e) => {
    error ??= e.message;
    wake();
  });
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      const { frames, rest } = takeFrames(Buffer.concat([pending, chunk]));
      pending = Buffer.from(rest);
      events.push(...frames.map(decodeEvent));
    } catch (e) {
      error ??= (e as Error).message;
    }
    wake();
  });
  child.stdin.on('error', () => {});
  const deadline = Date.now() + timeoutMs;
  const until = async (done: () => boolean, what: string): Promise<void> => {
    while (!done()) {
      if (error !== undefined) throw new Error(error);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`spawner 在${what}之前就結束了（exit ${String(child.exitCode)}）`);
      }
      if (Date.now() > deadline) throw new Error(`等${what}逾時`);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 100);
      });
    }
  };
  try {
    await until(() => events.length > 0, '第一筆事件');
    if (events[0]?.type === 'ready' && events[0].landlockAbi > 0) {
      child.stdin.write(
        frame(
          encodeRequest({
            type: 'spawn',
            id: 1,
            mode: 'workspace-write',
            pipes: 0b010,
            cwd: ws,
            readable: SPAWNER_PROBE_READABLE.filter((path) => existsSync(path)),
            writable: [ws],
            argv: [...SPAWNER_PROBE_ARGV],
            env: ['PATH=/usr/bin:/bin', 'LC_ALL=C'],
          }),
        ),
      );
      const conn = createConnection(socket);
      conn.on('error', (e) => (error ??= `stdout 連線：${e.message}`));
      conn.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      conn.on('close', () => {
        stdoutClosed = true;
        wake();
      });
      conn.write(stdioHeader(1, 1));
      await until(
        () => events.some((e) => (e.type === 'exited' || e.type === 'failed') && e.id === 1),
        ' id 1 的結局',
      );
      await until(() => stdoutClosed || events.some((e) => e.type === 'failed'), ' stdout 讀完');
      conn.destroy();
    }
  } catch (e) {
    error ??= (e as Error).message;
  } finally {
    child.stdin.end();
    const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await closed;
    clearTimeout(killer);
  }
  return { events, stdout, stderr, ...(error === undefined ? {} : { error }) };
}
