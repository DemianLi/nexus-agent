/**
 * `@` 引用在產品路徑上（#651）：**真的 serve、真的 HTTP、出貨的組裝**，不手搭 `createAgent`。
 *
 * 手搭的組裝自己交 `workspaceRoot`，`createCliAgent` 回傳它、`serve.ts` 轉交它那兩行就沒有觀察點（同
 * `deliverable-files.test.ts` 那組「錨」量過的事）。所以列檔的每一條都從 `runServe` 起。
 *
 * 失效那一條用的是出貨的假模型腳本：它第二輪用 `write_file` 寫 {@link CLI_PROBE_FILE}，那就是「模型寫了新檔」。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BaseMessage } from '@langchain/core/messages';
import type { Event, WireClient } from '@nexus/wire';
import { createWireClient, fileReferencesPath } from '@nexus/wire';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLI_PROBE_FILE, createCliAgent, runTurn } from './cli.js';
import { FILE_REFERENCE_PROMPT } from './file-references.js';
import { exchangeServeToken, fetchWithCookie, serveClient, shippedPlugins } from './fixtures.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const shipped = await shippedPlugins();

let running: RunningServe | undefined;
const roots: string[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** 一份夾具工作區：根上一個資料夾、一個檔，資料夾裡一個檔。 */
async function workspace(): Promise<string> {
  const root = await directory('nexus-file-references-serve-');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'alpha.ts'), 'alpha');
  await writeFile(join(root, 'README.md'), 'readme');
  return root;
}

async function serve(argv: readonly string[], cwd?: string): Promise<RunningServe> {
  running = (await runServe({
    argv: ['--port', '0', ...argv],
    log: () => undefined,
    env: {},
    ...(cwd === undefined ? {} : { cwd }),
  })) as RunningServe;
  return running;
}

/** 列一次，拒絕就讓測試失敗。 */
async function candidates(client: WireClient, threadId: string, query: string) {
  const outcome = await client.fileReferences(threadId, query);
  if (outcome.kind !== 'ok') throw new Error(`列檔被拒：${outcome.message}`);
  if (!outcome.result.available) throw new Error('這台 server 說它不提供列檔');
  return outcome.result.candidates;
}

/** 讀下行到 root 那顆收尾的 `lifecycle` 為止。 */
async function untilRootSettles(events: AsyncGenerator<Event, void, undefined>): Promise<void> {
  for (;;) {
    const next = await events.next();
    if (next.done === true) throw new Error('下行在 root 收尾之前就斷了');
    const data = next.value.params.data as { event?: unknown; graph_name?: unknown } | null;
    if (
      next.value.method === 'lifecycle' &&
      next.value.params.namespace.length === 0 &&
      data?.graph_name === 'root' &&
      (data.event === 'completed' || data.event === 'failed')
    ) {
      return;
    }
  }
}

describe('真的 serve 上的列檔', () => {
  it('新對話在第一句之前就列得出來：空的列根目錄那一層，資料夾在前', async () => {
    const root = await workspace();
    const client = await serveClient(await serve(['--workspace', root]));

    expect(await candidates(client, 'never-spoken', '')).toEqual([
      { path: '/src', kind: 'directory' },
      { path: '/README.md', kind: 'file' },
    ]);
    // 開頭的 `/` 給不給是同一個查詢，兩種查法各一次。
    for (const query of ['src/', '/src/']) {
      expect(await candidates(client, 'never-spoken', query)).toEqual([
        { path: '/src/alpha.ts', kind: 'file' },
      ]);
    }
    for (const query of ['alp', '/alp']) {
      expect(await candidates(client, 'never-spoken', query)).toEqual([
        { path: '/src/alpha.ts', kind: 'file' },
      ]);
    }
    expect(await candidates(client, 'never-spoken', '../')).toEqual([]);
  });

  it('模型寫了新檔之後，root 的 tool/result 讓索引過期，下一次重建就查得到', async () => {
    const root = await workspace();
    const client = await serveClient(await serve(['--workspace', root]));
    const probe = CLI_PROBE_FILE.slice(1);
    const stem = probe.replace(/\.md$/u, '');

    // 先建好索引：這時候還沒有那個檔。
    expect(await candidates(client, 'writer', stem)).toEqual([]);

    const events = await client.openEvents('writer');
    await client.runStart('writer', '寫個檔。');
    await untilRootSettles(events);
    await events.return(undefined);
    // 量具先驗：檔真的落在工作區裡。
    expect(await readFile(join(root, probe), 'utf8')).toBe('CLI 寫的');

    // 過期的索引先照答、背景重建，所以用有界的重查等它換上，不 sleep。
    await vi.waitFor(async () => {
      expect(await candidates(client, 'writer', stem)).toContainEqual({
        path: CLI_PROBE_FILE,
        kind: 'file',
      });
    });
  });

  it('沒給 --workspace：回「不提供」，cwd 底下有檔也不列', async () => {
    const cwd = await workspace();
    const client = await serveClient(await serve([], cwd));
    for (const query of ['', 'READ', 'src/']) {
      expect(await client.fileReferences('bare', query)).toEqual({
        kind: 'ok',
        result: { available: false },
      });
    }
  });

  it('工作區根讀不到時，第一次裸查詢回協定層的錯，不是空清單', async () => {
    const root = await workspace();
    const client = await serveClient(await serve(['--workspace', root]));
    // 先把 thread 建起來，再拿掉根。
    await candidates(client, 'gone', '');
    await rm(root, { recursive: true, force: true });
    const outcome = await client.fileReferences('gone', 'READ');
    expect(outcome).toMatchObject({ kind: 'rejected' });
    expect(outcome.kind === 'rejected' && outcome.message).toContain('列不出檔案');
  });

  it('在認證的圍欄裡：沒有 cookie 回 401，Origin 不對回 403，不是 JSON 回 415，不是 GET 回 404', async () => {
    const root = await workspace();
    const server = await serve(['--workspace', root]);
    const url = `${server.url}${fileReferencesPath('fenced')}?query=`;
    const json = { 'content-type': 'application/json' };

    expect((await fetch(url, { headers: json })).status).toBe(401);
    const cookie = await exchangeServeToken(server.authenticatedUrl);
    const withCookie = fetchWithCookie(cookie);
    expect(
      (await withCookie(url, { headers: { ...json, origin: 'http://evil.example' } })).status,
    ).toBe(403);
    expect((await withCookie(url, {})).status).toBe(415);
    expect((await withCookie(url, { method: 'POST', headers: json, body: '{}' })).status).toBe(404);
    const ok = await withCookie(url, { headers: json });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });

  it('client 驗得出不認得的回應', async () => {
    const reply = (result: unknown) =>
      createWireClient({
        baseUrl: 'http://localhost',
        fetch: async () => Response.json({ type: 'success', result }),
      });
    await expect(
      reply({ available: true, candidates: [{ path: 'src', kind: 'file' }] }).fileReferences(
        't',
        '',
      ),
    ).rejects.toThrow('不認得的候選');
    await expect(reply({ available: true }).fileReferences('t', '')).rejects.toThrow(
      '不認得的結果',
    );
  });
});

/** 一輪 prompt 裡的 system 訊息，照 `sandbox-policy.test.ts` 的攤法：`content` 不一定是字串。 */
function systemPrompt(messages: readonly BaseMessage[]): string {
  const flatten = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(flatten).join('\n');
    if (content !== null && typeof content === 'object') {
      const text = (content as { text?: unknown }).text;
      return typeof text === 'string' ? text : JSON.stringify(content);
    }
    return String(content);
  };
  return messages
    .filter((message) => message.getType() === 'system')
    .map((message) => flatten(message.content))
    .join('\n');
}

describe('講給模型聽的那一句', () => {
  async function promptOf(invocation: {
    readonly workspace?: string;
  }): Promise<{ readonly prompt: string; readonly tools: readonly string[] }> {
    const cwd = await directory('nexus-file-references-prompt-');
    const { agent, dispose, model, sessionLog } = await createCliAgent(
      { live: false, ...invocation },
      shipped,
      cwd,
    );
    try {
      await runTurn(agent, '嗨。', { log: () => undefined, error: () => undefined }, sessionLog);
    } finally {
      await dispose();
    }
    const scripted = model as unknown as {
      readonly lastPrompt: readonly BaseMessage[];
      readonly boundToolNames: readonly string[];
    };
    return { prompt: systemPrompt(scripted.lastPrompt), tools: scripted.boundToolNames };
  }

  it('有工作區就講，位址從 / 寫起，工具名是這個組裝真的註冊的', async () => {
    const root = await workspace();
    const { prompt, tools } = await promptOf({ workspace: root });
    expect(prompt).toContain(FILE_REFERENCE_PROMPT);
    for (const tool of ['ls', 'read_file']) {
      expect(FILE_REFERENCE_PROMPT).toContain(tool);
      expect(tools).toContain(tool);
    }
    expect(FILE_REFERENCE_PROMPT).toContain('`/` 就是工作區根');
    expect(prompt).not.toContain(root);
  });

  it('沒有工作區就一個字都不講', async () => {
    expect((await promptOf({})).prompt).not.toContain('使用者明確引用的路徑');
  });
});
