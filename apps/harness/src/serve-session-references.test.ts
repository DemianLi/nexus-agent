/**
 * 產品路徑上的 `GET /threads/:id/session-references`——[#713](https://github.com/DemianLi/nexus-agent/issues/713)。
 *
 * 候選排得對不對在 [`session-reference-candidates.test.ts`](./session-reference-candidates.test.ts)；這一檔問的是只有產品路徑上量得到的：
 *
 * 1. **列候選一條 agent 都不建**，連提問的那條 thread 也不建。量具是一顆只記次數的見證 plugin（`assembly-witness.fixture.ts`）。
 * 2. **跨專案**：會話根底下別格的會話列得出來，標同工作區與否。
 * 3. **沒落盤就是「不提供」**，不是空清單。
 * 4. **快照記的是被引用那份磁碟上的版號**（#1856）：header 讀回來轉譯成這一版，`capturedFormatVersion` 仍記原版號。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import type { SessionReferenceListResult } from '@nexus/wire';
import { formatSessionReferenceMention, parseSessionReferenceText } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { assemblyWitness, resetAssemblyWitness } from './assembly-witness.fixture.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_DIR_NAME } from './harness-home.js';
import {
  legacyTwoFilePathsIn,
  openJsonlSessionStore,
  projectKey,
  sessionPathsIn,
} from './jsonl-session-store.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { LEGACY_TWO_FILE_FORMAT_VERSION } from './session-files.fixture.js';
import { TOOL_RESULT_STASH_DIR_NAME } from './settings/tool-result-stash.js';

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const WITNESS = fileURLToPath(new URL('./assembly-witness.patch.yml', import.meta.url));
const CANDIDATE_LIMIT_PATCH = fileURLToPath(
  new URL('./settings/session-reference-limit.patch.yml', import.meta.url),
);
const PERSISTENCE_OFF_PATCH = fileURLToPath(
  new URL('./settings/persistence-off.patch.yml', import.meta.url),
);

async function start(root: string, extra: readonly string[] = []): Promise<RunningServe> {
  resetAssemblyWitness();
  running = (await runServe({
    argv: ['--port', '0', '--patch', WITNESS, '--session-log', root, ...extra],
    log: () => undefined,
    env: {},
  })) as RunningServe;
  return running;
}

async function driveTurn(server: RunningServe, threadId: string, prompt: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, prompt);
  await foldTurn(events);
  await events.return?.(undefined);
}

async function references(server: RunningServe, threadId: string, query: string) {
  const outcome = await (await serveClient(server)).sessionReferences(threadId, query);
  if (outcome.kind !== 'ok') throw new Error(`列會話被拒：${outcome.message}`);
  return outcome.result;
}

function available(result: SessionReferenceListResult) {
  if (!result.available) throw new Error('這台 server 說它不提供列會話');
  return result.candidates;
}

describe('GET /threads/:id/session-references', () => {
  it('重開之後列得出以前的會話與別的專案的，排除提問的那條；一條 agent 都不建', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-refs-'));
    const first = await start(root);
    await driveTurn(first, 'alpha', '先開的那條');
    await driveTurn(first, 'beta', '後開的那條');
    await first.close();
    running = undefined;

    // 別的專案那一格：手寫一份，header 的 cwd 是別的目錄。
    const other = openJsonlSessionStore({ directory: join(root, projectKey('/別的專案')) }).create({
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'elsewhere',
      createdAt: 5,
      cwd: '/別的專案',
    });
    await other.append([
      {
        type: 'turn/start',
        seq: 0,
        time: 9_999_999_999_999,
        data: { kind: 'message', text: '別處的事' },
      } as never,
    ]);
    await other.close();

    const second = await start(root);
    const built = assemblyWitness.applied;
    // 提問的是一條從沒開過的 thread：不該為它建 agent。
    const candidates = available(await references(second, 'brand-new', ''));
    expect(
      candidates.map(({ sessionId, label, sameWorkspace }) => [sessionId, label, sameWorkspace]),
    ).toEqual([
      ['beta', '後開的那條', true],
      ['alpha', '先開的那條', true],
      ['elsewhere', '別處的事', false],
    ]);
    expect(assemblyWitness.applied).toBe(built);

    // 提問的那條自己不在裡面；mention 解得回它指的會話。
    const filtered = available(await references(second, 'beta', '先開'));
    expect(filtered.map(({ sessionId }) => sessionId)).toEqual(['alpha']);
    expect(parseSessionReferenceText(filtered[0]!.mention).references).toEqual([
      { sessionId: 'alpha', label: '先開的那條' },
    ]);
    expect(
      available(await references(second, 'beta', '')).map(({ sessionId }) => sessionId),
    ).not.toContain('beta');
    expect(assemblyWitness.applied).toBe(built);
  });

  it('產品路徑：@ 了以前的會話，領走時真的讀回來、凍成快照落進提問那條的日誌（出貨組裝、真的落盤）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-refs-turn-'));
    const first = await start(root);
    await driveTurn(first, 'alpha', '先開的那條提到蘋果派');
    await first.close();
    running = undefined;

    const second = await start(root);
    const candidate = available(await references(second, 'beta', '')).find(
      ({ sessionId }) => sessionId === 'alpha',
    )!;
    await driveTurn(second, 'beta', `接著上面那條 ${candidate.mention} 說`);
    // 收台會把還在寫入視窗裡的事件沖下去；不收的話 `turn/end` 可能還沒落盤。
    await second.close();
    running = undefined;

    const store = openJsonlSessionStore({ directory: join(root, projectKey(process.cwd())) });
    const beta = await (await store.open('beta', 'read')).read();
    const start0 = beta.find((event) => event.type === 'turn/start')!;
    // 日誌上的人話是換過的：標題，不是網址。
    expect((start0.data as { text: string }).text).toBe(`接著上面那條 @${candidate.label} 說`);
    const snapshots = beta.filter(
      (event) => event.type === 'user/message' && event.data.source.kind === 'session-reference',
    );
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0] as SessionEvent<'user/message'>;
    expect(JSON.stringify(snapshot.data.message)).toContain('先開的那條提到蘋果派');
    expect(snapshot.data.source).toMatchObject({
      references: [{ sessionId: 'alpha', label: candidate.label }],
    });
    // 這一輪正常收尾，不是失敗。
    expect(beta.some((event) => event.type === 'turn/failed')).toBe(false);
    expect(beta.some((event) => event.type === 'turn/end')).toBe(true);
  });

  it('被引用的是舊版寫的：落盤的快照記原版號，不是轉譯後的這一版（#1856，出貨組裝、真的落盤）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-refs-old-'));
    const first = await start(root);
    await driveTurn(first, 'alpha', '舊版那條提到蘋果派');
    await first.close();
    running = undefined;

    // 把 alpha 換成上一版寫的舊兩檔：header 是世代檔的 header 行拿掉 `type`、版號換成上一版，日誌是世代檔第二行起的原樣
    // 本文（本文照上一版讀得懂）。會話目錄刪掉：留著的話兩種佈局並存，讀方拒讀。
    const directory = join(root, projectKey(process.cwd()));
    const generation = sessionPathsIn(directory, 'alpha');
    const headerPath = legacyTwoFilePathsIn(directory, 'alpha').header;
    const older = LEGACY_TWO_FILE_FORMAT_VERSION;
    const text = await readFile(generation.log, 'utf8');
    const newline = text.indexOf('\n');
    const { type: _type, ...onDisk } = JSON.parse(text.slice(0, newline)) as Record<
      string,
      unknown
    >;
    await writeFile(headerPath, JSON.stringify({ ...onDisk, version: older }));
    await writeFile(legacyTwoFilePathsIn(directory, 'alpha').log, text.slice(newline + 1));
    await rm(generation.sessionDirectory, { recursive: true });

    const second = await start(root);
    const candidate = available(await references(second, 'beta', '')).find(
      ({ sessionId }) => sessionId === 'alpha',
    )!;
    await driveTurn(second, 'beta', `接著上面那條 ${candidate.mention} 說`);
    await second.close();
    running = undefined;

    const beta = await (await openJsonlSessionStore({ directory }).open('beta', 'read')).read();
    const snapshot = beta.find(
      (event) => event.type === 'user/message' && event.data.source.kind === 'session-reference',
    ) as SessionEvent<'user/message'> | undefined;
    expect(snapshot?.data.source).toMatchObject({
      references: [{ sessionId: 'alpha', capturedFormatVersion: older }],
    });
    // 被引用的那份只被讀，沒被續接（續接會遷成世代、舊路徑換成這一版的墓碑）：磁碟上仍是舊版號。
    expect((JSON.parse(await readFile(headerPath, 'utf8')) as { version: number }).version).toBe(
      older,
    );
  });

  it('被引用的會話塞不進預算：截掉的全文存進工具結果暫存，快照裡帶 saved 與位址（#1553，出貨組裝、真的落盤）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-refs-spill-'));
    // 遠超過預算（今天 64 KiB）；中間的記號對齊 64 碼點分段，在逐字稿裡自成一行。
    const middle = 'MIDDLE-OF-THE-REFERENCED-SESSION'.padEnd(64, '-');
    const first = await start(root);
    await driveTurn(first, 'alpha', `${'a'.repeat(64 * 5000)}${middle}${'b'.repeat(64 * 5000)}`);
    await first.close();
    running = undefined;

    const second = await start(root);
    const candidate = available(await references(second, 'beta', '')).find(
      ({ sessionId }) => sessionId === 'alpha',
    )!;
    await driveTurn(second, 'beta', `接著上面那條 ${candidate.mention} 說`);
    await second.close();
    running = undefined;

    const directory = join(root, projectKey(process.cwd()));
    const beta = await (await openJsonlSessionStore({ directory }).open('beta', 'read')).read();
    const snapshot = beta.find(
      (event) => event.type === 'user/message' && event.data.source.kind === 'session-reference',
    ) as SessionEvent<'user/message'> | undefined;
    const text = String(snapshot?.data.message.data.content);
    expect(text).not.toContain('MIDDLE-OF');
    expect(text).toMatch(/"status":\s*"saved"/u);
    const locator = /\/large_tool_results\/([0-9a-f]{12}-session-reference-1\.txt)/u.exec(text);
    expect(locator).not.toBeNull();

    // serve 收到 `env: {}`，暫存根退回 `~/.nexus-agent/tool-results`（測試的 HOME 是暫存目錄）。
    const stashRoot = join(homedir(), HARNESS_HOME_DIR_NAME, TOOL_RESULT_STASH_DIR_NAME);
    const found = (await readdir(stashRoot, { recursive: true })).filter((path) =>
      path.endsWith(locator![1]!),
    );
    expect(found).toHaveLength(1);
    expect(await readFile(join(stashRoot, found[0]!), 'utf8')).toContain(JSON.stringify(middle));
  });

  it('清單把落盤關掉：不提供，不是空清單', async () => {
    resetAssemblyWitness();
    running = (await runServe({
      argv: ['--port', '0', '--patch', PERSISTENCE_OFF_PATCH],
      log: () => undefined,
      env: {},
    })) as RunningServe;
    expect(await references(running, 'any', '')).toEqual({ available: false });
  });
});

/**
 * 候選上限走設定（[#1573](https://github.com/DemianLi/nexus-agent/issues/1573) N0862 驗收 E）：`session-reference` 那一列的 `candidateLimit` 經
 * `startupSetting` 讀出來，`serve.ts` 建 `SessionReferenceCandidates` 時給 `limit`。`session-reference-candidates.test.ts` 直接傳 `limit`，
 * 那種測法拿掉 `serve.ts` 傳 `limit` 的那一行也照樣綠；這一條走 `runServe`。
 */
describe('候選上限，從 serve 組裝起', () => {
  async function sevenSessions(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-refs-limit-'));
    const directory = join(root, projectKey(process.cwd()));
    for (let at = 0; at < 7; at += 1) {
      const id = `s${String(at)}`;
      const session = openJsonlSessionStore({ directory }).create({
        version: SESSION_LOG_FORMAT_VERSION,
        id,
        createdAt: 100 + at,
        cwd: process.cwd(),
      });
      await session.append([
        {
          type: 'turn/start',
          seq: 0,
          time: 1_000_000_000_000 + at,
          data: { kind: 'message', text: `第 ${String(at)} 條` },
        } as never,
      ]);
      await session.close();
    }
    return root;
  }

  it('candidateLimit: 5（--patch 覆寫）：七條會話只回五筆', async () => {
    const root = await sevenSessions();
    const server = await start(root, ['--patch', CANDIDATE_LIMIT_PATCH]);
    expect(available(await references(server, 'brand-new', ''))).toHaveLength(5);
  });

  it('maxReferences: 2 與 maxReferenceBytes: 1000（同一份 --patch）：引用三條在收下時就被拒；引用一條長會話被截——兩個值都經 serve 交到 pump', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-refs-limits-'));
    const first = await start(root);
    await driveTurn(first, 'alpha', '甲'.repeat(2_000));
    await first.close();
    running = undefined;

    const second = await start(root, ['--patch', CANDIDATE_LIMIT_PATCH]);
    const client = await serveClient(second);
    const mention = (id: string): string =>
      formatSessionReferenceMention({ sessionId: id, label: id });
    const refused = await client.runStart(
      'beta',
      `看 ${mention('a')} ${mention('b')} ${mention('c')}`,
    );
    expect(refused).toMatchObject({ type: 'error', error: 'invalid_argument' });
    expect(String(refused.type === 'error' ? refused.message : '')).toContain(
      'SESSION_REFERENCE_TOO_MANY',
    );

    const candidate = available(await references(second, 'beta', '')).find(
      ({ sessionId }) => sessionId === 'alpha',
    )!;
    await driveTurn(second, 'beta', `接著 ${candidate.mention} 說`);
    await second.close();
    running = undefined;

    const beta = await (
      await openJsonlSessionStore({ directory: join(root, projectKey(process.cwd())) }).open(
        'beta',
        'read',
      )
    ).read();
    const snapshot = beta.find(
      (event) => event.type === 'user/message' && event.data.source.kind === 'session-reference',
    ) as SessionEvent<'user/message'>;
    // 2,000 個「甲」是 6,000 位元組，超過 1,000 的預算：被截；出廠預算（64 KiB 以上）下它是完整的。
    expect(JSON.stringify(snapshot.data.message)).toContain('Reference omissions');
  });

  it('對照：出廠的 50，同一批七條全回', async () => {
    const root = await sevenSessions();
    const server = await start(root);
    expect(available(await references(server, 'brand-new', ''))).toHaveLength(7);
  });
});
