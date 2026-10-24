/**
 * **錄製／重放快照**（[#1556](https://github.com/DemianLi/nexus-agent/issues/1556) C077）：一個場景用真模型錄一次，之後在真的 `runServe` 上把錄到的回覆
 * 照位置吐回去，落盤日誌正規化之後要跟錄的那份逐筆相同。照 dsh `packages/test-support/session-snapshot`（`687f282e`）：
 *
 * - **夾具同時是輸入與預期**：腳本從夾具的 `assistant/message` 推（`llm-replay.ts`），比對的也是同一份夾具（dsh `suite.ts`）。
 * - **場景的輸入另放**：`input.json` 是依序的步驟與先進先出的核准答案（dsh `harness.ts:81-126` 的 `steps`／`permissionAnswers`）。
 * - **正規化在比對時做**（dsh `normalize.ts:483-502`、`identity.ts:48-135`）：時間歸零，隨機的識別碼依首次出現換成記號，
 *   主機路徑換成 `/{{cwd}}`／`{{src}}`。錄的時候只換路徑（夾具進版控，不放主機路徑），時間與識別碼照錄。
 *
 * 錄製見 `record.ts`，重放見 `snapshot.test.ts`。**web 那條（[#1602](https://github.com/DemianLi/nexus-agent/issues/1602)）的入口是
 * {@link startReplayServe}**：給一份夾具目錄，起一台吐那份回覆的 serve。
 *
 * ## 沒有照抄 dsh 的
 *
 * - **一個場景一份夾具，不分 `session.vN`**：舊格式的讀法由會話格式夾具（`fixtures/session-format/`，#1529）守，版本邊目錄
 *   全是加性的，比對時拿掉 header 的版本即可。
 * - **不釘請求標頭、不做 refresh 的值穩定化**（dsh `HL:900-952`、`suite.ts:1131-1183`）：重放只照位置吐、不比對請求
 *   （dsh 也是），標頭釘死要的是 sidecar 那一套，目前用不到。
 * - **子代理的日誌不比**：重放一條 thread 只綁 root 的腳本（見 `llm-replay.ts`）。
 *
 * @module
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LoggedMessage, SessionEvent, StoredSessionHeader } from '@nexus/core';
import { uniformDecisions } from '@nexus/wire';
import type { ConversationState, WireClient } from '@nexus/wire';

import { TIME_CONTEXT_OFF_PATCH_ROWS, approvalAt, foldTurn } from '../fixtures.js';
import {
  parseJsonlSessionBody,
  projectKey,
  readSessionEntry,
  sessionPathsIn,
} from '../jsonl-session-store.js';
import { replayScriptFromEvents } from '../llm-replay.js';
import { runServe } from '../serve.js';
import type { RunningServe } from '../serve.js';

/** 每個場景都在這條 thread 上跑；夾具的檔名基底也是它。 */
export const SNAPSHOT_THREAD_ID = 'snapshot';

/** 場景都放在這裡，一個場景一個目錄。 */
export const SCENARIOS_DIR = fileURLToPath(new URL('./scenarios/', import.meta.url));

/** `apps/harness/src`：patch 裡 `insert` 的夾具外掛用絕對路徑指，落盤的外掛名就帶著它。 */
export const HARNESS_SRC_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 一步。今天只有說一句話；核准在 {@link ScenarioInput.approvals}。 */
export interface ScenarioStep {
  readonly op: 'prompt';
  readonly text: string;
}

/** `input.json`。 */
export interface ScenarioInput {
  readonly steps: readonly ScenarioStep[];
  /** 停在核准點時依序拿一個答（先進先出，同 dsh `permissionAnswers`）。拿完了還停就拋。 */
  readonly approvals?: readonly ('approve' | 'reject')[];
}

/** `recorded.json`：錄製腳本寫的，記下錄的條件，重放要用。 */
export interface RecordedMeta {
  /** 錄的時候 `live-model` 那一列的型號：系統提示詞的 `{{model}}` 是它（見 {@link replayPatchText}）。 */
  readonly modelId: string;
  /** 錄的時刻（UTC，ISO）。 */
  readonly recordedAt: string;
  /** 這個場景轉出去的請求數（計數代理在出口數的）。 */
  readonly forwardedPosts: number;
}

/** 一個場景目錄讀出來的東西。 */
export interface Scenario {
  readonly name: string;
  readonly dir: string;
  readonly input: ScenarioInput;
  /** 錄製與重放都疊上的 patch 列（場景目錄的 `patch.yml`，沒有就是空的）。`{{src}}` 換成 {@link HARNESS_SRC_DIR}。 */
  readonly patchRows: string;
}

/** 一份會話：header 與日誌本文的事件。 */
export interface SnapshotLog {
  readonly header: StoredSessionHeader;
  readonly events: readonly SessionEvent[];
}

/**
 * 讀一個場景目錄。
 *
 * @param name - 目錄名（在 {@link SCENARIOS_DIR} 底下）。
 */
export async function loadScenario(name: string): Promise<Scenario> {
  const dir = join(SCENARIOS_DIR, name);
  const input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8')) as ScenarioInput;
  let patchRows = '';
  try {
    patchRows = await readFile(join(dir, 'patch.yml'), 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { name, dir, input, patchRows: patchRows.replaceAll('{{src}}', HARNESS_SRC_DIR) };
}

/** 有哪些場景（目錄名，排序過）。 */
export async function listScenarios(): Promise<string[]> {
  const entries = await readdir(SCENARIOS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * 錄製與重放共用的 patch 列：關掉帶牆鐘的時間讀數，關掉標題模型（同 dsh：錄與重放兩份 patch 都關
 * `session-title-llm`，`text-turn/cordis.yml:33-34`、`cordis.snapshot.yml:11-12`——那次呼叫不落 `assistant/message`，
 * 會讓腳本錯位）。
 */
export const SNAPSHOT_COMMON_ROWS = `${TIME_CONTEXT_OFF_PATCH_ROWS}- id: thread-title-llm
  disabled: true
`;

/**
 * 重放用的 patch：`insert` 重放提供者、把選擇列指過去，系統提示詞的型號寫死成錄的那一個。
 *
 * **型號要寫死**：`{{model}}` 帶 `--live` 時是 `live-model` 的型號、沒帶是 `scripted`（`assembly-root.ts` 的
 * `systemPromptVariables`）。不寫死的話重放的提示詞跟錄的差一個字，`request/system` 與 `context/measure` 的量都對不上。
 * 這一列的 patch 整份取代 config，三格照出貨值寫出來（`cordis.yml` 的 `system-prompt`）。
 *
 * @param script - 腳本（夾具的 `assistant/message`）。
 * @param modelId - 錄的型號。
 * @param scenarioRows - 場景自己的列。
 */
export function replayPatchText(
  script: readonly LoggedMessage[],
  modelId: string,
  scenarioRows: string,
): string {
  return `- insert:
    - id: replay
      name: '#settings/replay-model'
      config: ${JSON.stringify({ script })}
- id: agent-default-model
  config:
    provider: replay
- id: system-prompt
  config:
    includeHarnessIdentity: true
    personaPrefix: ${JSON.stringify(`You are a helpful assistant powered by the ${modelId} model.`)}
    personaSuffix: 'Your working directory is {{cwd}}.'
${SNAPSHOT_COMMON_ROWS}${scenarioRows}`;
}

/**
 * 讀一份會話（夾具或剛跑完的），走正式讀方，日誌本文用 `strict`：夾具壞了要大聲講。
 *
 * @param directory - 會話所在目錄。
 * @param threadId - 會話 id。
 */
export async function readSnapshotLog(directory: string, threadId: string): Promise<SnapshotLog> {
  const filename = sessionPathsIn(directory, threadId).header.slice(directory.length + 1);
  const entry = await readSessionEntry(directory, filename, { id: threadId });
  if (entry === undefined) throw new Error(`${directory} 裡沒有會話 ${threadId}`);
  const { events } = parseJsonlSessionBody(threadId, await entry.readBody(), {
    recovery: 'strict',
    version: entry.storedFormatVersion,
  });
  return { header: entry.header, events };
}

/** 一台吐夾具回覆的 serve。 */
export interface ReplayServe {
  readonly running: RunningServe;
  /** 會話落盤的目錄（已經算進專案鍵）。 */
  readonly sessionDir: string;
  /** 只收 server（日誌寫完、檔還在，讀完再 {@link ReplayServe.close}）。叫幾次都只收一次。 */
  stop(): Promise<void>;
  /** 收掉 server 與暫存目錄。 */
  close(): Promise<void>;
}

/**
 * **起一台重放的 serve**（#1602 的入口）：真的 `runServe`，模型換成照夾具吐回覆的重放提供者，不帶 `--live`、不讀金鑰。
 * home 是一個暫存目錄，不讀跑測試那台機器的使用者設定。
 *
 * @param scenario - 場景（{@link loadScenario}）；夾具是目錄裡那份會話。
 * @param options - `argv` 接在後面的其餘旗標；`log` 收起動日誌（省略即丟掉）。
 */
export async function startReplayServe(
  scenario: Scenario,
  options: { readonly argv?: readonly string[]; readonly log?: (line: string) => void } = {},
): Promise<ReplayServe> {
  const fixture = await readSnapshotLog(scenario.dir, SNAPSHOT_THREAD_ID);
  const meta = JSON.parse(
    await readFile(join(scenario.dir, 'recorded.json'), 'utf8'),
  ) as RecordedMeta;
  const temp = await mkdtemp(join(tmpdir(), 'nexus-snapshot-'));
  const patch = join(temp, 'replay.patch.yml');
  await writeFile(
    patch,
    replayPatchText(replayScriptFromEvents(fixture.events), meta.modelId, scenario.patchRows),
    'utf8',
  );
  const sessionRoot = join(temp, 'sessions');
  let running: RunningServe;
  try {
    running = (await runServe({
      argv: [
        '--port',
        '0',
        '--patch',
        patch,
        '--session-log',
        sessionRoot,
        ...(options.argv ?? []),
      ],
      log: options.log ?? (() => undefined),
      env: { NEXUS_AGENT_HOME: join(temp, 'home') },
    })) as RunningServe;
  } catch (error: unknown) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopped ??= running.close());
  return {
    running,
    sessionDir: join(sessionRoot, projectKey(process.cwd())),
    stop,
    close: async () => {
      try {
        await stop();
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
  };
}

/**
 * 照 `input.json` 開跑：每一句話送出去、折到收尾；停在核准點就拿下一個答案回覆，再折到收尾。
 *
 * @param client - 那台 serve 的 wire client。
 * @param input - 場景輸入。
 * @returns 最後的對話狀態。
 * @throws 停在核准點但答案用完了。
 */
export async function driveScenario(
  client: WireClient,
  input: ScenarioInput,
): Promise<ConversationState> {
  const answers = [...(input.approvals ?? [])];
  const events = await client.openEvents(SNAPSHOT_THREAD_ID);
  try {
    let state: ConversationState | undefined;
    for (const step of input.steps) {
      await client.runStart(SNAPSHOT_THREAD_ID, step.text);
      state = await foldTurn(events, state);
      while (state.pendings.length > 0) {
        const answer = answers.shift();
        if (answer === undefined)
          throw new Error('停在核准點，但 input.json 的 approvals 已經用完了');
        const pending = approvalAt(state.pendings);
        await client.inputRespond(SNAPSHOT_THREAD_ID, {
          namespace: [...pending.namespace],
          interrupt_id: pending.interruptId,
          response: uniformDecisions(pending, answer),
        });
        state = await foldTurn(events, state);
      }
    }
    if (state === undefined) throw new Error('input.json 沒有步驟');
    return state;
  } finally {
    await events.return?.(undefined);
  }
}

/**
 * 工作目錄的記號。**要是絕對路徑的形狀**：夾具走正式讀方，header 的 `cwd` 不是絕對路徑就當壞檔拒絕。
 */
export const CWD_TOKEN = '/{{cwd}}';

/** 主機路徑換成記號：錄的時候寫夾具前做一次，比對前兩邊各做一次（夾具那份已經換過，再換一次不變）。 */
export function replaceHostPaths(text: string, cwd: string): string {
  return text.replaceAll(HARNESS_SRC_DIR, '{{src}}').replaceAll(cwd, CWD_TOKEN);
}

/**
 * 隨機產生的識別碼：依首次出現換成 `{{id:N}}`（dsh `identity.ts` 的作法）。只換這幾格——訊息 id 與工具呼叫 id 來自腳本，
 * 重放會原樣重現，換掉就看不到它們走歪。
 */
function identityTokens(): (value: string) => string {
  const seen = new Map<string, string>();
  return (value) => {
    let token = seen.get(value);
    if (token === undefined) {
      token = `{{id:${String(seen.size)}}}`;
      seen.set(value, token);
    }
    return token;
  };
}

/** 拿掉重放提供者那一列：只在重放那份 header 上。 */
const REPLAY_ROW_NAME = '#settings/replay-model';

/**
 * 正規化一份會話，比對用。
 *
 * - header：拿掉版本（版本邊全是加性，見模組說明）、建立時刻、建置資訊、設定雜湊（home 底下的金鑰簽的，每個 home 不同）；
 *   外掛清單拿掉重放提供者那一列。
 * - 事件：時間歸零；送出佇列的 id、中斷 id 換成記號；路徑換成記號；只有真模型才有的路由與請求標頭拿掉。
 */
export function normalizeSnapshotLog(log: SnapshotLog): { header: unknown; events: unknown[] } {
  const cwd = log.header.cwd ?? '';
  const {
    version: _version,
    createdAt: _createdAt,
    build: _build,
    configHash: _configHash,
    ...header
  } = log.header as StoredSessionHeader & Record<string, unknown>;
  const plugins = (header['plugins'] as { name: string }[] | undefined)?.filter(
    (row) => row.name !== REPLAY_ROW_NAME,
  );
  const token = identityTokens();
  const events = log.events.map((event) => {
    const data = structuredClone(event.data) as Record<string, unknown>;
    switch (event.type) {
      case 'inbox/spliced':
        for (const item of (data['inserted'] as { id: string }[] | undefined) ?? [])
          item.id = token(item.id);
        break;
      case 'interrupt/raised':
        data['interruptId'] = token(data['interruptId'] as string);
        break;
      case 'approval/asked':
      case 'approval/decided':
        data['id'] = token(data['id'] as string);
        break;
      // 只有真模型那條才有的兩格（`live-model.ts` 的路由與請求參數、工具清單），重放的模型給不出來。照 dsh 換成記號
      // （`normalize.ts` 的 `{{tools}}`／`{{system}}`），請求本身不比——重放只照位置吐，同 dsh。
      case 'model/start':
        delete data['route'];
        break;
      case 'request/header':
        data['header'] = '{{header}}';
        break;
      default:
        break;
    }
    return { ...event, time: 0, data };
  });
  return JSON.parse(
    replaceHostPaths(
      JSON.stringify({ header: { ...header, ...(plugins && { plugins }) }, events }),
      cwd,
    ),
  ) as { header: unknown; events: unknown[] };
}

/**
 * 位置對齊的前提：每一次模型呼叫都落成一則 `assistant/message`。不成立的話（摘要器、走旁路的呼叫）腳本從那一格起全部錯一位，
 * 所以錄的時候與重放之前都核一次。
 *
 * @returns 對不上時的說明；對得上是 `undefined`。
 */
export function scriptAlignmentProblem(events: readonly SessionEvent[]): string | undefined {
  const calls = events.filter((event) => event.type === 'model/start').length;
  const replies = events.filter((event) => event.type === 'assistant/message').length;
  return calls === replies
    ? undefined
    : `模型呼叫 ${String(calls)} 次（model/start），回覆卻落了 ${String(replies)} 則（assistant/message）：照位置重放會錯位`;
}
