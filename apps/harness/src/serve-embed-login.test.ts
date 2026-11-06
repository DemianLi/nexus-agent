/**
 * 嵌入換票**從 `runServe` 起量**（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）：設定列 → `startupSetting` → 憑證檔 →
 * 稽核檔 → `routeBySurface` → 啟動披露 → 收尾。處理器本身在 `embed-login.test.ts`。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { EMBED_AUDIT_FILE } from './embed-audit.js';
import { EMBED_IDENTITIES_FILE } from './embed-identities.js';
import { EMBED_EXCHANGE_PATH } from './embed-login.js';
import type { EmbedIdentityResolver } from './embed-login.js';
import { EMBED_SESSION_PATH } from './embed-session.js';
import { bodyLog, exchangeServeToken } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CRM_ROW = [
  '- id: embed-login',
  '  config:',
  '    embedders:',
  '      - id: crm',
  '    ticketTtlSeconds: 60',
];

const ALICE_TABLE = {
  version: 1,
  mappings: [{ embedder: 'crm', subject: 'alice', userId: 'alice' }],
};

/**
 * @param rows - patch 的內容。
 * @param identities - 有列時寫進 home 的對應表（0600）；`null` 不寫。
 */
function layout(rows: string[] = [], identities: unknown = ALICE_TABLE) {
  const base = mkdtempSync(join(tmpdir(), 'nexus-embed-login-'));
  chmodSync(base, 0o700);
  temporary.push(base);
  const home = join(base, 'home');
  const cwd = join(base, 'project');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd);
  const patch = join(base, 'patch.yml');
  writeFileSync(patch, rows.length === 0 ? '[]\n' : `${rows.join('\n')}\n`);
  if (rows.length > 0 && identities !== null) {
    writeFileSync(join(home, EMBED_IDENTITIES_FILE), JSON.stringify(identities), { mode: 0o600 });
  }
  return { home, cwd, patch };
}

async function start(
  where: ReturnType<typeof layout>,
  lines: string[] = [],
  embedIdentity?: EmbedIdentityResolver,
): Promise<RunningServe> {
  running = (await runServe({
    argv: ['--port', '0', '--patch', where.patch],
    log: bodyLog(lines),
    env: { [HARNESS_HOME_ENV]: where.home },
    cwd: where.cwd,
    ...(embedIdentity !== undefined && { embedIdentity }),
  })) as RunningServe;
  return running;
}

function post(server: RunningServe, headers: Record<string, string>): Promise<Response> {
  return fetch(`${server.url}${EMBED_EXCHANGE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ subject: 'alice', sessionId: 's-1' }),
  });
}

async function auditLines(home: string): Promise<Record<string, unknown>[]> {
  return (await readFile(join(home, EMBED_AUDIT_FILE), 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('出廠（沒有嵌入方）', () => {
  it('沒有換票的路由、不建憑證檔與稽核檔；啟動披露講關', async () => {
    const where = layout();
    const lines: string[] = [];
    const server = await start(where, lines);
    const response = await post(server, { authorization: `Bearer ${'x'.repeat(43)}` });
    expect(response.status).not.toBe(200);
    expect(response.headers.get('content-type') ?? '').not.toContain('application/json');
    expect(() => statSync(join(where.home, EMBED_AUDIT_FILE))).toThrow();
    expect(() => statSync(join(where.home, 'embed-credential-crm'))).toThrow();
    expect(lines).toContain('嵌入換票：關（embed-login 沒有嵌入方）');
  });
});

describe('有嵌入方', () => {
  it('憑證檔沒有就建 0600；擁有者隔離上線之前，表上有的人憑證對也一律 403，記進稽核', async () => {
    const where = layout(CRM_ROW);
    const lines: string[] = [];
    const server = await start(where, lines);
    const credentialFile = join(where.home, 'embed-credential-crm');
    if (process.platform !== 'win32') expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
    const credential = (await readFile(credentialFile, 'utf8')).trim();
    expect(
      lines.some((line) => line.startsWith('嵌入換票：開 POST /embed/exchange（嵌入方 crm')),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.endsWith(
          `身分對應表 ${join(where.home, EMBED_IDENTITIES_FILE)}（1 筆）；對話的擁有者隔離還沒上，換票一律拒絕`,
        ),
      ),
    ).toBe(true);
    expect(lines.join('\n')).not.toContain(credential);

    expect((await post(server, { authorization: `Bearer ${'x'.repeat(43)}` })).status).toBe(401);
    const rejected = await post(server, { authorization: `Bearer ${credential}` });
    expect(rejected.status).toBe(403);

    await running!.close();
    running = undefined;
    const written = await auditLines(where.home);
    expect(written.map((line) => line.outcome)).toEqual(['unauthenticated', 'identity_rejected']);
    expect(written[1]).toMatchObject({
      embedder: 'crm',
      subject: 'alice',
      reason: 'identity_mapping_unavailable',
    });
    expect(JSON.stringify(written)).not.toContain(credential);
  });

  it('有嵌入方、沒有對應表：起不來，訊息指名表檔，不替管理者建', async () => {
    const where = layout(CRM_ROW, null);
    const file = join(where.home, EMBED_IDENTITIES_FILE);
    await expect(start(where)).rejects.toThrow(`${file} 不存在`);
    expect(() => statSync(file)).toThrow();
  });

  it('對應表不合規：起不來，訊息指名第幾筆、不帶 subject', async () => {
    const where = layout(CRM_ROW, {
      version: 1,
      mappings: [{ embedder: 'hr', subject: 'secret-subject', userId: 'alice' }],
    });
    const failure = start(where);
    await expect(failure).rejects.toThrow(/第 1 筆的 embedder/u);
    await expect(failure).rejects.not.toThrow(/secret-subject/u);
  });

  it.skipIf(process.platform === 'win32')('對應表權限過寬：起不來', async () => {
    const where = layout(CRM_ROW);
    const file = join(where.home, EMBED_IDENTITIES_FILE);
    chmodSync(file, 0o644);
    await expect(start(where)).rejects.toThrow(file);
  });

  it('身分對應接上之後發票', async () => {
    const where = layout(CRM_ROW);
    const server = await start(where, [], {
      resolve: () => ({ kind: 'accepted', userId: 'u-alice' }),
    });
    const credential = (await readFile(join(where.home, 'embed-credential-crm'), 'utf8')).trim();
    const response = await post(server, { authorization: `Bearer ${credential}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ticket: expect.any(String) });
  });

  it('獨立頁面的會話 cookie 換不到票', async () => {
    const where = layout(CRM_ROW);
    const server = await start(where, [], {
      resolve: () => ({ kind: 'accepted', userId: 'u-alice' }),
    });
    const cookie = await exchangeServeToken(server.authenticatedUrl);
    expect((await post(server, { cookie })).status).toBe(401);
  });

  it('明寫的憑證檔撞到別的嵌入方的預設檔：起不來，不建任何憑證檔', async () => {
    const where = layout();
    const shared = join(where.home, 'embed-credential-crm');
    writeFileSync(
      where.patch,
      [
        '- id: embed-login',
        '  config:',
        '    embedders:',
        '      - id: crm',
        '      - id: erp',
        `        credentialFile: ${shared}`,
        '',
      ].join('\n'),
    );
    await expect(start(where)).rejects.toThrow(
      /嵌入方 crm 的服務憑證檔與嵌入方 erp 的服務憑證檔指到同一個檔/u,
    );
    expect(() => statSync(shared)).toThrow();
  });

  it('憑證檔撞到指標的 token 檔：起不來', async () => {
    const where = layout();
    const shared = join(where.home, 'shared-token');
    writeFileSync(
      where.patch,
      [
        '- id: ops-endpoints',
        '  config:',
        '    metrics:',
        '      enabled: true',
        `      tokenFile: ${shared}`,
        '- id: embed-login',
        '  config:',
        '    embedders:',
        '      - id: crm',
        `        credentialFile: ${shared}`,
        '',
      ].join('\n'),
    );
    await expect(start(where)).rejects.toThrow(/指到同一個檔/u);
  });

  it.skipIf(process.platform === 'win32')('憑證檔權限過寬：起不來，訊息指名檔案', async () => {
    const where = layout(CRM_ROW);
    const credentialFile = join(where.home, 'embed-credential-crm');
    writeFileSync(credentialFile, `${'a'.repeat(43)}\n`);
    chmodSync(credentialFile, 0o644);
    await expect(start(where)).rejects.toThrow(credentialFile);
  });
});

describe('兌換成嵌入 cookie（POST /embed/session）', () => {
  const alice: EmbedIdentityResolver = { resolve: () => ({ kind: 'accepted', userId: 'u-alice' }) };

  async function embedCookie(server: RunningServe, home: string): Promise<string> {
    const credential = (await readFile(join(home, 'embed-credential-crm'), 'utf8')).trim();
    const exchanged = await post(server, { authorization: `Bearer ${credential}` });
    const { ticket } = (await exchanged.json()) as { ticket: string };
    const redeemed = await fetch(`${server.url}${EMBED_SESSION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect(redeemed.status).toBe(200);
    return redeemed.headers.get('set-cookie')!.split(';', 1)[0]!;
  }

  function get(server: RunningServe, path: string, cookie?: string): Promise<Response> {
    return fetch(`${server.url}${path}`, {
      redirect: 'manual',
      headers: { origin: server.url, ...(cookie !== undefined && { cookie }) },
    });
  }

  function upgrade(server: RunningServe, path: string, cookie: string): Promise<number> {
    const socket = new WebSocket(`${server.url.replace(/^http/u, 'ws')}${path}`, {
      headers: { origin: server.url, cookie },
    });
    return new Promise((resolve) => {
      socket.once('open', () => {
        socket.close();
        resolve(101);
      });
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
      });
      socket.once('error', () => {
        resolve(0);
      });
    });
  }

  const EMBED_HISTORY = '/embed/threads/t-none/history';

  it('嵌入 cookie 只打得到 /embed/…：獨立頁面、列表、非嵌入的 mux 都是 401', async () => {
    const where = layout(CRM_ROW);
    const lines: string[] = [];
    const server = await start(where, lines, alice);
    expect(
      lines.some((line) => line.includes(`兌換 POST ${EMBED_SESSION_PATH}，嵌入 cookie 900 秒`)),
    ).toBe(true);
    const cookie = await embedCookie(server, where.home);

    expect((await get(server, EMBED_HISTORY)).status).toBe(401);
    expect((await get(server, EMBED_HISTORY, cookie)).status).not.toBe(401);
    expect(await upgrade(server, '/embed/threads/mux', cookie)).toBe(101);

    expect((await get(server, '/threads', cookie)).status).toBe(401);
    expect((await get(server, '/', cookie)).status).toBe(401);
    expect((await get(server, '/index.html', cookie)).status).toBe(401);
    expect(await upgrade(server, '/threads/mux', cookie)).toBe(401);
  });

  it('獨立頁面的 cookie 照舊：獨立頁面與嵌入路由都打得到', async () => {
    const where = layout(CRM_ROW);
    const server = await start(where, [], alice);
    const cookie = await exchangeServeToken(server.authenticatedUrl);
    expect((await get(server, '/threads', cookie)).status).not.toBe(401);
    expect((await get(server, EMBED_HISTORY, cookie)).status).not.toBe(401);
  });

  it('續期：再換一張票兌換，同名 cookie 換新值，新的那顆打得到', async () => {
    const where = layout(CRM_ROW);
    const server = await start(where, [], alice);
    const first = await embedCookie(server, where.home);
    const second = await embedCookie(server, where.home);
    expect(second.split('=', 1)[0]).toBe(first.split('=', 1)[0]);
    expect((await get(server, EMBED_HISTORY, second)).status).not.toBe(401);

    await running!.close();
    running = undefined;
    expect((await auditLines(where.home)).filter((line) => line.event === 'redeem')).toHaveLength(
      2,
    );
  });

  it('沒有嵌入方：沒有兌換的路由', async () => {
    const where = layout();
    const server = await start(where);
    const response = await fetch(`${server.url}${EMBED_SESSION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'x' }),
    });
    expect(response.headers.get('content-type') ?? '').not.toContain('application/json');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
