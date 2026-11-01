/**
 * 切換核准政策時對模型講一聲（[#2057](https://github.com/DemianLi/nexus-agent/issues/2057)）。
 *
 * 從 `runServe` 起量：真的 serve、真的 JSONL 日誌、真的續接重放。**零憑證、零外部連線**：模型是腳本。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { BaseMessage } from '@langchain/core/messages';
import { emptyConversation, reduceAll } from '@nexus/wire';
import type { WireClient } from '@nexus/wire';
import {
  PolicyNoticeLedger,
  policyNoticeText,
} from '@nexus/plugin-permission-presets/src/policy-notice.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCli } from './cli.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { ScriptedChatModel } from './scripted-model.js';
import { scriptedPatchText } from './scripted-serve.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
let running: RunningServe | undefined;
/** 模型實際收到的每一輪。 */
let prompts: (readonly BaseMessage[])[];

beforeEach(() => {
  prompts = [];
  const generate = ScriptedChatModel.prototype._generate;
  vi.spyOn(ScriptedChatModel.prototype, '_generate').mockImplementation(function (
    this: ScriptedChatModel,
    messages,
  ) {
    prompts.push(messages);
    return generate.call(this, messages);
  });
  const stream = ScriptedChatModel.prototype._streamResponseChunks;
  vi.spyOn(ScriptedChatModel.prototype, '_streamResponseChunks').mockImplementation(function (
    this: ScriptedChatModel,
    messages,
    ...rest
  ) {
    prompts.push(messages);
    return stream.call(this, messages, ...rest);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await running?.close();
  running = undefined;
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join('/var/tmp', prefix));
  temporary.push(dir);
  return dir;
}

const PRESETS = `- id: permission-presets
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
`;

const ASK_TO_NEVER = policyNoticeText('ask', 'never');
const NEVER_TO_ASK = policyNoticeText('never', 'ask');

interface Home {
  readonly home: string;
  readonly workspace: string;
  readonly patch: string;
}

async function home(rows = PRESETS): Promise<Home> {
  const patch = join(await scratch('nexus-policy-notice-patch-'), 'script.patch.yml');
  const turns = Array.from({ length: 20 }, () => ({ content: '好。' }));
  await writeFile(patch, scriptedPatchText(turns, rows), 'utf8');
  return {
    home: await scratch('nexus-policy-notice-home-'),
    workspace: await scratch('nexus-policy-notice-ws-'),
    patch,
  };
}

/** 起 serve；已有一台就先收掉，同一個 home 再起就是續接。 */
async function client(fx: Home): Promise<WireClient> {
  await running?.close();
  running = (await runServe({
    argv: ['--port', '0', '--workspace', fx.workspace, '--patch', fx.patch],
    log: () => undefined,
    env: { [HARNESS_HOME_ENV]: fx.home },
  })) as RunningServe;
  return serveClient(running);
}

async function turn(wire: WireClient, thread: string, text = '開始。') {
  const events = await wire.openEvents(thread);
  await wire.runStart(thread, text);
  const state = await foldTurn(events);
  await events.return?.(undefined);
  return state;
}

/** 主對話最後一次請求：標題那幾次呼叫也走這顆模型，帶政策句的才是主對話。 */
const lastMain = (): readonly BaseMessage[] | undefined =>
  prompts.findLast((prompt) =>
    prompt.some((message) => message.getType() === 'system' && message.text.includes('核准提示')),
  );

const noticesIn = (prompt: readonly BaseMessage[] | undefined): string[] =>
  (prompt ?? [])
    .filter((message) => message.getType() === 'human')
    .map((message) => message.text)
    .filter((text) => text === ASK_TO_NEVER || text === NEVER_TO_ASK);

describe('切換核准政策時對模型講一聲（#2057）', () => {
  it('切換後下一次模型呼叫看得到一則，而且在這一輪人話之後', async () => {
    const wire = await client(await home());
    await turn(wire, 't');
    await wire.slashRun('t', '/permission danger-full-access');
    await turn(wire, 't', '下一句。');

    const prompt = lastMain() ?? [];
    expect(noticesIn(prompt)).toEqual([ASK_TO_NEVER]);
    const humans = prompt.filter((m) => m.getType() === 'human').map((m) => m.text);
    expect(humans.indexOf(ASK_TO_NEVER)).toBeGreaterThan(humans.indexOf('下一句。'));
  }, 60000);

  it('政策沒變：切到核准一樣的組不發', async () => {
    const wire = await client(await home());
    await turn(wire, 't');
    await wire.slashRun('t', '/permission read-only');
    await turn(wire, 't');
    expect(noticesIn(lastMain())).toEqual([]);
  }, 60000);

  it('連切兩次：照先後各一則', async () => {
    const wire = await client(await home());
    await turn(wire, 't');
    await wire.slashRun('t', '/permission danger-full-access');
    await wire.slashRun('t', '/permission workspace-write');
    await turn(wire, 't');
    expect(noticesIn(lastMain())).toEqual([ASK_TO_NEVER, NEVER_TO_ASK]);
  }, 60000);

  it('續接重放：發過的不再發，模型只看到歷史裡那一則', async () => {
    const fx = await home();
    const first = await client(fx);
    await turn(first, 't');
    await first.slashRun('t', '/permission danger-full-access');
    await turn(first, 't');

    await turn(await client(fx), 't');
    expect(noticesIn(lastMain())).toEqual([ASK_TO_NEVER]);
  }, 60000);

  it('切完還沒發就重啟：通知不掉，也只發一次', async () => {
    const fx = await home();
    const first = await client(fx);
    await turn(first, 't');
    await first.slashRun('t', '/permission danger-full-access');

    const second = await client(fx);
    await turn(second, 't');
    expect(noticesIn(lastMain())).toEqual([ASK_TO_NEVER]);
    await turn(second, 't');
    expect(noticesIn(lastMain())).toEqual([ASK_TO_NEVER]);
  }, 60000);

  it('升級前的日誌（切換之後已有回覆、沒有通知）：續接不補發', async () => {
    const fx = await home();
    const first = await client(fx);
    await turn(first, 't');
    const silenced = vi.spyOn(PolicyNoticeLedger.prototype, 'pending').mockReturnValue([]);
    await first.slashRun('t', '/permission danger-full-access');
    await turn(first, 't');
    silenced.mockRestore();
    expect(noticesIn(lastMain())).toEqual([]);

    await turn(await client(fx), 't');
    expect(noticesIn(lastMain())).toEqual([]);
  }, 60000);

  it('不顯示成使用者打的話：網頁即時與冷讀歷史', async () => {
    const wire = await client(await home());
    await turn(wire, 't');
    await wire.slashRun('t', '/permission danger-full-access');
    const live = await turn(wire, 't');
    expect(JSON.stringify(live.entries)).not.toContain(ASK_TO_NEVER);

    const history = await wire.threadHistory('t');
    if (history.kind !== 'ok') throw new Error(`歷史沒拿到：${JSON.stringify(history)}`);
    expect(JSON.stringify(history.result.events)).not.toContain(ASK_TO_NEVER);
    const cold = reduceAll(emptyConversation(), history.result.events);
    expect(JSON.stringify(cold.entries)).not.toContain(ASK_TO_NEVER);
  }, 60000);
});

describe('CLI 的 REPL 也發（#2057）', () => {
  it('切到別組之後下一句看得到通知', async () => {
    const fx = await home();
    const out: string[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        out.push(chunk.toString());
        done();
      },
    });
    await runCli({
      argv: ['--workspace', fx.workspace, '--patch', fx.patch],
      input: Readable.from(['開始。\n/permission danger-full-access\n下一句。\n']),
      output,
      env: { [HARNESS_HOME_ENV]: fx.home },
    });
    expect(noticesIn(lastMain())).toEqual([ASK_TO_NEVER]);
  }, 60000);
});
