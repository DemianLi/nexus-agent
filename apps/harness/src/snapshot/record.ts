/**
 * **用真模型錄快照夾具**（[#1556](https://github.com/DemianLi/nexus-agent/issues/1556) C077）：真 `runServe --live`，`live-model` 的 `baseUrl`
 * 換成計數代理（`smoke/counting-proxy.ts`，在出口數、超過上限的不轉出去）。不進測試：要真金鑰，手動跑。
 *
 * ```
 * cd apps/harness
 * node_modules/.bin/tsx --tsconfig ../../tsconfig.runtime.json src/snapshot/record.ts \
 *   --env-dir <放 .env 的目錄> --reject-dir <本機證據目錄> --cap 10 <場景名…>
 * ```
 *
 * **金鑰這支腳本不碰**：serve 的 `cwd` 設成 `--env-dir`，由 serve 自己從那裡的 `.env` 讀（`loadLiveLaunchEnv`）；
 * 啟動環境只給一個暫存的 `NEXUS_AGENT_HOME`。代理不記標頭與本文。寫進夾具之前主機路徑換成記號
 * （{@link replaceHostPaths}）。
 *
 * 錄完先核再寫：位置對齊（{@link scriptAlignmentProblem}）、代理轉出的請求數等於日誌裡的模型呼叫數（標題模型已關；
 * 多出來的就是沒落盤的呼叫，重放會錯位）、沒有一輪失敗、沒有像金鑰或帳號的字串。都過了才寫進場景目錄；沒過的寫到
 * `--reject-dir`（不進版控），停在那個場景、拋錯，不往下錄。
 *
 * @module
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { serveClient } from '../fixtures.js';
import { projectKey, sessionPathsIn } from '../jsonl-session-store.js';
import { DEFAULT_LIVE_BASE_URL } from '../live-model.js';
import { runServe } from '../serve.js';
import type { RunningServe } from '../serve.js';
import { liveModelConfigSchema } from '../settings/live-model.js';
import { startCountingProxy } from '../smoke/counting-proxy.js';
import {
  SNAPSHOT_COMMON_ROWS,
  SNAPSHOT_THREAD_ID,
  driveScenario,
  loadScenario,
  readSnapshotLog,
  replaceHostPaths,
  scriptAlignmentProblem,
} from './harness.js';
import type { RecordedMeta } from './harness.js';

const { values, positionals } = parseArgs({
  options: {
    'env-dir': { type: 'string' },
    'reject-dir': { type: 'string' },
    cap: { type: 'string' },
  },
  allowPositionals: true,
});
const envDir = values['env-dir'];
const rejectDir = values['reject-dir'];
const cap = Number(values.cap);
if (
  envDir === undefined ||
  rejectDir === undefined ||
  !Number.isInteger(cap) ||
  cap <= 0 ||
  positionals.length === 0
) {
  throw new Error(
    '用法：record.ts --env-dir <放 .env 的目錄> --reject-dir <沒過的寫到哪> --cap <請求上限> <場景名…>',
  );
}
const cwd = resolve(envDir);

/**
 * 夾具裡不該有的：金鑰、授權標頭，與供應商錯誤本文裡的帳號（NVIDIA 的 404 帶 `for account '…'`）。
 * 刻意寬：誤中由人看，漏掉的進了版控就收不回來。
 */
const SECRET_LIKE = /Bearer|api[_-]?key|nvapi-|authorization|x-request-id|for account/iu;

const proxy = await startCountingProxy({ upstream: DEFAULT_LIVE_BASE_URL, cap });
const problems: string[] = [];
try {
  for (const name of positionals) {
    const scenario = await loadScenario(name);
    const temp = await mkdtemp(join(tmpdir(), 'nexus-snapshot-record-'));
    const before = proxy.forwardedPosts();
    try {
      const patch = join(temp, 'record.patch.yml');
      await writeFile(
        patch,
        `- id: live-model\n  config:\n    baseUrl: '${proxy.baseUrl}'\n${SNAPSHOT_COMMON_ROWS}${scenario.patchRows}`,
        'utf8',
      );
      const sessionRoot = join(temp, 'sessions');
      const running = (await runServe({
        argv: ['--port', '0', '--live', '--patch', patch, '--session-log', sessionRoot],
        cwd,
        log: () => undefined,
        env: { NEXUS_AGENT_HOME: join(temp, 'home') },
      })) as RunningServe;
      try {
        await driveScenario(await serveClient(running), scenario.input);
      } finally {
        await running.close();
      }

      const sessionDir = join(sessionRoot, projectKey(cwd));
      const paths = sessionPathsIn(sessionDir, SNAPSHOT_THREAD_ID);
      const forwardedPosts = proxy.forwardedPosts() - before;
      const meta: RecordedMeta = {
        modelId: liveModelConfigSchema.parse({ baseUrl: proxy.baseUrl }).modelId,
        recordedAt: new Date().toISOString(),
        forwardedPosts,
      };

      // 先核、再寫進場景目錄：沒過的不進版控的樹，寫到 `--reject-dir`（本機證據目錄）給人看。
      const { events } = await readSnapshotLog(sessionDir, SNAPSHOT_THREAD_ID);
      const found: string[] = [];
      const alignment = scriptAlignmentProblem(events);
      if (alignment !== undefined) found.push(alignment);
      const calls = events.filter((event) => event.type === 'model/start').length;
      if (calls !== forwardedPosts) {
        found.push(
          `代理轉出 ${String(forwardedPosts)} 個請求，日誌只有 ${String(calls)} 次模型呼叫`,
        );
      }
      if (events.some((event) => event.type === 'turn/failed')) {
        // 失敗訊息原樣帶著供應商的錯誤本文（可能有帳號識別碼），不進夾具。
        found.push('有一輪失敗了（turn/failed）');
      }
      const texts = [await readFile(paths.header, 'utf8'), await readFile(paths.log, 'utf8')];
      if (texts.some((text) => SECRET_LIKE.test(text))) found.push(`命中 ${String(SECRET_LIKE)}`);

      const targetDir = found.length === 0 ? scenario.dir : join(rejectDir, name);
      await mkdir(targetDir, { recursive: true });
      const target = sessionPathsIn(targetDir, SNAPSHOT_THREAD_ID);
      await writeFile(target.header, replaceHostPaths(texts[0]!, cwd), 'utf8');
      await writeFile(target.log, replaceHostPaths(texts[1]!, cwd), 'utf8');
      await writeFile(
        join(targetDir, 'recorded.json'),
        `${JSON.stringify(meta, null, 2)}\n`,
        'utf8',
      );
      for (const problem of found) problems.push(`${name}：${problem}`);
      console.log(
        `${name}：模型呼叫 ${String(calls)} 次、轉出 ${String(forwardedPosts)} 個請求，${meta.recordedAt}，寫到 ${targetDir}`,
      );
      if (found.length > 0) break;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
} finally {
  const statuses = proxy
    .requests()
    .map((request) => `${request.method} ${request.path} ${String(request.status)}`);
  console.log(
    `轉出 ${String(proxy.forwardedPosts())} / ${String(cap)}${proxy.overflowed() ? '（有請求被上限擋下）' : ''}`,
  );
  for (const line of statuses) console.log(`  ${line}`);
  await proxy.close();
}
if (proxy.overflowed()) problems.push('有請求被上限擋下');
if (problems.length > 0) throw new Error(`錄製有問題：\n${problems.join('\n')}`);
