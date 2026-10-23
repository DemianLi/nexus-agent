/**
 * 分叉的子 thread 讀繼承來的外溢檔（[#1580](https://github.com/DemianLi/nexus-agent/issues/1580) 第 6 點、Q1 (a)）的單元層：
 * 名單收得對不對、祖先鏈走得對不對、路由只把名單內的讀轉到祖先。產品路徑（真 `runServe`、重啟、再分叉）在
 * [`serve-fork-stash.test.ts`](./serve-fork-stash.test.ts)。
 */

import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolMessage } from '@langchain/core/messages';
import { SESSION_LOG_FORMAT_VERSION, toLoggedMessage } from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { TOOL_RESULT_STASH_PREFIX } from './agent-factory.js';
import { forkAncestors, inheritedStashNames } from './fork-stash.js';
import { createToolResultStash, stashSessionDirName } from './tool-result-stash.js';

/** 剛好越過基座逐出那條線（80,000 字元）。 */
const OVERSIZED = 'X'.repeat(80_001);

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { type, seq, time: seq, data } as unknown as SessionEvent;
}

function toolResult(seq: number, callId: string, name: string, content: string): SessionEvent {
  const message = new ToolMessage({ content, tool_call_id: callId, name });
  return event(seq, 'tool/result', {
    callId,
    isError: false,
    message: toLoggedMessage(message),
  });
}

const END_SEED = (seq: number): SessionEvent => event(seq, 'session/end-seed', { inherited: true });

describe('inheritedStashNames：分叉前綴裡出現過的暫存檔名', () => {
  it('基座逐出的照呼叫編號算（清洗過）；沒過門檻、基座不搬的工具不收', () => {
    const names = inheritedStashNames([
      toolResult(0, 'call.a/1', 'bulk', OVERSIZED),
      toolResult(1, 'call_small', 'bulk', 'X'.repeat(80_000)),
      toolResult(2, 'call_read', 'read_file', OVERSIZED),
      END_SEED(3),
    ]);
    expect([...names]).toEqual(['call_a_1.txt']);
  });

  it('外溢層與跨會話引用的定位從事件文字抓；句尾的句點去掉，不是 .txt 的不收', () => {
    const spill = `${TOOL_RESULT_STASH_PREFIX}/0123456789ab-bulk.txt`;
    const search = `${TOOL_RESULT_STASH_PREFIX}/0123456789ab-grep-results.txt`;
    const reference = `${TOOL_RESULT_STASH_PREFIX}/0123456789ab-session-reference-1.txt`;
    const names = inheritedStashNames([
      toolResult(0, 'c1', 'bulk', `預覽……全文在 ${spill}。`),
      toolResult(1, 'c2', 'grep', `命中太多，其餘在 ${search}.`),
      event(2, 'user/message', {
        source: { kind: 'session-reference' },
        message: { type: 'human', data: { content: `{"status":"saved","path":"${reference}"}` } },
      }),
      event(3, 'user/message', { text: `${TOOL_RESULT_STASH_PREFIX}/notes` }),
      END_SEED(4),
    ]);
    expect([...names].sort()).toEqual(
      [
        '0123456789ab-bulk.txt',
        '0123456789ab-grep-results.txt',
        '0123456789ab-session-reference-1.txt',
      ].sort(),
    );
  });

  it('只看繼承標記之前：分叉之後自己寫的不算；沒有標記（不是分叉來的）就是空的', () => {
    const after = toolResult(2, 'call_after', 'bulk', OVERSIZED);
    expect([
      ...inheritedStashNames([toolResult(0, 'call_before', 'bulk', OVERSIZED), END_SEED(1), after]),
    ]).toEqual(['call_before.txt']);
    expect(inheritedStashNames([toolResult(0, 'call_x', 'bulk', OVERSIZED)]).size).toBe(0);
  });

  it('從分叉來的 thread 再分叉：取最後一顆標記之前的整段，祖父那一代的也在', () => {
    const names = inheritedStashNames([
      toolResult(0, 'call_gp', 'bulk', OVERSIZED),
      END_SEED(1),
      toolResult(2, 'call_p', 'bulk', OVERSIZED),
      END_SEED(3),
    ]);
    expect([...names].sort()).toEqual(['call_gp.txt', 'call_p.txt']);
  });
});

function header(id: string, parent?: string, seeded = parent !== undefined): StoredSessionHeader {
  return {
    version: SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: 0,
    ...(parent !== undefined && { parentSession: parent }),
    ...(seeded && { isSeeded: true as const }),
  };
}

describe('forkAncestors：沿 header 往上找分叉來源', () => {
  const book = (headers: readonly StoredSessionHeader[]) => {
    const byId = new Map(headers.map((h) => [h.id, h]));
    return (id: string) => Promise.resolve(byId.get(id));
  };

  it('父、祖父，到不是分叉來的為止；子代理的 parentSession 不算', async () => {
    const warnings: string[] = [];
    const read = book([header('p', 'gp'), header('gp', 'agent-root', false)]);
    expect(await forkAncestors(header('c', 'p'), read, (m) => warnings.push(m))).toEqual([
      'p',
      'gp',
    ]);
    expect(await forkAncestors(header('sub', 'root', false), read, () => undefined)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('某一代讀不到 header：那一代留著、再往上不找，講一聲；找不到就停', async () => {
    const warnings: string[] = [];
    const broken = (id: string) =>
      id === 'p' ? Promise.reject(new Error('壞了')) : Promise.resolve(undefined);
    expect(await forkAncestors(header('c', 'p'), broken, (m) => warnings.push(m))).toEqual(['p']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('壞了');
    expect(await forkAncestors(header('c', 'gone'), book([]), () => undefined)).toEqual(['gone']);
  });

  it('繞回看過的 id 就停', async () => {
    const read = book([header('p', 'gp'), header('gp', 'c')]);
    expect(await forkAncestors(header('c', 'p'), read, () => undefined)).toEqual(['p', 'gp']);
  });
});

describe('StashRoute：名單內的讀轉到祖先，其餘留在自己', () => {
  async function seeded(files: Readonly<Record<string, Readonly<Record<string, string>>>>) {
    const root = await mkdtemp(join(tmpdir(), 'fork-stash-'));
    for (const [session, entries] of Object.entries(files)) {
      const dir = join(root, stashSessionDirName(session));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const [name, content] of Object.entries(entries)) {
        await writeFile(join(dir, name), content, { mode: 0o600 });
      }
    }
    return root;
  }

  it('讀名單內的檔：父有就讀父的，父沒有讀祖父的；readRaw 一樣', async () => {
    const root = await seeded({
      p: { 'call_p.txt': '父的原文' },
      gp: { 'call_gp.txt': '祖父的原文', 'call_p.txt': '祖父的同名檔' },
    });
    const route = createToolResultStash({
      rootDir: root,
      session: 'c',
      inherited: { names: new Set(['call_p.txt', 'call_gp.txt']), sessions: ['p', 'gp'] },
    });
    expect((await route.read('/call_p.txt')).content).toContain('父的原文');
    expect((await route.read('/call_gp.txt')).content).toContain('祖父的原文');
    expect(JSON.stringify((await route.readRaw('/call_gp.txt')).data)).toContain('祖父的原文');
  });

  it('自己的目錄有同名檔就讀自己的：祖先那份不蓋過子 thread 自己寫的', async () => {
    const root = await seeded({ c: { 'call_p.txt': '子自己的' }, p: { 'call_p.txt': '父的原文' } });
    const route = createToolResultStash({
      rootDir: root,
      session: 'c',
      inherited: { names: new Set(['call_p.txt']), sessions: ['p'] },
    });
    const content = (await route.read('/call_p.txt')).content;
    expect(content).toContain('子自己的');
    expect(content).not.toContain('父的原文');
  });

  it('不在名單內的不轉：祖先目錄裡有同名檔，照樣讀不到', async () => {
    const root = await seeded({ p: { 'later.txt': '分叉之後才寫的' } });
    const route = createToolResultStash({
      rootDir: root,
      session: 'c',
      inherited: { names: new Set(['call_p.txt']), sessions: ['p'] },
    });
    const result = await route.read('/later.txt');
    expect(result.error).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('分叉之後才寫的');
  });

  it('寫與改留在自己的目錄；祖先的檔不動，祖先沒有目錄也不替它建', async () => {
    const root = await seeded({ p: { 'call_p.txt': '父的原文' } });
    const route = createToolResultStash({
      rootDir: root,
      session: 'c',
      inherited: { names: new Set(['call_p.txt', 'call_gone.txt']), sessions: ['p', 'gp'] },
    });
    expect((await route.write('/mine.txt', '子自己的')).error).toBeUndefined();
    expect(await readdir(route.sessionDir)).toEqual(['mine.txt']);
    const edited = await route.edit('/call_p.txt', '父的', '子改的');
    expect(edited.error).toBeDefined();
    expect(await readFile(join(root, stashSessionDirName('p'), 'call_p.txt'), 'utf8')).toBe(
      '父的原文',
    );
    // 名單內、祖先都沒有：問自己（讀不到），不建祖父的目錄。
    expect((await route.read('/call_gone.txt')).error).toBeDefined();
    expect((await readdir(root)).sort()).toEqual(
      [stashSessionDirName('c'), stashSessionDirName('p')].sort(),
    );
    // 子 thread 自己寫了那個名字：祖先都沒有，讀回來的是自己那份。
    expect((await route.write('/call_gone.txt', '子自己寫的同名檔')).error).toBeUndefined();
    expect((await route.read('/call_gone.txt')).content).toContain('子自己寫的同名檔');
  });

  it('沒給 inherited（不是分叉來的）：同名檔在別的會話目錄裡也讀不到', async () => {
    const root = await seeded({ p: { 'call_p.txt': '父的原文' } });
    const route = createToolResultStash({ rootDir: root, session: 'c' });
    expect((await route.read('/call_p.txt')).error).toBeDefined();
  });
});
