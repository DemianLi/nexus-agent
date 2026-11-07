/**
 * serve 的啟動器（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §3-2、§八）：
 * `per-thread` 時把這個行程 `process.execve` 換成監督行程 `nexus-supervisor`，由它起前台（`front-process.ts`）與每條 thread 的
 * 對話行程（`conversation-process.ts`）。`single` 時什麼都不做，`serve.ts` 照單行程起 server。
 *
 * - **模式**：`--process-model` 旗標優先，再來是 `#settings/process-model` 那一列，都沒有就是 `single`。那一列只疊層、不載模組
 *   （`composeDefaultEntries`）：疊層失敗或那一列寫壞了，旗標沒給或明講 `single` 都當成 `single`，交給 `runServe` 報；旗標明講
 *   `per-thread` 就在這裡拋。印用法、版本、設定的那幾個旗標一律走 `single`。
 * - **只在 Linux**：監督行程靠 signalfd、`/proc` 與 `PR_SET_PDEATHSIG`。其他平台要 `per-thread` 就拋。
 * - **兩邊的 leader 都是 node**：`process.execPath` 加上 `process.execArgv`（對話行程的拿掉 inspector 旗標，
 *   {@link childExecArgv}）再接入口檔，所以開發時（tsx 的 loader 在 execArgv 裡）與裝好的 `lib/*.js` 走同一條路。
 *   入口檔的副檔名跟這個模組一樣。
 * - **旗標分兩份**：前台拿除了 `--process-model` 以外的全部；對話行程只拿 {@link CONVERSATION_FLAGS} 那幾個，它不聽 port、不印登入網址。
 * - **PDEATHSIG 不能在 exec 時被清掉**：監督行程替前台與對話行程設了 `PR_SET_PDEATHSIG`，exec 帶 setuid、setgid 或
 *   file capabilities 的執行檔時核心會清掉它（prctl(2)），監督行程被 SIGKILL 時就會留下孤兒。所以 node 與監督行程本身都不能帶
 *   setuid／setgid 位元，非 root 時 node 也不能帶任何 capability（從 `/proc/self/status` 的 `CapPrm` 看：這個行程跑的就是同一支
 *   node）。帶了就拋，不起。
 *
 * @module
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { resolveHarnessHome } from './harness-home.js';
import { composeDefaultEntries } from './plugin-config.js';
import { threadCapacityConfigSchema } from './settings/thread-capacity.js';
import type { ConfigEntry } from './plugin-config.js';
import { PROCESS_MODEL_ENTRY_NAME, processModelConfigSchema } from './settings/process-model.js';
import type { ProcessModel, ProcessModelConfig } from './settings/process-model.js';

/** 產物裡監督行程的位置，相對於往上找到的那一層，同 spawner 的 `SPAWNER_PATH`。 */
export const SUPERVISOR_PATH = 'native/nexus-supervisor';

/** 對話行程的 socket 放在 home 底下這個目錄（監督行程建成 0700）。 */
export const SUPERVISOR_RUN_DIR = 'run';

/** 監督行程的稽核紀錄（JSONL，只追加）在 home 底下的檔名。 */
// session-file-exempt: 監督行程的稽核檔，不是會話日誌
export const SUPERVISOR_AUDIT_FILE = 'supervisor-audit.jsonl';

/** 對話行程也要的 serve 旗標：決定組裝與落盤的那幾個。其餘（port、登入網址、壓縮、信任的 Host）只歸前台。 */
export const CONVERSATION_FLAGS = [
  'live',
  'patch',
  'workspace',
  'sandbox',
  'session-log',
  'agent-loop',
  'goal-driver',
  'no-goal-driver',
] as const;

/** 只歸啟動器、不往下傳的旗標。 */
const LAUNCHER_FLAGS = ['process-model'] as const;

/** 這些旗標在時一律走 `single`：只印東西就結束，不起 server。 */
const PRINT_ONLY_FLAGS = [
  'help',
  'version',
  'dump-config',
  'dump-config-schema',
  'dump-default-config',
] as const;

/** 一個 serve 旗標收不收值，跟 `serve.ts` 的 `parseServeArgs` 同一張表（`process-launcher.test.ts` 掃原始碼比對）。 */
export const SERVE_FLAG_TAKES_VALUE: Readonly<Record<string, boolean>> = {
  live: false,
  patch: true,
  workspace: true,
  sandbox: true,
  'session-log': true,
  'agent-loop': true,
  port: true,
  'trusted-host': true,
  'public-url': true,
  'unix-socket': true,
  'socket-group': true,
  compression: true,
  'compression-level': true,
  'compression-threshold': true,
  'goal-driver': false,
  'no-goal-driver': false,
  'dump-config': false,
  'dump-config-schema': false,
  'dump-default-config': false,
  help: false,
  version: false,
  'process-model': true,
};

/** 照旗標名切開 serve 的 argv；每一段保留原本的寫法（`--a b` 或 `--a=b`）。 */
function flagGroups(argv: readonly string[]): { readonly name: string; readonly raw: string[] }[] {
  const { tokens } = parseArgs({
    args: [...argv],
    options: Object.fromEntries(
      Object.entries(SERVE_FLAG_TAKES_VALUE).map(([name, takesValue]) => [
        name,
        { type: takesValue ? 'string' : 'boolean', multiple: true },
      ]),
    ),
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const groups: { name: string; raw: string[] }[] = [];
  for (const token of tokens) {
    if (token.kind === 'option') {
      const raw = [token.rawName];
      if (token.value !== undefined) {
        if (token.inlineValue === true) raw[0] = `${token.rawName}=${token.value}`;
        else raw.push(token.value);
      }
      groups.push({ name: token.name, raw });
    } else if (token.kind === 'positional') {
      groups.push({ name: '', raw: [token.value] });
    }
  }
  return groups;
}

/**
 * 把 serve 的 argv 分給前台與對話行程。
 *
 * @returns `front`：拿掉 {@link LAUNCHER_FLAGS} 之後的全部；`conversation`：只留 {@link CONVERSATION_FLAGS}。
 */
export function splitServeArgv(argv: readonly string[]): {
  readonly front: readonly string[];
  readonly conversation: readonly string[];
} {
  const groups = flagGroups(argv);
  const keep = (names: readonly string[]) =>
    groups.filter((group) => names.includes(group.name)).flatMap((group) => group.raw);
  return {
    front: groups
      .filter((group) => !(LAUNCHER_FLAGS as readonly string[]).includes(group.name))
      .flatMap((group) => group.raw),
    conversation: keep(CONVERSATION_FLAGS),
  };
}

/** 這次啟動的旗標是不是只印東西（用法、版本、設定）。 */
export function isPrintOnly(argv: readonly string[]): boolean {
  return flagGroups(argv).some((group) =>
    (PRINT_ONLY_FLAGS as readonly string[]).includes(group.name),
  );
}

/** 疊完的清單上 `#settings/process-model` 那一列的設定；沒有那一列或關掉了回 schema 的預設。 */
export function processModelSetting(entries: readonly ConfigEntry[]): ProcessModelConfig {
  const found = entries.find(
    (entry) => entry.name === PROCESS_MODEL_ENTRY_NAME && entry.disabled !== true,
  );
  const parsed = processModelConfigSchema.safeParse(found?.config ?? {});
  if (!parsed.success) {
    throw new Error(
      `${PROCESS_MODEL_ENTRY_NAME}${found?.id === undefined ? '' : `（id: ${found.id}）`}的設定不合：${parsed.error.issues.map((issue) => issue.message).join('；')}`,
    );
  }
  return parsed.data;
}

/**
 * 疊完的清單上 `#settings/thread-capacity` 的閒置逐出時間，交給監督行程當 `--idle-ms`（`0` 同樣是不照時間收）。
 * 落盤那一列（`@nexus/core/session-persistence`）關著或不在時回 `0`：收掉的行程不留日誌，同 single 沒落盤時不逐出。
 * `maxThreads` 不交：監督行程的容量照記憶體算。
 *
 * @throws 這一列寫壞了：由啟動器報，不讓前台起不來、被監督行程一直重起。
 */
export function idleEvictAfterMs(entries: readonly ConfigEntry[]): number {
  const persistence = entries.find((entry) => entry.name === SESSION_PERSISTENCE_ENTRY_NAME);
  if (persistence === undefined || persistence.disabled === true) return 0;
  const found = entries.find((entry) => entry.name === THREAD_CAPACITY_ENTRY_NAME);
  const parsed = threadCapacityConfigSchema.safeParse(found?.config ?? {});
  if (!parsed.success) {
    throw new Error(
      `${THREAD_CAPACITY_ENTRY_NAME} 的設定不合：${parsed.error.issues.map((issue) => issue.message).join('；')}`,
    );
  }
  return parsed.data.idleEvictAfterMs;
}

const THREAD_CAPACITY_ENTRY_NAME = '#settings/thread-capacity';
const SESSION_PERSISTENCE_ENTRY_NAME = '@nexus/core/session-persistence';

/** 從這個模組往上找產物裡的監督行程；找不到回 `undefined`。 */
export function findSupervisorBinary(from = fileURLToPath(import.meta.url)): string | undefined {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = join(dir, SUPERVISOR_PATH);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** 啟動器讀外界的縫，只給測試用。 */
export interface PdeathsigProbe {
  /** 檔案的 mode（`stat` 的 `mode`）。 */
  readonly modeOf: (path: string) => number;
  /** `/proc/self/status` 的內容；讀不到回 `undefined`。 */
  readonly selfStatus: () => string | undefined;
  readonly uid: number | undefined;
}

const realProbe: PdeathsigProbe = {
  modeOf: (path) => statSync(path).mode,
  selfStatus: () => {
    try {
      return readFileSync('/proc/self/status', 'utf8');
    } catch {
      return undefined;
    }
  },
  uid: process.getuid?.(),
};

/**
 * 會讓 `PR_SET_PDEATHSIG` 在 exec 時被清掉的情形（見檔頭）。
 *
 * @returns 每一條是一句原因；空的是沒有。
 */
export function pdeathsigHazards(
  binaries: readonly { readonly label: string; readonly path: string }[],
  probe: PdeathsigProbe = realProbe,
): string[] {
  const hazards: string[] = [];
  for (const { label, path } of binaries) {
    const mode = probe.modeOf(path);
    if ((mode & 0o4000) !== 0) hazards.push(`${label} ${path} 帶 setuid 位元`);
    if ((mode & 0o2000) !== 0) hazards.push(`${label} ${path} 帶 setgid 位元`);
  }
  if (probe.uid !== 0) {
    const permitted = /^CapPrm:\s*([0-9a-f]+)$/mu.exec(probe.selfStatus() ?? '')?.[1];
    if (permitted !== undefined && BigInt(`0x${permitted}`) !== 0n) {
      hazards.push(
        `node 這個行程帶著 capability（/proc/self/status 的 CapPrm 是 ${permitted}）：執行檔帶 file capabilities（例如 setcap cap_net_bind_service），或繼承了 ambient capability`,
      );
    }
  }
  return hazards;
}

export interface SupervisorLaunch {
  readonly file: string;
  /** 不含 argv[0]。 */
  readonly args: readonly string[];
}

export interface SupervisorLaunchInput {
  readonly supervisor: string;
  readonly home: string;
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly frontEntry: string;
  readonly conversationEntry: string;
  readonly serveArgv: readonly string[];
  /** 對話行程閒置多久收掉（毫秒，`0` 不收）；省略用監督行程的預設。 */
  readonly idleMs?: number;
}

/** 值可以分開寫成下一個參數的 inspector 旗標。 */
const INSPECTOR_FLAGS_WITH_VALUE = new Set([
  '--inspect-port',
  '--debug-port',
  '--inspect-publish-uid',
]);

/**
 * 交給對話行程的 `execArgv`：拿掉 inspector 的旗標（`--inspect*`、`--debug-port`），其餘照原樣。前台照原樣拿：啟動器
 * `execve` 成監督行程之後，帶 `--inspect` 起 serve 時能接上的只剩前台。對話行程也帶上的話，第二個起來的就印「address already in use」、
 * 沒有 inspector 照跑。純函式。
 */
export function childExecArgv(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index]!;
    if (INSPECTOR_FLAGS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--inspect') || arg.startsWith('--debug-port')) continue;
    kept.push(arg);
  }
  return kept;
}

/** 監督行程的命令列（見 `native/sandbox-spawner/README.md`〈監督行程〉）。純函式。 */
export function supervisorLaunch(input: SupervisorLaunchInput): SupervisorLaunch {
  const { front, conversation } = splitServeArgv(input.serveArgv);
  const each = (flag: string, values: readonly string[]) =>
    values.flatMap((value) => [flag, value]);
  return {
    file: input.supervisor,
    args: [
      '--run-dir',
      join(input.home, SUPERVISOR_RUN_DIR),
      '--audit',
      join(input.home, SUPERVISOR_AUDIT_FILE),
      ...(input.idleMs === undefined ? [] : ['--idle-ms', String(input.idleMs)]),
      '--front',
      input.execPath,
      ...each('--front-arg', [...input.execArgv, input.frontEntry, ...front]),
      '--conversation',
      input.execPath,
      ...each('--conversation-arg', [
        ...childExecArgv(input.execArgv),
        input.conversationEntry,
        ...conversation,
      ]),
    ],
  };
}

/** 跟這個模組同一個副檔名的入口檔（開發時是 `.ts`，裝好之後是 `.js`）。 */
function sibling(name: string): string {
  const self = fileURLToPath(import.meta.url);
  return join(dirname(self), `${name}${extname(self)}`);
}

export interface LaunchContext {
  readonly argv: readonly string[];
  /** 旗標寫的模式；省略就讀設定列。 */
  readonly flag: ProcessModel | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

/**
 * 這次要用哪個模型。
 *
 * @throws 模式是 `per-thread`（旗標或設定列）但不是 Linux；旗標明講 `per-thread` 而疊層或 `process-model` 那一列寫壞了；
 *   模式是 `per-thread` 而 `thread-capacity` 那一列寫壞了（{@link idleEvictAfterMs}）。
 */
export function resolveProcessModel(context: LaunchContext): {
  readonly mode: ProcessModel;
  readonly supervisorBinary?: string;
  readonly idleMs?: number;
} {
  if (isPrintOnly(context.argv)) return { mode: 'single' };
  const { patch } = parseArgs({
    args: [...context.argv],
    options: { patch: { type: 'string', multiple: true } },
    strict: false,
    allowPositionals: true,
  }).values;
  const patches = Array.isArray(patch)
    ? patch.filter((value): value is string => typeof value === 'string')
    : undefined;
  let entries: readonly ConfigEntry[];
  try {
    // 警告不在這裡印：`runServe` 疊同一份清單時會印一次，這裡再印就是兩次。
    entries = composeDefaultEntries({
      serve: true,
      env: context.env,
      warn: () => {},
      ...(patches !== undefined && { patches }),
    });
  } catch (error) {
    // 疊層壞了：旗標沒給就當 `single`，`runServe` 會在同一個地方報同一個錯，這裡不先搶著報。旗標明講 `per-thread` 時在這裡拋：
    // 換成監督行程之後是前台報這個錯、起不來，監督行程會一直重起它。
    if (context.flag !== 'per-thread') return { mode: 'single' };
    throw error;
  }
  let setting: ProcessModelConfig;
  try {
    setting = processModelSetting(entries);
  } catch (error) {
    // 這一列寫壞了：旗標沒給或明講 `single` 就當 `single`。`runServe` 會把這一列當設定不合停用、列進啟動警告（不在必掛名單），
    // 而 `single` 是 per-thread 起不來時退回的路，不能被這一列擋住。旗標明講 `per-thread` 就在這裡拋，不換成監督行程。
    if (context.flag !== 'per-thread') return { mode: 'single' };
    throw error;
  }
  const mode = context.flag ?? setting.mode;
  if (mode === 'per-thread' && context.platform !== 'linux') {
    throw new Error(
      `--process-model per-thread 只在 Linux 起得來（監督行程要 signalfd、/proc 與 PR_SET_PDEATHSIG），這台是 ${context.platform}；改用 single`,
    );
  }
  const idleMs = mode !== 'per-thread' ? undefined : idleEvictAfterMs(entries);
  return {
    mode,
    ...(setting.supervisorBinary !== undefined && { supervisorBinary: setting.supervisorBinary }),
    ...(mode === 'per-thread' && idleMs !== undefined && { idleMs }),
  };
}

/**
 * `per-thread` 就換成監督行程，不會回來；`single` 回 `false`，呼叫端照單行程起 server。
 *
 * @throws 平台不對、設定列寫壞、找不到監督行程、PDEATHSIG 會被清掉，或 `execve` 失敗。
 */
export function launchProcessModel(context: LaunchContext): false {
  const model = resolveProcessModel(context);
  if (model.mode === 'single') return false;
  const supervisor = model.supervisorBinary ?? findSupervisorBinary();
  if (supervisor === undefined) {
    throw new Error(
      `找不到監督行程（往上找 ${SUPERVISOR_PATH}）：在 #settings/process-model 寫 supervisorBinary，或改用 single`,
    );
  }
  const hazards = pdeathsigHazards([
    { label: 'node', path: process.execPath },
    { label: '監督行程', path: supervisor },
  ]);
  if (hazards.length > 0) {
    throw new Error(
      `per-thread 起不來：監督行程替子行程設的 PR_SET_PDEATHSIG 會在 exec 時被核心清掉，監督行程被 SIGKILL 時會留下孤兒。${hazards.join('；')}`,
    );
  }
  const home = resolveHarnessHome(context.env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const launch = supervisorLaunch({
    supervisor,
    home,
    execPath: process.execPath,
    execArgv: process.execArgv,
    frontEntry: sibling('front-process'),
    conversationEntry: sibling('conversation-process'),
    serveArgv: context.argv,
    ...(model.idleMs !== undefined && { idleMs: model.idleMs }),
  });
  process.execve!(launch.file, [launch.file, ...launch.args], context.env);
  throw new Error('process.execve 回來了');
}
