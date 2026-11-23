/**
 * 嵌入換票的稽核紀錄（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)）：一行一筆、`0600`、權限過寬拒開、憑證錯的請求按時間窗合併。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openEmbedAudit, UNAUTHENTICATED_WINDOW_MS } from './embed-audit.js';

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function auditFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-embed-audit-'));
  temporary.push(dir);
  return join(dir, 'embed-audit.jsonl');
}

function lines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('openEmbedAudit', () => {
  it('沒有就建 0600；一筆一行，帶版本與時間', async () => {
    const file = auditFile();
    const audit = await openEmbedAudit(file, { now: () => Date.UTC(2026, 10, 6) });
    await audit.recordExchange({
      outcome: 'issued',
      embedder: 'crm',
      subject: 'alice',
      userId: 'u-alice',
      sessionIdSha256: 'abc',
    });
    await audit.close();
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(lines(file)).toEqual([
      {
        v: 1,
        at: '2026-11-06T00:00:00.000Z',
        event: 'exchange',
        outcome: 'issued',
        embedder: 'crm',
        subject: 'alice',
        userId: 'u-alice',
        sessionIdSha256: 'abc',
      },
    ]);
  });

  it('接著舊檔寫，不覆寫', async () => {
    const file = auditFile();
    writeFileSync(file, '{"v":1,"old":true}\n', { mode: 0o600 });
    const audit = await openEmbedAudit(file);
    await audit.recordExchange({ outcome: 'bad_request', embedder: 'crm', reason: 'body_json' });
    await audit.close();
    expect(lines(file)).toHaveLength(2);
    expect(lines(file)[0]).toEqual({ v: 1, old: true });
  });

  it.skipIf(process.platform === 'win32')('已存在的檔權限過寬：拒開，訊息指名檔案', async () => {
    const file = auditFile();
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    await expect(openEmbedAudit(file)).rejects.toThrow(file);
  });

  it('憑證錯的請求：一個時間窗裡第一次照記，其餘合併成一行加次數', async () => {
    const file = auditFile();
    let now = Date.UTC(2026, 10, 6);
    const audit = await openEmbedAudit(file, { now: () => now });
    for (let i = 0; i < 500; i += 1) {
      audit.recordUnauthenticated();
      now += 10;
    }
    // 時間窗過了之後再一次：先把前一窗計到的寫掉，再開新的一窗。
    now += UNAUTHENTICATED_WINDOW_MS;
    audit.recordUnauthenticated();
    await audit.close();
    const written = lines(file);
    expect(written.map((line) => line.count)).toEqual([1, 499, 1]);
    expect(written[1]).toMatchObject({
      outcome: 'unauthenticated',
      from: '2026-11-06T00:00:00.000Z',
      to: new Date(Date.UTC(2026, 10, 6) + 499 * 10).toISOString(),
    });
  });

  it('收尾時把還沒寫的合併計數寫掉', async () => {
    const file = auditFile();
    const audit = await openEmbedAudit(file);
    audit.recordUnauthenticated();
    audit.recordUnauthenticated();
    audit.recordUnauthenticated();
    await audit.close();
    expect(lines(file).map((line) => line.count)).toEqual([1, 2]);
  });

  it('關了之後再記：recordExchange reject，recordUnauthenticated 不動檔', async () => {
    const file = auditFile();
    const audit = await openEmbedAudit(file);
    await audit.close();
    await expect(audit.recordExchange({ outcome: 'issued', embedder: 'crm' })).rejects.toThrow();
    audit.recordUnauthenticated();
    expect(readFileSync(file, 'utf8')).toBe('');
  });
});
