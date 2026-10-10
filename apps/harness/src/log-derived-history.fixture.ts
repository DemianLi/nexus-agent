/**
 * 「從日誌推回的歷史」對「端點實際收到的請求」的比對夾具（#1299，承 #1159 的探針）。
 *
 * S2 要把請求的訊息串變成日誌的導出物。這份夾具回答一個問題：**今天，拿一份會話日誌的某個位置以前的事件
 * 重放出歷史、再經同一個 `ChatOpenAI` 送出去，得到的 wire `messages` 跟產品當時真的送給模型的那份，逐位元組
 * 一樣嗎？** 不一樣的地方就是 S2 以前要補的缺口（地圖 #1298 的 #1300–#1303）。
 *
 * ## 量法
 *
 * 1. 假 OpenAI 端點照腳本回，並記下每一份請求 body。
 * 2. 走產品路徑（`runCli --live`、`runServe --live`、或組裝點）跑完腳本，日誌從落盤的 `.jsonl` 讀回。
 * 3. 對每一次**主模型呼叫**（body 帶 `tools` 的那些；標題、摘要呼叫不帶）：取日誌裡該 `model/start` 以前的事件，
 *    `replayConversation(prefix, { toolResultAsSeen })` 重放，系統提示詞取日誌上的 `request/system`，
 *    送進另一個假端點（sink）拿它的 body，跟當時那份比 `messages`。
 *
 * ## 判定
 *
 * 逐呼叫一筆 {@link Verdict}：
 *
 * - `kinds`：差在哪一類（{@link DifferenceKind}），用**內容**判，不只看序號——同一個序號換了一種差異要看得出來。
 * - `systemMatches`：線上系統訊息的文字（區塊串起來）是否等於日誌 `request/system`。探針當年沒比這一格。
 *
 * ## 兩個具名的正規化（不是默默抹掉）
 *
 * 地圖 [#1298](https://github.com/DemianLi/nexus-agent/issues/1298) 的 Fog 裡「助手訊息的 `name` 欄位與系統訊息的
 * 區塊邊界」尚未決定，所以這裡把它們正規化而不是當差異：
 *
 * - {@link stripModelName}：非串流路徑（CLI）助手訊息帶 `name: "model"`，串流路徑（web）不帶。
 * - 系統訊息只比「區塊文字串起來」（{@link systemText}），不比區塊邊界。
 *
 * Fog 決定後這兩個正規化要跟著改，不要留著。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { SessionRegistry, replayConversation } from '@nexus/core';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { emptyConversation } from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';

import { createNexusAgent } from './agent-factory.js';
import type { CreateNexusAgentOptions } from './agent-factory.js';
import { runCli, runRepl } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toolResultAsSeen } from './conversation-restore.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { projectKey } from './jsonl-session-store.js';
import { DEFAULT_LIVE_MODEL_ID } from './live-model.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

export interface WireMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

/** 假端點收到的請求 body。 */
export interface Body {
  messages: WireMessage[];
  tools?: unknown[];
  [key: string]: unknown;
}

/** 腳本給的一則回覆。沒給 `content` 也沒給 `tools` 就回「好。」。 */
export interface Reply {
  content?: string;
  tools?: { id: string; name: string; args: unknown }[];
  finish?: string;
}

/** 腳本：第幾次請求（含標題、摘要這類不帶工具的）與它的 body → 回什麼。 */
export type Script = (index: number, body: Body) => Reply;

export const hasTools = (body: Body): boolean => (body.tools?.length ?? 0) > 0;

/**
 * 只對「主呼叫」（帶工具的）編號的腳本；標題、摘要這類不帶工具的呼叫一律回固定字串，不佔號。
 */
export const mainOnly = (script: (k: number) => Reply): Script => {
  let k = 0;
  return (_index, body) => (hasTools(body) ? script(k++) : { content: '【輔助呼叫】' });
};

export interface FakeEndpoint {
  readonly baseURL: string;
  readonly bodies: Body[];
  close(): Promise<void>;
}

/**
 * 假 OpenAI 端點。`stream` 為真時走 SSE（出貨的 `--live` 與 serve 走的就是串流），否則回一整包 JSON。
 * 每次回應的 id 都不同（同 id 會被上層當成重複）。
 */
export async function fakeEndpoint(script: Script, stream: boolean): Promise<FakeEndpoint> {
  const bodies: Body[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body;
      const index = bodies.length;
      bodies.push(body);
      const reply = script(index, body);
      const id = `chatcmpl-${index}-${Math.random().toString(36).slice(2)}`;
      const finish = reply.finish ?? (reply.tools === undefined ? 'stop' : 'tool_calls');
      const text = reply.content ?? (reply.tools === undefined ? '好。' : '');
      const calls = (reply.tools ?? []).map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model: 'fake',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: text === '' ? null : text,
                  ...(calls.length > 0 && { tool_calls: calls }),
                },
                finish_reason: finish,
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const frame = (payload: Record<string, unknown>) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: DEFAULT_LIVE_MODEL_ID, ...payload })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        frame({ choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, 1) } }] }),
      );
      if (text.length > 1) {
        res.write(frame({ choices: [{ index: 0, delta: { content: text.slice(1) } }] }));
      }
      for (const [i, call] of calls.entries()) {
        res.write(
          frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, ...call }] } }] }),
        );
      }
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }));
      res.write(
        frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const model = (baseURL: string) =>
  new ChatOpenAI({
    model: 'fake',
    apiKey: 'sk-loopback',
    maxRetries: 0,
    temperature: 0.3,
    configuration: { baseURL },
  });

/** 把一串訊息經 `ChatOpenAI` 送一次（打 sink），回它的 wire `messages`。 */
async function wireOf(messages: BaseMessage[]): Promise<WireMessage[]> {
  const sink = await fakeEndpoint(() => ({}), false);
  try {
    await model(sink.baseURL).invoke(messages);
    return sink.bodies[0]!.messages;
  } finally {
    await sink.close();
  }
}

/**
 * 把摘要與剪刀、截斷的門檻壓低，讓幾輪對話就觸發。壓力走 token（6000）：10,000 字的中文工具結果一輪就達標。
 */
export const LOW_SUMMARIZATION = [
  '- id: summarization',
  '  config:',
  '    trigger:',
  '      - { type: tokens, value: 6000 }',
  '    keep: { type: messages, value: 2 }',
  '    truncateArgs:',
  '      trigger: { type: messages, value: 4 }',
  '      keep: { type: messages, value: 2 }',
  '    historyPathPrefix: /conversation_history',
].join('\n');

// ---------------------------------------------------------------------------
// 比對
// ---------------------------------------------------------------------------

/** 工具結果被剪刀剪過，留在線上的標記：`packages/nexus-core/src/tool-result-pruner.ts` 的 `TOOL_RESULT_PRUNE_MARKER`（那顆帶換行，線上 JSON 裡是跳脫過的，所以這裡只認中間那句）。 */
export const PRUNE_MARKER = '工具結果中段已剪除';
/** 舊工具呼叫的參數被截斷，留在線上的標記：deepagents 摘要 middleware `truncateArgs` 的預設 `truncationText`（`...(argument truncated)`，deepagents@1.13.1 `dist/langsmith-*.js`），我們沒有自己的產生者。 */
export const TRUNCATE_MARKER = 'argument truncated';

/**
 * 差異的種類。每一類對應一張卡（見測試檔的 `CARD_OF`）；`other` 不對應任何卡，出現就是新問題。
 */
export type DifferenceKind = 'prune' | 'truncate' | 'empty-assistant' | 'other';

export interface Verdict {
  /** 第幾次主呼叫（從 0 起）。 */
  readonly call: number;
  /** 排序後去重的差異種類；空陣列＝逐位元組相同。 */
  readonly kinds: readonly DifferenceKind[];
  /** 線上系統訊息的文字（區塊串起來）等於日誌 `request/system`。 */
  readonly systemMatches: boolean;
  /** 只在 `other` 或排不進種類時有：第一個不同的位置與兩邊的樣子，給斷言訊息用。 */
  readonly detail?: string;
}

/** 線上系統訊息的文字：字串就是它；區塊陣列把各區塊文字直接串起來。 */
export function systemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as { text?: string }[]).map((block) => block.text ?? '').join('');
  }
  return JSON.stringify(content);
}

/** 非串流路徑的助手訊息帶 `name: "model"`（見檔頭的 Fog 說明）；比對前拿掉。 */
export function stripModelName(message: WireMessage): WireMessage {
  if (message.role !== 'assistant' || message.name !== 'model') return message;
  const { name: _name, ...rest } = message;
  return rest as WireMessage;
}

const isEmptyContent = (content: unknown): boolean =>
  content === null ||
  content === undefined ||
  content === '' ||
  (Array.isArray(content) && content.length === 0);

/** 沒有內容也沒有工具呼叫的助手訊息（空內容可能是 `null`、空字串或空陣列，視 adapter 而定）。 */
const isEmptyAssistant = (message: WireMessage | undefined): boolean =>
  message?.role === 'assistant' &&
  isEmptyContent(message.content) &&
  (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0);

/** 兩段字串從第一個不同的字元前後各截一小段（工具結果動輒上萬字，從頭截看不到差在哪）。 */
const around = (a: string, b: string): [string, string] => {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  const cut = (text: string) =>
    `${k > 40 ? '…' : ''}${text.slice(Math.max(0, k - 40), k + 80)}${text.length > k + 80 ? '…' : ''}`;
  return [cut(a), cut(b)];
};

/**
 * 兩份 wire `messages`（都已去掉系統訊息）的差異分類。
 *
 * 空的助手訊息先從推導那邊剔掉再比（它一多，後面每一格都錯一位，逐格比看不出真正差在哪）；
 * 剩下逐格比，按**線上那一格**的內容判是剪刀還是截斷。
 */
export function classify(
  actual: readonly WireMessage[],
  derived: readonly WireMessage[],
): { kinds: DifferenceKind[]; detail?: string } {
  const kinds = new Set<DifferenceKind>();
  let rest = derived;
  if (derived.some(isEmptyAssistant) && !actual.some(isEmptyAssistant)) {
    kinds.add('empty-assistant');
    rest = derived.filter((message) => !isEmptyAssistant(message));
  }
  let detail: string | undefined;
  const length = Math.max(actual.length, rest.length);
  for (let i = 0; i < length; i++) {
    if (JSON.stringify(actual[i]) === JSON.stringify(rest[i])) continue;
    const onWire = JSON.stringify(actual[i] ?? null);
    const kind: DifferenceKind =
      onWire.includes(PRUNE_MARKER) && actual[i]?.role === 'tool'
        ? 'prune'
        : onWire.includes(TRUNCATE_MARKER) && actual[i]?.role === 'assistant'
          ? 'truncate'
          : 'other';
    kinds.add(kind);
    if (detail === undefined) {
      const [onWireText, derivedText] = around(onWire, JSON.stringify(rest[i] ?? null));
      detail = `第 ${String(i)} 則（線上 ${String(actual.length)} 則／推導 ${String(rest.length)} 則）\n  線上：${onWireText}\n  推導：${derivedText}`;
    }
  }
  return { kinds: [...kinds].sort(), ...(detail !== undefined && { detail }) };
}

/**
 * 對每次主呼叫比一次。`events` 是整份日誌，`mainBodies` 是假端點收到的、帶工具的 body，照順序。
 *
 * 主呼叫的數量必須等於日誌裡 root 的 `model/start` 數——對不上就是量具壞了（少一邊的話逐個配對會默默漏比），
 * 當場拋。
 */
export async function compareToLog(
  events: readonly SessionEvent[],
  mainBodies: readonly Body[],
): Promise<Verdict[]> {
  const starts = events.filter((event) => event.type === 'model/start');
  if (starts.length !== mainBodies.length) {
    throw new Error(
      `日誌有 ${String(starts.length)} 次 model/start，假端點收到 ${String(mainBodies.length)} 次主呼叫——對不上，比對不成立。`,
    );
  }
  const out: Verdict[] = [];
  for (const [index, start] of starts.entries()) {
    const body = mainBodies[index]!;
    const prefix = events.filter((event) => event.seq < start.seq);
    const replay = replayConversation(prefix, { toolResultAsSeen });
    if (replay.kind !== 'replayed') {
      out.push({
        call: index,
        kinds: ['other'],
        systemMatches: false,
        detail: `無法重放：${replay.reason}@${String(replay.seq)}`,
      });
      continue;
    }
    const system = events
      .filter(
        (event) =>
          event.type === 'request/system' &&
          (event.data as { modelCall?: number }).modelCall !== undefined &&
          (event.data as { modelCall: number }).modelCall <= start.seq,
      )
      .at(-1);
    const logged = system === undefined ? undefined : (system.data as { system: string }).system;

    const derivedWire = await wireOf([
      ...(logged === undefined ? [] : [new SystemMessage(logged)]),
      ...replay.messages,
    ]);
    const actualAll = body.messages.map(stripModelName);
    const systemMatches =
      logged !== undefined &&
      systemText(actualAll[0]?.content) === systemText(derivedWire[0]?.content)
        ? systemText(actualAll[0]?.content) === logged
        : false;
    const { kinds, detail } = classify(actualAll.slice(1), derivedWire.slice(1));
    out.push({
      call: index,
      kinds,
      systemMatches,
      ...(detail !== undefined && { detail }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 跑法
// ---------------------------------------------------------------------------

export interface Run {
  readonly events: SessionEvent[];
  readonly bodies: Body[];
  readonly mainBodies: Body[];
}

const finish = (events: SessionEvent[], bodies: Body[]): Run => ({
  events,
  bodies,
  mainBodies: bodies.filter(hasTools),
});

function readJsonl(file: string): SessionEvent[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

function liveModelPatch(baseUrl: string, extra: string): string {
  return [
    '- id: live-model',
    '  config:',
    `    baseUrl: '${baseUrl}'`,
    `    modelId: '${DEFAULT_LIVE_MODEL_ID}'`,
    '    maxRetries: 0',
    '    models:',
    `      - id: '${DEFAULT_LIVE_MODEL_ID}'`,
    '        contextWindow: 700045',
    '        maxTokens: 16384',
    extra,
    '',
  ].join('\n');
}

/**
 * 組裝點路徑：`createNexusAgent` + `runRepl`，非串流，日誌從記憶體裡的 `SessionRegistry` 取。
 * 呼叫端要自己用 `vi.stubEnv` 之類保證不碰真環境；這條路徑不讀金鑰。
 */
export async function runAssembly(
  lines: string,
  script: Script,
  plugins: readonly PluginEntry[],
  summarization?: CreateNexusAgentOptions['summarization'],
): Promise<Run> {
  const upstream = await fakeEndpoint(script, false);
  const root = await mkdtemp(join(tmpdir(), 'nexus-lh-'));
  await writeFile(join(root, 'AGENTS.md'), '使用者的代號是胡桃。');
  const { agent, commands, attachSession, dispose } = await createNexusAgent({
    model: model(upstream.baseURL),
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    systemPrompt: '你是測試助手。',
    plugins: [...plugins],
    checkpointer: new MemorySaver(),
    ...(summarization !== undefined && { summarization }),
  });
  const sessions = new SessionRegistry('log-derived-history');
  const detach = attachSession(sessions);
  const input = new PassThrough();
  input.end(lines);
  try {
    await runRepl(
      agent,
      { input, output: new PassThrough() },
      { log: () => {}, error: () => {} },
      sessions.root,
      commands,
    );
  } finally {
    detach();
    await dispose();
    await upstream.close();
  }
  return finish([...sessions.root.events], upstream.bodies);
}

/** 出貨路徑之一：`runCli --live`（出貨清單、出貨設定、真的落盤），日誌從 `cli.jsonl` 讀回。 */
export async function runShippedCli(lines: string, script: Script, patchExtra = ''): Promise<Run> {
  const upstream = await fakeEndpoint(script, false);
  const home = await mkdtemp(join(tmpdir(), 'nexus-lh-home-'));
  const logs = await mkdtemp(join(tmpdir(), 'nexus-lh-logs-'));
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-lh-ws-'));
  const cwd = await mkdtemp(join(tmpdir(), 'nexus-lh-cwd-'));
  await writeFile(join(workspace, 'AGENTS.md'), '使用者的代號是胡桃。');
  const patch = join(home, 'patch.yml');
  writeFileSync(patch, liveModelPatch(upstream.baseURL, patchExtra), { mode: 0o600 });
  const input = new PassThrough();
  input.end(lines);
  try {
    await runCli({
      argv: ['--live', '--session-log', logs, '--workspace', workspace, '--patch', patch],
      cwd,
      env: { [HARNESS_HOME_ENV]: home },
      input,
      output: new PassThrough(),
      printer: { log: () => {}, error: () => {} },
    });
  } finally {
    await upstream.close();
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith('.jsonl')) files.push(join(dir, entry.name));
    }
  };
  walk(logs);
  const rootLog = files.find((file) => /cli\.jsonl$/.test(file));
  if (rootLog === undefined) throw new Error(`cli.jsonl 不在 ${logs} 底下：${files.join(', ')}`);
  return finish(readJsonl(rootLog), upstream.bodies);
}

/** 這一句人話之後，已經有一則收尾的 AI 訊息，而且對話回到 idle。 */
const answered = (text: string) => (state: ConversationState) => {
  const at = state.entries.findLastIndex((entry) => entry.kind === 'human' && entry.text === text);
  return (
    state.status === 'idle' &&
    at >= 0 &&
    state.entries.slice(at + 1).some((entry) => entry.kind === 'ai' && !entry.streaming)
  );
};

/**
 * 出貨路徑之二：`runServe --live`（web 走的串流路徑）。`phases` 每一段是一台 serve 的生命：
 * 那一台依序說完這幾句、等每一句收尾後關掉，下一段在**同一個日誌目錄**開一台新的並接著說——
 * 兩段以上就是「重啟後續接」。回的是 `alpha` 那條會話的整份日誌。
 */
export async function runServePhases(
  phases: readonly (readonly string[])[],
  script: Script,
  patchExtra = '',
): Promise<Run> {
  const upstream = await fakeEndpoint(script, true);
  const home = await mkdtemp(join(tmpdir(), 'nexus-lh-home-'));
  const logs = await mkdtemp(join(tmpdir(), 'nexus-lh-logs-'));
  const patch = join(home, 'patch.yml');
  writeFileSync(patch, liveModelPatch(upstream.baseURL, patchExtra), { mode: 0o600 });
  const { reduceConversation } = await import('@nexus/wire');
  try {
    for (const texts of phases) {
      let running: RunningServe | undefined;
      try {
        running = (await runServe({
          argv: ['--port', '0', '--live', '--session-log', logs, '--patch', patch],
          log: () => undefined,
          env: { [HARNESS_HOME_ENV]: home },
        })) as RunningServe;
        const client = await serveClient(running);
        const events = await client.openEvents('alpha');
        let state = emptyConversation();
        for (const text of texts) {
          await client.runStart('alpha', text);
          if (phases.length === 1) {
            state = await foldTurn(events, state);
          } else {
            // 重啟後下行會先重放舊歷史，「root 收尾」那顆 frame 不一定是這一句的；
            // 改等：這一句人話之後有收尾的 AI 訊息，而且回到 idle。
            const deadline = Date.now() + 30_000;
            while (!answered(text)(state)) {
              if (Date.now() > deadline) throw new Error(`等不到「${text}」收尾`);
              const next = await events.next();
              if (next.done === true) throw new Error('下行在收尾之前斷了');
              state = reduceConversation(state, next.value);
            }
          }
        }
        await events.return?.(undefined);
      } finally {
        await running?.close();
      }
    }
  } finally {
    await upstream.close();
  }
  return finish(readJsonl(join(logs, projectKey(process.cwd()), 'alpha.jsonl')), upstream.bodies);
}
