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

import { EMBED_AUDIT_FILE } from './embed-audit.js';
import { EMBED_EXCHANGE_PATH } from './embed-login.js';
import type { EmbedIdentityResolver } from './embed-login.js';
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

function layout(rows: string[] = []) {
  const base = mkdtempSync(join(tmpdir(), 'nexus-embed-login-'));
  chmodSync(base, 0o700);
  temporary.push(base);
  const home = join(base, 'home');
  const cwd = join(base, 'project');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd);
  const patch = join(base, 'patch.yml');
  writeFileSync(patch, rows.length === 0 ? '[]\n' : `${rows.join('\n')}\n`);
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
  it('憑證檔沒有就建 0600；身分對應沒接上時，憑證對也一律 403，記進稽核', async () => {
    const where = layout(CRM_ROW);
    const lines: string[] = [];
    const server = await start(where, lines);
    const credentialFile = join(where.home, 'embed-credential-crm');
    if (process.platform !== 'win32') expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
    const credential = (await readFile(credentialFile, 'utf8')).trim();
    expect(
      lines.some((line) => line.startsWith('嵌入換票：開 POST /embed/exchange（嵌入方 crm')),
    ).toBe(true);
    expect(lines.some((line) => line.endsWith('身分對應尚未接上，一律拒絕'))).toBe(true);
    expect(lines.join('\n')).not.toContain(credential);

    expect((await post(server, { authorization: `Bearer ${'x'.repeat(43)}` })).status).toBe(401);
    const rejected = await post(server, { authorization: `Bearer ${credential}` });
    expect(rejected.status).toBe(403);

    await running!.close();
    running = undefined;
    const written = await auditLines(where.home);
    expect(written.map((line) => line.outcome)).toEqual(['unauthenticated', 'identity_rejected']);
    expect(written[1]).toMatchObject({ embedder: 'crm', subject: 'alice' });
    expect(JSON.stringify(written)).not.toContain(credential);
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
