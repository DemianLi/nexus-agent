/**
 * 產生 `apps/harness/src/fixtures/session-format/` 的夾具（[#1529](https://github.com/DemianLi/nexus-agent/issues/1529) 第一刀）：
 * 每個出過貨的格式版本一份，**由那一版出貨的寫入器實際寫出**，不手寫、不改標籤。
 *
 * ## 怎麼寫
 *
 * 每個目標開一個暫存的 detached worktree（`git worktree add --detach`），`pnpm install --frozen-lockfile --offline
 * --ignore-scripts`（要下載就失敗、停下來，不會自己去抓），然後：
 *
 * 1. 用那一版自己的 CLI 跑一輪（不帶 `--live` 是那一版出貨的假模型 `ScriptedChatModel`：回聲一次、寫一個檔、回一句話），
 *    `--session-log` 落盤。這是那一版產品路徑上真的寫入器：註冊表、協調器、JSONL 後端全是那一版的。
 * 2. 有些讀方分支 CLI 一輪碰不到（評分、停在一輪中間），由 `in-tree/trigger-*.ts` 用**那一版自己的**
 *    `SessionLog`、後端與服務補寫。觸發腳本複製進那一版的 `apps/harness/src/`，先對那一版的型別 `tsc --noEmit`，再跑。
 * 3. 格式 9 以後的 tag 用那一版自己的 `replayConversation` 推模型歷史（`in-tree/expect-own.ts`），寫進 `expected.json`。
 * 4. 收掉 worktree。
 *
 * 今天才算得出來的輸出（以輪為目標的評分對到哪一則回覆、續接補結），由這支腳本 import 今天工作樹的 `@nexus/core` 原始碼算，
 * `expected.json` 逐格標明是誰算的。
 *
 * 混版（`mixed-v44-v49`）：`0c9e389c^`（格式 44，#1321 把摘要事件挪到呼叫之前的前一個 commit）的 CLI 寫前半，今天的 CLI
 * `--resume` 續寫後半；兩邊都用 patch 把摘要門檻壓低，讓舊順序與新順序的 `compaction/summary` 各出現一次。
 *
 * ## 固定的東西
 *
 * - CLI 的工作目錄固定為 {@link FIXTURE_CWD}：header 的 `cwd` 記的是它，重產才寫得出同一個值。
 * - 子行程只拿到 `PATH`、`LANG`、一個暫存的 `HOME` 與 `NEXUS_AGENT_HOME`（不讀任何人的 home patch，也碰不到任何金鑰）。
 *   `pnpm install` 例外：它要真的 `HOME` 找本機的 store，但環境裡的 `*_API_KEY` 一律拿掉。
 * - 全部目標跑完才一次寫進夾具目錄：每一次 CLI 跑的時候，這一輪還沒動過夾具目錄，CLI 記的 `build.dirty` 才會跟
 *   `expected.json` 的 `computedByToday.dirty` 一致（都要在乾淨的樹上跑）。
 *
 * ## 換機器重產不了
 *
 * - 離線安裝靠本機 pnpm store 裡已經有各 tag 的套件；換一台沒裝過那些 tag 的機器，安裝會失敗、停下來。
 * - header 的 `cwd` 記的是 {@link FIXTURE_CWD} 的 realpath（macOS 上是 `/private/var/tmp/…`），在 Linux 上重產會寫成
 *   `/var/tmp/…`，夾具會變。
 *
 * 不在 typecheck 與 lint 的範圍內（`in-tree/` 那幾支是對各 tag 的型別寫的，在今天的樹裡編不過）。
 *
 * 用法：`pnpm exec tsx scripts/session-format-fixtures/generate.ts [目標名…]`（省略即全部）。
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { ROOT } from '../workspace-packages.js';
import {
  approvalPolicyOnResume,
  currentMessageFeedback,
  interruptedTurnClosers,
  recordedApprovalPolicy,
  replayConversation,
} from '../../packages/nexus-core/src/index.ts';
import type { SessionEvent, StoredSessionHeader } from '../../packages/nexus-core/src/index.ts';
import { historyFrames } from '../../apps/harness/src/conversation-history.ts';
import { assertSameWorkspaceRoot } from '../../apps/harness/src/resume-guards.ts';
import { frozenFilesOf, readEvents, readRawHeader, sessionsIn } from './run-directory.ts';

/** header 的 `cwd` 記的那個目錄。 */
const FIXTURE_CWD = '/var/tmp/nexus-session-format-cwd';
const FIXTURES = join(ROOT, 'apps/harness/src/fixtures/session-format');
const HERE = join(ROOT, 'scripts/session-format-fixtures');
/** CLI 那一輪說的話。 */
const PROMPT = '你好';

/**
 * 讀方分支的觸發。有 `in-tree/trigger-<名>.ts` 的由那一版補寫事件；`workspace-root`、`approval-policy-missing` 與
 * `two-file-layout` 不用補寫（12 以前的 header 本來就沒有 `workspaceRoot`，34 以前的日誌本來就沒有 `approval/policy`，52 以前
 * 的寫入器本來就寫舊兩檔），只記今天的讀方對它的輸出。
 */
type Trigger =
  | 'turn-feedback'
  | 'turn-feedback-tail'
  | 'summary-missing'
  | 'open-turn'
  | 'workspace-root'
  | 'approval-policy-missing'
  | 'two-file-layout';

interface Target {
  /** 夾具目錄名。 */
  readonly name: string;
  /** 寫入器的 rev：tag 或 commit。`undefined` 是今天的工作樹。 */
  readonly rev: string | undefined;
  /** 那一版的 `SESSION_LOG_FORMAT_VERSION`，產生後核對。 */
  readonly version: number;
  readonly triggers?: readonly Trigger[];
  /** 有沒有 `replayConversation`（格式 9 起）。 */
  readonly ownReplay: boolean;
  /** 這一版有沒有出過貨。沒給就看 `rev`：tag 是出過貨的。 */
  readonly released?: boolean;
}

const TARGETS: readonly Target[] = [
  { name: 'v2', rev: 'v0.4.6', version: 2, ownReplay: false },
  { name: 'v3', rev: 'v0.4.7', version: 3, ownReplay: false },
  { name: 'v4', rev: 'v0.4.8', version: 4, ownReplay: false },
  {
    name: 'v8',
    rev: 'v0.4.15',
    version: 8,
    triggers: ['turn-feedback', 'summary-missing'],
    ownReplay: false,
  },
  { name: 'v9', rev: 'v0.4.31', version: 9, triggers: ['turn-feedback-tail'], ownReplay: true },
  { name: 'v10', rev: 'v0.5.0', version: 10, ownReplay: true },
  { name: 'v12', rev: 'v0.5.7', version: 12, triggers: ['workspace-root'], ownReplay: true },
  { name: 'v13', rev: 'v0.5.15', version: 13, ownReplay: true },
  {
    name: 'v14',
    rev: 'v0.5.19',
    version: 14,
    triggers: ['open-turn', 'approval-policy-missing'],
    ownReplay: true,
  },
  // 今天的工作樹寫的是格式 52 的世代檔，所以 v49 釘在最後寫它的那個 commit（沒出過貨）。
  {
    name: 'v49',
    rev: 'fe52c279c58fa6a07e4f934cd75826b2e518a301',
    version: 49,
    triggers: ['two-file-layout'],
    ownReplay: true,
    released: false,
  },
];
/** 混版的前半。 */
const MIXED_FIRST = { rev: '09398dd523471a1d03852e18c7bbae6ecc672414', version: 44 } as const;
const MIXED_NAME = 'mixed-v44-v49';

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();

/**
 * 「今天」的讀方是哪一份樹：啟動時算一次。夾具目錄本身不算進 dirty，產生器會改它；
 * 寫到一半才算的話，前面寫過的夾具會讓後面每一份都記成 dirty。
 */
const TODAY = {
  head: git('rev-parse', 'HEAD'),
  dirty:
    git('status', '--porcelain', '--', '.', ':(exclude)apps/harness/src/fixtures/session-format')
      .length > 0,
} as const;

/** 拿掉金鑰的環境，給 `pnpm install`。 */
function installEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.endsWith('_API_KEY')) delete env[key];
  delete env.NODE_OPTIONS;
  return env;
}

/** CLI 與 in-tree 腳本的環境：只給這幾格。 */
function runEnv(scratch: string): NodeJS.ProcessEnv {
  const home = join(scratch, 'home');
  mkdirSync(join(home, 'agent-home'), { recursive: true });
  return {
    PATH: process.env.PATH ?? '',
    LANG: 'C.UTF-8',
    HOME: home,
    NEXUS_AGENT_HOME: join(home, 'agent-home'),
  };
}

function log(line: string): void {
  console.log(line);
}

/** 跑一個指令，印出指令與輸出，回傳 stdout。 */
function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): string {
  log(`$ (cd ${options.cwd}) ${command} ${args.join(' ')}`);
  const out = execFileSync(command, args, {
    ...options,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (out.trim().length > 0) log(out.trimEnd().replace(/^/gm, '  | '));
  return out;
}

/** 在 rev 開一棵暫存 worktree、離線安裝，回傳路徑。 */
function checkout(scratch: string, rev: string): string {
  const tree = join(scratch, 'tree');
  run('git', ['-C', ROOT, 'worktree', 'add', '--detach', tree, rev], {
    cwd: ROOT,
    env: installEnv(),
  });
  const head = git('-C', tree, 'rev-parse', 'HEAD');
  const want = git('rev-parse', `${rev}^{commit}`);
  log(`rev-parse HEAD = ${head}；${rev}^{commit} = ${want}`);
  if (head !== want) throw new Error(`worktree 的 HEAD ${head} 對不上 ${rev}（${want}）。`);
  run('pnpm', ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'], {
    cwd: tree,
    env: installEnv(),
  });
  // 有 `build:lib` 的 rev，workspace 套件從 `lib/` 解析（#1385 之後）：先建出來，CLI 才 import 得到；vendor 的型別檔由它們的
  // `prepare` 產生，`--ignore-scripts` 跳過了，in-tree 腳本的型別檢查要它。
  const scripts = (
    JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    }
  ).scripts;
  if (scripts?.['build:lib'] !== undefined) {
    run('pnpm', ['run', 'build:lib'], { cwd: tree, env: installEnv() });
    run('pnpm', ['--filter', './vendor/**', 'run', '--if-present', 'prepare'], {
      cwd: tree,
      env: installEnv(),
    });
  }
  return tree;
}

function removeTree(tree: string): void {
  run('git', ['-C', ROOT, 'worktree', 'remove', '--force', tree], { cwd: ROOT, env: installEnv() });
}

/** 跑一棵樹的 CLI 一輪，回傳它寫出的 run 目錄。 */
function cli(tree: string, scratch: string, extra: readonly string[] = []): string {
  const harness = join(tree, 'apps/harness');
  const out = join(scratch, 'session-log');
  mkdirSync(out, { recursive: true });
  mkdirSync(FIXTURE_CWD, { recursive: true });
  const before = new Set(readdirSync(out));
  run(
    join(harness, 'node_modules/.bin/tsx'),
    [join(harness, 'src/cli.ts'), '--session-log', out, ...extra, PROMPT],
    {
      cwd: FIXTURE_CWD,
      env: runEnv(scratch),
    },
  );
  const created = readdirSync(out).filter((name) => !before.has(name));
  if (created.length !== 1)
    throw new Error(`CLI 應該開一個 run 目錄，實際 ${created.join('、') || '沒有'}。`);
  return join(out, created[0]!);
}

/** 把 in-tree 腳本複製進那棵樹、對那一版的型別編過、跑。 */
function inTree(tree: string, scratch: string, script: string, args: readonly string[]): string {
  const harness = join(tree, 'apps/harness');
  const target = join(harness, 'src', `__session-format-${script}`);
  copyFileSync(join(HERE, 'in-tree', script), target);
  try {
    run(join(harness, 'node_modules/.bin/tsc'), ['--noEmit', '-p', harness], {
      cwd: harness,
      env: runEnv(scratch),
    });
    return run(join(harness, 'node_modules/.bin/tsx'), [target, ...args], {
      cwd: FIXTURE_CWD,
      env: runEnv(scratch),
    });
  } finally {
    rmSync(target, { force: true });
  }
}

/** 今天的讀方的推法，`expected.json` 裡標 `today`。 */
function todayReplay(events: readonly SessionEvent[]): unknown {
  const replay = replayConversation(events);
  return replay.kind === 'replayed'
    ? { kind: 'replayed', roles: replay.messages.map((message) => message.getType()) }
    : { kind: 'unreplayable', reason: replay.reason };
}

/**
 * 還沒寫進夾具目錄的夾具：檔名 → 內容。全部 target 跑完才一次寫（{@link flush}），所以每一次 CLI 跑的時候夾具目錄都還沒
 * 被這一輪改過，CLI 自己記的 `build.dirty`（整個 repo 的 `git status`）在乾淨的樹上就是 `false`；中途有一份失敗，
 * 整批都不寫。
 */
const PENDING = new Map<string, Map<string, string>>();

/** 把 run 目錄的會話與 `expected.json` 讀進 {@link PENDING}。 */
function freeze(
  name: string,
  directory: string,
  writer: Record<string, unknown>,
  own: Record<string, unknown> | undefined,
  triggers: readonly unknown[],
): void {
  const files = new Map<string, string>();
  const sessions: Record<string, unknown> = {};
  for (const id of sessionsIn(directory)) {
    for (const file of frozenFilesOf(directory, id)) {
      files.set(file, readFileSync(join(directory, file), 'utf8'));
    }
    const header = readRawHeader<{ version: number }>(directory, id);
    const events = readEvents(directory, id);
    sessions[id] = {
      headerVersion: header.version,
      eventCount: events.length,
      types: events.map((event) => event.type),
      replay:
        own?.[id] !== undefined
          ? { computedBy: writer['rev'], ...(own[id] as object) }
          : { computedBy: 'today', ...(todayReplay(events) as object) },
    };
  }
  const expected = {
    writer,
    computedByToday: TODAY,
    sessions,
    triggers,
  };
  files.set('expected.json', `${JSON.stringify(expected, null, 2)}\n`);
  PENDING.set(name, files);
  log(`備好 ${name}`);
}

/** 把 {@link PENDING} 寫進夾具目錄。 */
function flush(): void {
  for (const [name, files] of PENDING) {
    const into = join(FIXTURES, name);
    rmSync(into, { recursive: true, force: true });
    mkdirSync(into, { recursive: true });
    for (const [file, content] of files) {
      // 世代檔在會話目錄裡（`<id>/session.v<N>.jsonl`）。
      mkdirSync(dirname(join(into, file)), { recursive: true });
      writeFileSync(join(into, file), content);
    }
    log(`寫好 ${into}`);
  }
}

/** 歷史畫面上每一顆收尾 frame 的 `event`（`completed`／`failed`）。 */
function lifecycles(events: readonly SessionEvent[]): unknown[] {
  return historyFrames(events, 50_000).flatMap((frame) => {
    const params = (frame as { method?: string; params?: { data?: { event?: unknown } } }).params;
    return (frame as { method?: string }).method === 'lifecycle' ? [params?.data?.event] : [];
  });
}

/** 觸發寫完之後，今天的讀方對它的輸出。 */
function triggerExpectations(triggers: readonly Trigger[], directory: string): unknown[] {
  return triggers.flatMap((trigger): unknown[] => {
    switch (trigger) {
      case 'turn-feedback':
      case 'turn-feedback-tail':
        return [
          {
            edge: 10,
            session: 'cli',
            computedBy: 'today',
            feedback: currentMessageFeedback(readEvents(directory, 'cli')).map((entry) => ({
              turn: entry.turn,
              ...('messageId' in entry.item
                ? { target: 'message', messageId: entry.item.messageId }
                : { target: 'turn' }),
              rating: entry.item.rating,
            })),
          },
        ];
      case 'summary-missing':
        return [
          {
            edge: 9,
            session: 'compacted',
            computedBy: 'today',
            replay: todayReplay(readEvents(directory, 'compacted')),
          },
        ];
      case 'open-turn':
        return ['crashed', 'crashed-resumed'].map((session) => {
          const events = readEvents(directory, session);
          const closers = interruptedTurnClosers(events);
          return {
            edge: 33,
            session,
            computedBy: 'today',
            closers: closers.map((event) =>
              event.type === 'turn/end'
                ? { type: event.type, reason: event.data.reason?.kind }
                : { type: event.type },
            ),
            lifecyclesAfterResume: lifecycles([...events, ...closers]),
          };
        });
      case 'workspace-root': {
        const header = readRawHeader<StoredSessionHeader>(directory, 'cli');
        let resumeWithWorkspace = 'allowed';
        try {
          assertSameWorkspaceRoot('fixture', 'cli', header, '/elsewhere');
        } catch (error: unknown) {
          resumeWithWorkspace = (error as Error).name;
        }
        return [
          {
            edge: 13,
            session: 'cli',
            computedBy: 'today',
            workspaceRootRecorded: header.workspaceRoot !== undefined,
            resumeWithWorkspace,
          },
        ];
      }
      case 'two-file-layout':
        return [
          {
            edge: 52,
            session: 'cli',
            computedBy: 'today',
            replay: todayReplay(readEvents(directory, 'cli')),
          },
        ];
      case 'approval-policy-missing': {
        const events = readEvents(directory, 'cli');
        return [
          {
            edge: 34,
            session: 'cli',
            computedBy: 'today',
            approvalPolicyRecorded: recordedApprovalPolicy(events) !== undefined,
            approvalPolicyOnResume: approvalPolicyOnResume(events),
          },
        ];
      }
    }
  });
}

function headerVersion(directory: string, id: string): number {
  return readRawHeader<{ version: number }>(directory, id).version;
}

function generate(target: Target): void {
  log(`\n== ${target.name}（${target.rev ?? '今天的工作樹'}）`);
  const scratch = mkdtempSync(join(realpathSync('/var/tmp'), 'nexus-session-format-'));
  let tree: string | undefined;
  try {
    tree = target.rev === undefined ? ROOT : checkout(scratch, target.rev);
    const directory = cli(tree, scratch);
    if (headerVersion(directory, 'cli') !== target.version) {
      throw new Error(`${target.name} 寫出來的版本是 ${String(headerVersion(directory, 'cli'))}。`);
    }
    for (const trigger of target.triggers ?? []) {
      const script = `trigger-${trigger}.ts`;
      if (existsSync(join(HERE, 'in-tree', script))) inTree(tree, scratch, script, [directory]);
    }
    const own =
      target.ownReplay && target.rev !== undefined
        ? (JSON.parse(
            inTree(tree, scratch, 'expect-own.ts', [directory, ...sessionsIn(directory)]),
          ) as Record<string, unknown>)
        : undefined;
    const writer = {
      rev: target.rev ?? 'today',
      commit:
        target.rev === undefined
          ? git('rev-parse', 'HEAD')
          : git('rev-parse', `${target.rev}^{commit}`),
      formatVersion: target.version,
      released: target.released ?? target.rev !== undefined,
    };
    freeze(
      target.name,
      directory,
      writer,
      own,
      triggerExpectations(target.triggers ?? [], directory),
    );
  } finally {
    if (tree !== undefined && tree !== ROOT) removeTree(tree);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function generateMixed(): void {
  log(`\n== ${MIXED_NAME}（${MIXED_FIRST.rev} 寫前半，今天的工作樹續寫後半）`);
  const scratch = mkdtempSync(join(realpathSync('/var/tmp'), 'nexus-session-format-'));
  let tree: string | undefined;
  try {
    tree = checkout(scratch, MIXED_FIRST.rev);
    const directory = cli(tree, scratch, ['--patch', join(HERE, 'summarize-early.v44.patch.yml')]);
    if (headerVersion(directory, 'cli') !== MIXED_FIRST.version) {
      throw new Error(`前半寫出來的版本是 ${String(headerVersion(directory, 'cli'))}。`);
    }
    // 續寫之前，前半用它自己的推法推一次：續寫會把同一個檔接長，之後就只剩今天的讀方讀得懂。
    const firstHalf = (
      JSON.parse(inTree(tree, scratch, 'expect-own.ts', [directory, 'cli'])) as Record<
        string,
        object
      >
    )['cli'];
    const firstHalfCount = readEvents(directory, 'cli').length;
    removeTree(tree);
    tree = undefined;
    const harness = join(ROOT, 'apps/harness');
    run(
      join(harness, 'node_modules/.bin/tsx'),
      [
        join(harness, 'src/cli.ts'),
        '--resume',
        directory,
        '--patch',
        join(HERE, 'summarize-early.today.patch.yml'),
        PROMPT,
      ],
      { cwd: FIXTURE_CWD, env: runEnv(scratch) },
    );
    const writer = {
      rev: `${MIXED_FIRST.rev} → today`,
      commit: `${MIXED_FIRST.rev} → ${git('rev-parse', 'HEAD')}`,
      formatVersion: MIXED_FIRST.version,
      released: false,
    };
    const events = readEvents(directory, 'cli');
    const summaries = events.filter((event) => event.type === 'compaction/summary');
    log(
      `摘要事件：${summaries.map((event) => (event.data.beforeCall === true ? '新順序' : '舊順序')).join('、')}`,
    );
    freeze(MIXED_NAME, directory, writer, undefined, [
      {
        edge: 45,
        session: 'cli',
        computedBy: 'today',
        summaries: summaries.map((event) => ({ beforeCall: event.data.beforeCall === true })),
        firstHalf: {
          eventCount: firstHalfCount,
          replay: { computedBy: MIXED_FIRST.rev, ...firstHalf },
        },
      },
    ]);
  } finally {
    if (tree !== undefined) removeTree(tree);
    rmSync(scratch, { recursive: true, force: true });
  }
}

const wanted = new Set(process.argv.slice(2));
for (const target of TARGETS) if (wanted.size === 0 || wanted.has(target.name)) generate(target);
if (wanted.size === 0 || wanted.has(MIXED_NAME)) generateMixed();
flush();
