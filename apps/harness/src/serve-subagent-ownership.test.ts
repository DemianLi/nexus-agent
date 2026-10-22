/**
 * 子代理的會話不是 thread：拒絕把它當成一條 thread 打開、驅動或中止（[#1544](https://github.com/DemianLi/nexus-agent/issues/1544)）。
 *
 * 從 `runServe` 起——真的 serve、真的 JSONL 存放處、真的 wire client；**子代理的日誌是腳本模型真的派出一個背景子代理產生的**
 * （header 有 `cwd`、`plugins`、`parentSession`……整份真貨），不是手寫的：手寫 header 少了 `cwd` 的話，develop 的 serve 會先在
 * `assertSameCwd` 被擋下，測到的就不是歸屬核對（PM 審查 #1706 抓到的）。
 *
 * 探針（卡上情境 B）是把子代理 id 當 thread_id 送一句話：以前整條通、回 success、子代理日誌被續寫。這一檔釘的是：
 * **碰日誌之前就拒絕、日誌一個位元組都不動**，而且 `run.cancel` 也一樣（照 dsh `session-controller/src/commands.ts:506-507`）。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { THREAD_IS_SUBAGENT, WireRejectedError } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { openJsonlSessionStore } from './jsonl-session-store.js';
import { startScriptedServe } from './scripted-serve.js';
import { rewriteSessionHeader, sessionEvents, sessionsUnder } from './session-files.fixture.js';
import type { SessionOnDisk } from './session-files.fixture.js';
import type { ScriptedServe } from './scripted-serve.js';

/** 第一台 serve 的腳本：根對話派一個背景子代理，之後都是普通回覆（子代理與根對話共用同一顆腳本模型，輪到誰誰吃）。 */
const DISPATCH_TURNS = [
  {
    content: '委派。',
    toolCalls: [
      {
        name: 'subagent',
        args: { description: '幹活', subagent_type: 'general-purpose', run_in_background: true },
      },
    ],
  },
  { content: '子代理做完了。' },
  { content: '收到。' },
  { content: '好。' },
  { content: '好。' },
] as const;

/** 重啟之後那台的腳本：全是普通回覆。 */
const PLAIN_TURNS = [
  { content: '好。' },
  { content: '好。' },
  { content: '好。' },
  { content: '好。' },
] as const;

let serve: ScriptedServe | undefined;
const temporary: string[] = [];

afterEach(async () => {
  await serve?.close();
  serve = undefined;
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

const sha1 = (text: string | Buffer): string => createHash('sha1').update(text).digest('hex');

async function until(predicate: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 一個真的子代理會話落在磁碟上：它的 id、檔案路徑。 */
interface RealSubagent {
  readonly root: string;
  readonly directory: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly header: string;
  readonly body: string;
}

/** 在 `root` 底下起一台 serve（`--session-log`）。 */
async function start(
  root: string,
  turns: readonly { content: string }[] | typeof DISPATCH_TURNS,
  extraRows?: string,
  log?: (line: string) => void,
): Promise<ScriptedServe> {
  serve = await startScriptedServe(turns as never, {
    argv: ['--session-log', root],
    ...(extraRows === undefined ? {} : { extraRows }),
    ...(log === undefined ? {} : { log }),
  });
  return serve;
}

/**
 * 起第一台 serve，讓根對話 `alpha` 真的派出一個背景子代理，等它的第一輪寫完收尾。
 * 回傳時 serve **還活著**（`serve` 變數），要重啟的測試自己 `close()`。
 */
async function dispatchRealSubagent(): Promise<RealSubagent> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-serve-subagent-'));
  temporary.push(root);
  const first = await start(root, DISPATCH_TURNS);
  const client = await serveClient(first.running);
  const events = await client.openEvents('alpha');
  await client.runStart('alpha', '主對話：請派一個子代理');
  await foldTurn(events);
  await events.return?.(undefined);

  // 子代理那一份的 id 是 `alpha/<runId>`，背景派的 runId 以 `bg-` 起頭；經 `session-files.fixture.ts` 找（#1868）。
  let found = undefined as SessionOnDisk | undefined;
  await until(async () => {
    found = (await sessionsUnder(root)).find((session) => session.id.startsWith('alpha/bg-'));
    return found !== undefined;
  });
  const subagent = found!;
  // 子代理的第一輪寫完收尾：本文裡出現 `turn/end`。
  await until(async () =>
    (await sessionEvents(subagent)).events.some((event) => event.type === 'turn/end'),
  );
  const runId = subagent.id.slice('alpha/'.length);
  return {
    root,
    directory: subagent.directory,
    runId,
    sessionId: subagent.id,
    header: subagent.headerPath,
    body: subagent.logPath,
  };
}

const digest = async (subagent: RealSubagent) => ({
  header: sha1(await readFile(subagent.header)),
  body: sha1(await readFile(subagent.body)),
  entries: (await readdir(subagent.directory)).filter((name) => !name.endsWith('.lock')).sort(),
});

/**
 * 讓子代理的日誌停在「當掉的一輪」（`turn/start` 沒有收尾）。續接會先把補結寫回檔上（#721），所以「先 resume 再拒」會讓本文 sha1 變掉——
 * 這是「碰日誌之前就拒絕」唯一量得到的地方。
 */
async function leaveInterruptedTurn(subagent: RealSubagent): Promise<void> {
  const lines = (await readFile(subagent.body, 'utf8')).trimEnd().split('\n');
  const last = JSON.parse(lines.at(-1)!) as { seq: number };
  await appendFile(
    subagent.body,
    `${JSON.stringify({ type: 'turn/start', seq: last.seq + 1, time: Date.now(), data: { kind: 'message', text: '當掉的一輪' } })}\n`,
  );
}

/** 一次嘗試丟出來的錯（沒丟就是 `undefined`）。 */
async function rejection(attempt: () => Promise<unknown>): Promise<unknown> {
  return attempt().then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

function expectSubagentRefusal(caught: unknown): void {
  expect(caught).toBeInstanceOf(WireRejectedError);
  expect((caught as WireRejectedError).code).toBe(THREAD_IS_SUBAGENT);
  expect((caught as WireRejectedError).serverMessage).toContain('subagent.send');
  expect((caught as WireRejectedError).serverMessage).not.toContain('建不起來');
}

describe('子代理的會話不是 thread（#1544 驗收 1、2）', () => {
  it('重啟之後：下行、run.start、run.cancel 都回 thread_is_subagent，子代理的日誌一個位元組都不動，之後 subagent 的路照常', async () => {
    const subagent = await dispatchRealSubagent();
    await serve?.close();
    serve = undefined;
    await leaveInterruptedTurn(subagent);
    const before = await digest(subagent);

    const second = await start(subagent.root, PLAIN_TURNS);
    const client = await serveClient(second.running);

    expectSubagentRefusal(await rejection(() => client.openEvents(subagent.sessionId)));
    expect(await client.runStart(subagent.sessionId, '冒名')).toMatchObject({
      type: 'error',
      error: THREAD_IS_SUBAGENT,
    });
    // run.cancel 不經 `threadFor`，另外閘（dsh `commands.ts:506-507`）。以前對任何 id 都回 `accepted: true`。
    expect(await client.runCancel(subagent.sessionId)).toMatchObject({
      type: 'error',
      error: THREAD_IS_SUBAGENT,
    });

    // 一個位元組都不動：補結沒寫（本文 sha1 不變）、header 沒被取代、沒有多出檔（暫存檔、孫代理）。
    expect(await digest(subagent)).toEqual(before);

    // 冒名的請求沒有留下租約：這個會話還拿得到寫把手（之後父對話叫醒它才不會撞上）。
    const probe = await openJsonlSessionStore({ directory: subagent.directory }).resume(
      subagent.sessionId,
    );
    await probe.stored.close();

    // 子代理自己的路照常：父對話載入之後，`subagent.send` 回受理（卡上最後一條）。
    const parentEvents = await client.openEvents('alpha');
    expect(await client.subagentSend('alpha', subagent.runId, '叫醒你')).toMatchObject({
      type: 'success',
      result: { accepted: true },
    });
    await parentEvents.return?.(undefined);
  });

  it('同一台 serve、父 thread 還在記憶體（子代理的租約由父對話握著）：回專屬碼，不是 unknown_error', async () => {
    const subagent = await dispatchRealSubagent();
    const before = await digest(subagent);
    const client = await serveClient(serve!.running);

    expectSubagentRefusal(await rejection(() => client.openEvents(subagent.sessionId)));
    expect(await client.runStart(subagent.sessionId, '冒名')).toMatchObject({
      type: 'error',
      error: THREAD_IS_SUBAGENT,
    });
    expect(await digest(subagent)).toEqual(before);
  });

  it('租約被另一個行程握著：回的是專屬碼，不是「多半是另一個行程還開著它」（拿掉冷讀、只留續接後的核對就紅）', async () => {
    const subagent = await dispatchRealSubagent();
    await serve?.close();
    serve = undefined;
    const holder = await openJsonlSessionStore({ directory: subagent.directory }).resume(
      subagent.sessionId,
    );
    try {
      const second = await start(subagent.root, PLAIN_TURNS);
      const client = await serveClient(second.running);
      expectSubagentRefusal(await rejection(() => client.openEvents(subagent.sessionId)));
    } finally {
      await holder.stored.close();
    }
  });

  it('拒絕子代理 id 不占 thread 名額：上限 1 的 serve 拒絕之後，普通 thread 照樣開得起來', async () => {
    const subagent = await dispatchRealSubagent();
    await serve?.close();
    serve = undefined;
    const second = await start(
      subagent.root,
      PLAIN_TURNS,
      '- id: thread-capacity\n  config:\n    maxThreads: 1\n',
    );
    const client = await serveClient(second.running);

    expectSubagentRefusal(await rejection(() => client.openEvents(subagent.sessionId)));
    const events = await client.openEvents('beta');
    await events.return?.(undefined);
    expect(await client.runStart('beta', '照常')).toMatchObject({ type: 'success' });
  });

  it('反例：沒有 parentSession 的 `alpha/…` 是一條普通的新 thread，照常開；對不存在的 id 取消仍回受理', async () => {
    const subagent = await dispatchRealSubagent();
    await serve?.close();
    serve = undefined;
    const second = await start(subagent.root, PLAIN_TURNS);
    const client = await serveClient(second.running);

    const events = await client.openEvents('alpha/not-a-subagent');
    await events.return?.(undefined);
    expect(await client.runStart('alpha/not-a-subagent', '照常')).toMatchObject({
      type: 'success',
    });
    expect(await client.runCancel('no-such-thread')).toMatchObject({
      type: 'success',
      result: { accepted: true },
    });
  });

  it('反例：以前寫過的普通 thread 照常接回來（閘不誤擋）', async () => {
    const subagent = await dispatchRealSubagent();
    await serve?.close();
    serve = undefined;
    const second = await start(subagent.root, PLAIN_TURNS);
    const client = await serveClient(second.running);

    const events = await client.openEvents('alpha');
    await client.runStart('alpha', '第二句');
    await foldTurn(events);
    await events.return?.(undefined);
    expect(await client.runCancel('alpha')).toMatchObject({ type: 'success' });
  });

  it('run.cancel 的冷讀拋錯（header 壞了）：照常受理，但記一行 warn，不是默默放行', async () => {
    const subagent = await dispatchRealSubagent();
    await serve?.close();
    serve = undefined;
    // 找不到 root 那一份就拋錯：前提（它在）照樣成立才寫壞。
    await rewriteSessionHeader(subagent.directory, 'alpha', () => '{壞掉');

    const lines: string[] = [];
    const second = await start(subagent.root, PLAIN_TURNS, undefined, (line) => lines.push(line));
    const client = await serveClient(second.running);

    expect(await client.runCancel('alpha')).toMatchObject({
      type: 'success',
      result: { accepted: true },
    });
    expect(lines.some((line) => line.includes('run.cancel 查不了 "alpha"'))).toBe(true);
  });

  it('子代理自己那條路（subagent.history）不受影響：照樣讀得到', async () => {
    const subagent = await dispatchRealSubagent();
    await serve?.close();
    serve = undefined;
    const second = await start(subagent.root, PLAIN_TURNS);
    const client = await serveClient(second.running);

    const found = await client.subagentHistory('alpha', subagent.runId);
    expect(JSON.stringify(found)).toContain('幹活');
  });
});
