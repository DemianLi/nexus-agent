/**
 * MCP stdio server 怎麼起：沒宣告 `sandbox` 的見 {@link createMcpGuardWrapper}；宣告了的（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）：command 換成
 * spawner 的 `--exec`，它上好沙箱再 exec。不走常駐那一支：stdio 由 adapter 自己接，它沒有注入 transport 的位子。
 *
 * 讀根是系統執行期的目錄與檔、`command`、`cwd` 與宣告的 `readable`，寫根是宣告的 `writable`。宣告的路徑、`command`、`cwd` 都不能包住
 * `$HOME` 或 serve 的 home，也不能落在 serve 的 home 底下；判斷前先 realpath，違反就不連線。系統那幾項若包住這兩個 home，那一項不給，不算拒絕。
 * `--read`、`--write` 全是 realpath：重連用同一份 args，這些路徑若被換成連結，`--exec` 拒絕。
 *
 * @module
 */

import { access, constants, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  McpGuardRequest,
  McpGuardWrapper,
  McpSandboxRequest,
  McpSandboxWrapper,
} from '@nexus/plugin-mcp';

import { SYSTEM_READABLE } from './git-sandbox.js';
import { resolveHarnessHome } from './harness-home.js';
import { findSpawnerBinary } from './tool-launcher.js';

/** 系統執行期之外，server 常見的直譯器起動時會讀的檔。Node 讀不到 OpenSSL 設定就結束。 */
const MCP_SYSTEM_READABLE = [
  ...SYSTEM_READABLE,
  '/etc/ssl/openssl.cnf',
  '/etc/pki/tls/openssl.cnf',
  '/etc/localtime',
] as const;

const within = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot !== '..' && !fromRoot.startsWith('../') && !isAbsolute(fromRoot);
};

/** `PATH` 裡第一支能執行的；帶斜線的以 `cwd` 為基準。 */
async function findCommand(
  request: Pick<McpSandboxRequest, 'command' | 'cwd' | 'path'>,
): Promise<string | undefined> {
  const base = resolve(request.cwd ?? '.');
  const candidates = request.command.includes('/')
    ? [resolve(base, request.command)]
    : (request.path ?? process.env['PATH'] ?? '')
        .split(delimiter)
        .filter((dir) => dir !== '')
        .map((dir) => resolve(base, join(dir, request.command)));
  for (const candidate of candidates) {
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return undefined;
}

async function resolveCommand(request: McpSandboxRequest): Promise<string> {
  const found = await findCommand(request);
  if (found === undefined) throw new Error(`找不到可執行的 ${request.command}`);
  return found;
}

/** 包裝需要的主機事實，測試換掉。 */
export interface McpSandboxHost {
  readonly platform: NodeJS.Platform;
  /** spawner 執行檔；找不到是 `undefined`。 */
  readonly binary: string | undefined;
  /** serve 的 home。 */
  readonly serveHome: string;
  /** 使用者的 `$HOME` 與帳號的 home。 */
  readonly userHomes: readonly string[];
}

const productHost = (): McpSandboxHost => ({
  platform: process.platform,
  binary: findSpawnerBinary(),
  serveHome: resolveHarnessHome(process.env),
  userHomes: [process.env['HOME'] || homedir(), homedir()],
});

/**
 * 組裝點交給 MCP 插件的那一格。
 *
 * @param host - 主機事實，每次包裝才讀（`apply` 一次，重連沿用）。
 * @returns 包裝函式；它在不是 Linux、找不到 spawner、找不到 command、路徑不合規時 reject。沒有 Landlock 由 spawner 以 125 結束，變成連線失敗。
 */
export function createMcpSandboxWrapper(
  host: () => McpSandboxHost = productHost,
): McpSandboxWrapper {
  return async (request) => {
    const { platform, binary, serveHome, userHomes } = host();
    if (platform !== 'linux' || binary === undefined) {
      throw new Error('這台主機沒有沙箱，宣告了 sandbox 的 server 不連線');
    }
    const real = async (path: string): Promise<string> => realpath(path).catch(() => path);
    const homes = await Promise.all(userHomes.map(real));
    const serve = await real(serveHome);
    const forbidden = (path: string): boolean =>
      homes.some((home) => within(path, home)) || within(path, serve) || within(serve, path);
    const declared = async (path: string): Promise<string> => {
      const found = await realpath(resolve(request.cwd ?? '.', path)).catch(() => {
        throw new Error(`sandbox 的路徑不存在：${path}`);
      });
      if (forbidden(found)) throw new Error(`sandbox 不能開這個路徑：${path}`);
      return found;
    };
    const command = await resolveCommand(request);
    const given = [
      command,
      ...(request.cwd === undefined ? [] : [resolve(request.cwd)]),
      ...request.readable,
    ];
    const readable = await Promise.all(given.map(declared));
    const writable = await Promise.all(request.writable.map(declared));
    const system = await Promise.all(
      MCP_SYSTEM_READABLE.map(async (path) => {
        if ((await stat(path).catch(() => undefined)) === undefined) return undefined;
        const found = await real(path);
        return forbidden(found) ? undefined : found;
      }),
    );
    const roots = [...new Set([...system.filter((path) => path !== undefined), ...readable])];
    return {
      command: binary,
      args: [
        '--exec',
        ...roots.flatMap((path) => ['--read', path]),
        ...writable.flatMap((path) => ['--write', path]),
        '--',
        command,
        ...request.args,
      ],
    };
  };
}

/**
 * 沒宣告沙箱的 stdio server 也包 spawner 的 `--guard`（[#2197](https://github.com/DemianLi/nexus-agent/issues/2197)）：不上沙箱，
 * serve 被硬殺時跟著走。`PR_SET_PDEATHSIG` 綁的是起它的執行緒，stdio transport 在主執行緒上 spawn。
 *
 * command 原樣交給 `execvp`，PATH 與 argv[0] 跟直接起一樣。找不到程式時不包，讓直接起報它今天的錯。
 *
 * @param host - 主機事實，每次包裝才讀。
 * @returns 包裝函式；不是 Linux、找不到 spawner、找不到 command 時回 `undefined`，呼叫端照舊直接起。
 */
export function createMcpGuardWrapper(
  host: () => Pick<McpSandboxHost, 'platform' | 'binary'> = productHost,
): McpGuardWrapper {
  return async (request: McpGuardRequest) => {
    const { platform, binary } = host();
    if (platform !== 'linux' || binary === undefined) return undefined;
    if ((await findCommand(request)) === undefined) return undefined;
    return { command: binary, args: ['--guard', '--', request.command, ...request.args] };
  };
}

/**
 * 這台主機包不了 `--guard` 時，serve 起動講的那一句；包得了回 `undefined`。
 *
 * @param host - 主機事實。
 * @returns 要講的話。
 */
export function mcpGuardNotice(
  host: Pick<McpSandboxHost, 'platform' | 'binary'> = productHost(),
): string | undefined {
  if (host.platform === 'linux' && host.binary !== undefined) return undefined;
  return '[MCP] 這台主機沒有 spawner：沒宣告 sandbox 的 stdio server 直接起，serve 被硬殺時可能留下孤兒';
}
