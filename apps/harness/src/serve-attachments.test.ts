/**
 * **在真的 serve 上：上傳一份檔案，模型用 `read_file` 讀得到它**——[#732](https://github.com/DemianLi/nexus-agent/issues/732)
 * 第一張的產品路徑驗收（`attachment-upload.test.ts` 量的是 handler＋agent 的組合，這一檔量 `serve.ts` 的接線）。
 *
 * 做法同 `serve-scripted-provider.test.ts`：patch 換掉模型提供者，其餘全是真的——`runServe` 讀 `NEXUS_AGENT_HOME`、
 * 把附件儲存交給 wire handler 與每條 thread 的 agent、真的 wire client 上傳、真的 `read_file`。
 *
 * 突變：`serve.ts` 刪掉 `attachments: attachmentStore,`（agent 那一格）→ 「模型讀得到」紅；刪掉 handler 那一格 → 上傳回 `not_supported`。
 *
 * **零憑證、零外部連線**：模型是腳本，home 與工作區都是暫存目錄（放 `/var/tmp`）。
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { attachmentsRootOf } from './attachment-store.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const THREAD = 'serve-attachments';
const SECRET = 'MURASAKI-7391';
const TEXT = `${SECRET}\n第二行\n`;

const roots: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join('/var/tmp', prefix));
  roots.push(dir);
  return dir;
}

/** 起一台 serve：腳本模型第一輪 `read_file` 讀 `readPath`，第二輪收尾。 */
async function startServe(home: string, readPath: string): Promise<RunningServe> {
  const workspace = await scratch('nexus-serve-att-ws-');
  const patch = join(workspace, '..', `${workspace.split('/').pop()}.patch.yml`);
  roots.push(patch);
  await writeFile(
    patch,
    `- insert:
    - id: probe-script
      name: '#settings/scripted-model'
      config:
        turns:
          - content: ''
            toolCalls:
              - { name: read_file, args: { file_path: ${JSON.stringify(readPath)} } }
          - content: '讀完了。'
- id: agent-default-model
  config:
    provider: probe-script
`,
    'utf8',
  );
  return (await runServe({
    argv: ['--port', '0', '--workspace', workspace, '--patch', patch],
    log: () => undefined,
    env: { [HARNESS_HOME_ENV]: home },
  })) as RunningServe;
}

describe('serve：上傳的檔案存進 NEXUS_AGENT_HOME，模型讀得到', () => {
  it('收據、檔案落在 home/attachments、唯讀；模型用虛擬路徑 read_file 讀回暗號', async () => {
    const home = await scratch('nexus-serve-att-home-');
    const digest = createHash('sha256').update(TEXT).digest('hex');
    const modelPath = `/attachments/${digest.slice(0, 2)}/${digest}/notes.txt`;
    running = await startServe(home, modelPath);

    const client = await serveClient(running);
    const uploaded = await client.uploadFile(THREAD, new TextEncoder().encode(TEXT), 'notes.txt');
    // 前提：上傳真的被收下了（server 沒接附件儲存的話是 not_supported）。
    expect(uploaded).toMatchObject({ kind: 'ok', receipt: { name: 'notes.txt' } });
    const stored = join(attachmentsRootOf(home), 'files', digest.slice(0, 2), digest, 'notes.txt');
    expect((await stat(stored)).mode & 0o777).toBe(0o400);

    const events = await client.openEvents(THREAD);
    await client.runStart(THREAD, '讀那份檔案。');
    const state = await foldTurn(events);
    await events.return?.(undefined);
    // 暗號出現在線上的對話裡 ＝ 模型的 read_file 讀到了上傳的檔。
    expect(JSON.stringify(state.entries)).toContain(SECRET);
  }, 60000);
});
