/**
 * 變更紀錄裡留著一筆舊的 `disable`，而那一列後來改成關不掉（[#1619](https://github.com/DemianLi/nexus-agent/issues/1619)）。
 *
 * `thread-capacity` 在 #1619 之前關得掉（文件寫「`disabled: true` 就是不限」），所以部署方可能已經用 `plugin disable thread-capacity`
 * 關過它，那一筆在 `plugin-journal.jsonl` 裡。升級之後這一列在保護名單上：
 *
 * - serve 起不來是對的（清單不合格），但訊息要指到紀錄、給出 `plugin enable thread-capacity` 那一句修法，不叫人去改出貨檔；
 * - 寫入口要寫得進那一句 `enable`（找列那一步不檢查保護名單），寫完 serve 起得來、上限是出廠的 500；
 * - 新的 `disable` 照樣被拒；清單還壞著時改別列也被拒，訊息帶同一句修法。
 *
 * **零憑證、零外部連線**：serve 用預設的假模型。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin, PluginChangeRejected } from './plugin-change.js';
import type { PluginChange } from './plugin-change.js';
import { appendRaw, readJournalText } from './plugin-journal.fixture.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { bodyLog } from './fixtures.js';

const temporary: string[] = [];
const running: RunningServe[] = [];

beforeAll(() => {
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-protected-journal');
});
afterAll(() => {
  vi.unstubAllEnvs();
});
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FIX = '`plugin enable thread-capacity`';

/** 一個 home，紀錄裡已經有一筆 #1619 之前寫得進去的 `disable thread-capacity`。 */
async function upgradedHome(): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-protected-journal-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  await appendRaw(dir, {
    op: 'disable',
    id: 'thread-capacity',
    name: '#settings/thread-capacity',
    before: false,
    after: true,
  });
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

async function startServe(env: NodeJS.ProcessEnv, lines: string[] = []): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0'],
    log: bodyLog(lines),
    env,
  })) as RunningServe;
  running.push(server);
  return server;
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

async function rejected(change: PluginChange, env: NodeJS.ProcessEnv): Promise<Error> {
  const error = await failure(changePlugin(change, { env }));
  expect(error).toBeInstanceOf(PluginChangeRejected);
  return error;
}

describe('紀錄裡留著舊的 disable，那一列後來關不掉（#1619）', () => {
  it('serve 起不來，訊息指到變更紀錄、給出 plugin enable 那一句修法', async () => {
    const { env } = await upgradedHome();
    const error = await failure(startServe(env));
    expect(error.message).toContain('變更紀錄');
    expect(error.message).toContain('從這一版起關不掉');
    expect(error.message).toContain(FIX);
    // 不叫人去改出貨檔或 patch：那是出貨層或 `--patch` 關的時候的修法。
    expect(error.message).not.toContain('把這一列的 `disabled` 拿掉');
  });

  it('enable 寫得進去；寫完 serve 起得來，上限是出廠的 500', async () => {
    const { dir, env } = await upgradedHome();
    const result = await changePlugin({ op: 'enable', id: 'thread-capacity' }, { env });
    expect(result.record?.op).toBe('enable');
    expect(readJournalText(dir)).toMatch(/"op":"enable","id":"thread-capacity"/u);

    const lines: string[] = [];
    await startServe(env, lines);
    expect(lines).toContainEqual(expect.stringMatching(/^thread 上限：500（/u));
  });

  it('新的 disable 照樣被拒，記成 rejected', async () => {
    const { dir, env } = await upgradedHome();
    await changePlugin({ op: 'enable', id: 'thread-capacity' }, { env });
    const error = await rejected({ op: 'disable', id: 'thread-capacity' }, env);
    expect(error.message).toContain('關不掉');
    // 這一次要寫的 `disable` 跟紀錄折在同一層，但它不是「紀錄關的」：不給 enable 那一句修法。
    expect(error.message).not.toContain(FIX);
    expect(readJournalText(dir)).toMatch(
      /"op":"rejected","requested":"disable","id":"thread-capacity"/u,
    );
  });

  it('清單還壞著時改別列設定被拒，訊息帶同一句修法、記成 rejected', async () => {
    const { dir, env } = await upgradedHome();
    const error = await rejected(
      { op: 'config-set', id: 'todo', config: { allowParallelInProgress: false } },
      env,
    );
    expect(error.message).toContain(FIX);
    expect(readJournalText(dir)).toMatch(/"op":"rejected","requested":"config-set","id":"todo"/u);
  });

  it('`--patch` 關的（不是紀錄）：訊息是拿掉 disabled 那一句，不是 plugin enable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-protected-journal-'));
    chmodSync(dir, 0o700);
    temporary.push(dir);
    const overlay = join(dir, 'overlay.yml');
    writeFileSync(overlay, '- id: thread-capacity\n  disabled: true\n', { mode: 0o600 });
    const error = await failure(
      runServe({
        argv: ['--port', '0', '--patch', overlay],
        log: () => undefined,
        env: { [HARNESS_HOME_ENV]: dir },
      }),
    );
    expect(error.message).toContain('關不掉');
    expect(error.message).toContain('把這一列的 `disabled` 拿掉');
    expect(error.message).not.toContain(FIX);
  });
});
