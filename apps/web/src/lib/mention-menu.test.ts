import type {
  FileReferenceCandidate,
  FileReferenceListOutcome,
  SessionReferenceCandidate,
  SessionReferenceListOutcome,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  MENTION_MENU_CLOSED,
  mentionMenuOpen,
  mentionPickable,
  mentionRowKey,
  reduceMentionMenu,
} from '@/lib/mention-menu';
import type { MentionMenuEvent, MentionMenuState } from '@/lib/mention-menu';

/** `@` 選單的非同步狀態（#653），照 dsh `menuReduce`。 */

const file = (path: string): FileReferenceCandidate => ({ path, kind: 'file' });
const ok = (...candidates: FileReferenceCandidate[]): FileReferenceListOutcome => ({
  kind: 'ok',
  result: { available: true, candidates },
});
const hit = (generation: number): MentionMenuEvent => ({ type: 'hit', generation });
const settled = (generation: number, outcome: FileReferenceListOutcome): MentionMenuEvent => ({
  type: 'settled',
  generation,
  outcome,
  quoted: false,
});
const run = (...events: MentionMenuEvent[]): MentionMenuState =>
  events.reduce(reduceMentionMenu, MENTION_MENU_CLOSED);
const names = (state: MentionMenuState) => state.rows.map((row) => row.name);

describe('查詢與結果', () => {
  it('第一次回來之前不畫：還不知道有沒有工作區', () => {
    const state = run(hit(1));
    expect(state.status).toBe('pending');
    expect(mentionMenuOpen(state)).toBe(false);
    expect(mentionMenuOpen(run(hit(1), settled(1, ok(file('/a.ts')))))).toBe(true);
  });

  it('知道有工作區之後，一查就畫（沒有列就畫骨架）', () => {
    const state = run(hit(1), settled(1, ok(file('/a.ts'))), { type: 'close' }, hit(2));
    expect(mentionMenuOpen(state)).toBe(true);
    expect(state.rows).toHaveLength(0);
  });

  it('號不對的結果丟掉：打得快時只畫最後一次', () => {
    const state = run(hit(1), hit(2), settled(1, ok(file('/old.ts'))));
    expect(state.rows).toHaveLength(0);
    expect(names(reduceMentionMenu(state, settled(2, ok(file('/new.ts')))))).toEqual(['new.ts']);
  });

  it('查詢變了先留著舊的列、選中的那一列不動；還沒回來時選不到', () => {
    let state = run(hit(1), settled(1, ok(file('/a.ts'), file('/b.ts'))), { type: 'move', dir: 1 });
    expect(mentionPickable(state)?.name).toBe('b.ts');
    state = reduceMentionMenu(state, hit(2));
    expect(names(state)).toEqual(['a.ts', 'b.ts']);
    expect(state.highlight).toBe(1);
    expect(mentionPickable(state)).toBeUndefined();
    state = reduceMentionMenu(state, settled(2, ok(file('/c.ts'))));
    expect(mentionPickable(state)?.name).toBe('c.ts');
  });

  it('回來是空的、或被拒、或拋錯，就收起來', () => {
    expect(run(hit(1), settled(1, ok())).status).toBe('closed');
    expect(run(hit(1), settled(1, { kind: 'rejected', message: '起不來' })).status).toBe('closed');
    expect(run(hit(1), { type: 'failed', generation: 1 }).status).toBe('closed');
  });

  it('伺服器說沒有工作區：記住，之後一律不開', () => {
    const state = run(hit(1), settled(1, { kind: 'ok', result: { available: false } }), hit(2));
    expect(state.availability.file).toBe('unavailable');
    expect(state.status).toBe('closed');
    expect(mentionMenuOpen(state)).toBe(false);
  });

  it('收起來之後晚到的結果不會把它打開', () => {
    const state = run(hit(1), { type: 'close' }, settled(1, ok(file('/a.ts'))));
    expect(state.status).toBe('closed');
  });
});

describe('鍵盤', () => {
  it('上下循環', () => {
    const three = run(hit(1), settled(1, ok(file('/a'), file('/b'), file('/c'))));
    expect(reduceMentionMenu(three, { type: 'move', dir: -1 }).highlight).toBe(2);
    const last = run(hit(1), settled(1, ok(file('/a'), file('/b'))), { type: 'move', dir: 1 });
    expect(reduceMentionMenu(last, { type: 'move', dir: 1 }).highlight).toBe(0);
  });
});

/** 兩個來源（#713）：檔案、會話與子代理，各回各的、各記各的可不可用。 */
describe('兩個來源', () => {
  const session = (
    sessionId: string,
    extra: Partial<SessionReferenceCandidate> = {},
  ): SessionReferenceCandidate => ({
    sessionId,
    label: sessionId,
    sameWorkspace: true,
    createdAt: 1,
    updatedAt: 2,
    mention: `@[${sessionId}](nexus-session:x)`,
    ...extra,
  });
  const sessionsOk = (...candidates: SessionReferenceCandidate[]): SessionReferenceListOutcome => ({
    kind: 'ok',
    result: { available: true, candidates },
  });
  const both = (generation: number): MentionMenuEvent => ({
    type: 'hit',
    generation,
    sources: ['file', 'session'],
  });
  const sessionSettled = (
    generation: number,
    outcome: SessionReferenceListOutcome,
  ): MentionMenuEvent => ({ type: 'settled', generation, source: 'session', outcome });
  const keys = (state: MentionMenuState) => state.rows.map((row) => mentionRowKey(row));

  it('三段照檔案、會話、子代理排，不管誰先回來', () => {
    const sub = session('sub', { parentSessionId: 'root', parentLabel: '母' });
    const state = run(
      both(1),
      sessionSettled(1, sessionsOk(sub, session('s1'))),
      settled(1, ok(file('/a.ts'))),
    );
    expect(keys(state)).toEqual(['file:/a.ts', 'session:s1', 'session:sub']);
    expect(state.rows.map((row) => row.source)).toEqual(['file', 'session', 'subagent']);
  });

  it('先回來的先畫：檔案不等會話', () => {
    const state = run(both(1), settled(1, ok(file('/a.ts'))));
    expect(state.status).toBe('ready');
    expect(keys(state)).toEqual(['file:/a.ts']);
    expect(mentionPickable(state)?.source).toBe('file');
  });

  it('後回來的那一段併進去，選中的那一列跟著自己走', () => {
    let state = run(both(1), sessionSettled(1, sessionsOk(session('s1'), session('s2'))));
    state = reduceMentionMenu(state, { type: 'move', dir: 1 });
    expect(mentionPickable(state)).toMatchObject({ candidate: { sessionId: 's2' } });
    // 檔案晚到、插在上面：選中的仍是 s2，不是掉到別列。
    state = reduceMentionMenu(state, settled(1, ok(file('/a.ts'), file('/b.ts'))));
    expect(keys(state)).toEqual(['file:/a.ts', 'file:/b.ts', 'session:s1', 'session:s2']);
    expect(mentionPickable(state)).toMatchObject({ candidate: { sessionId: 's2' } });
  });

  it('一個來源可用另一個沒有：選單照開', () => {
    const state = run(
      both(1),
      settled(1, { kind: 'ok', result: { available: false } }),
      sessionSettled(1, sessionsOk(session('s1'))),
    );
    expect(state.availability).toEqual({
      file: 'unavailable',
      session: 'available',
      agent: 'unknown',
    });
    expect(mentionMenuOpen(state)).toBe(true);
    expect(keys(state)).toEqual(['session:s1']);
  });

  it('會話不可用（沒接落盤）、檔案照開；之後只問檔案', () => {
    let state = run(
      both(1),
      sessionSettled(1, { kind: 'ok', result: { available: false } }),
      settled(1, ok(file('/a.ts'))),
    );
    expect(state.availability.session).toBe('unavailable');
    expect(keys(state)).toEqual(['file:/a.ts']);
    state = reduceMentionMenu(state, both(2));
    expect(state.asked).toEqual(['file']);
  });

  it('兩個來源都不可用才整個不開，之後也不再問', () => {
    let state = run(
      both(1),
      settled(1, { kind: 'ok', result: { available: false } }),
      sessionSettled(1, { kind: 'ok', result: { available: false } }),
    );
    expect(state.status).toBe('closed');
    expect(mentionMenuOpen(state)).toBe(false);
    state = reduceMentionMenu(state, both(2));
    expect(state.status).toBe('closed');
    expect(state.generation).toBe(1);
  });

  it('兩邊都回來了、都沒有列：收起來；只回來一邊空的還在等', () => {
    let state = run(both(1), settled(1, ok(file('/a.ts'))), { type: 'close' }, both(2));
    state = reduceMentionMenu(state, settled(2, ok()));
    expect(state.status).toBe('pending');
    state = reduceMentionMenu(state, sessionSettled(2, sessionsOk()));
    expect(state.status).toBe('closed');
  });

  it('一邊失敗不拖累另一邊', () => {
    const state = run(
      both(1),
      { type: 'failed', generation: 1, source: 'session' },
      settled(1, ok(file('/a.ts'))),
    );
    expect(keys(state)).toEqual(['file:/a.ts']);
    expect(state.availability.session).toBe('unknown');
  });

  it('會話那邊被伺服器拒絕（讀不了存放處）：當作沒有，不記成不可用', () => {
    const state = run(
      both(1),
      sessionSettled(1, { kind: 'rejected', message: '讀不了' }),
      settled(1, ok(file('/a.ts'))),
    );
    expect(state.availability.session).toBe('unknown');
    expect(keys(state)).toEqual(['file:/a.ts']);
  });

  it('過期的會話結果丟掉', () => {
    const state = run(both(1), both(2), sessionSettled(1, sessionsOk(session('old'))));
    expect(state.rows).toHaveLength(0);
    expect(state.arrived).toEqual({});
  });

  it('新一號來了先留著舊列、選中的不動；第一個新結果回來整批換掉', () => {
    let state = run(both(1), settled(1, ok(file('/a.ts'), file('/b.ts'))), {
      type: 'move',
      dir: 1,
    });
    state = reduceMentionMenu(state, both(2));
    expect(keys(state)).toEqual(['file:/a.ts', 'file:/b.ts']);
    expect(state.highlight).toBe(1);
    expect(mentionPickable(state)).toBeUndefined();
    state = reduceMentionMenu(state, sessionSettled(2, sessionsOk(session('s1'), session('s2'))));
    expect(keys(state)).toEqual(['session:s1', 'session:s2']);
    expect(state.highlight).toBe(1);
  });

  it('只有檔案時 hit 不帶 sources 也照舊只問檔案', () => {
    expect(run(hit(1)).asked).toEqual(['file']);
  });
});

describe('委派給（#328，同步來源）', () => {
  const keys = (state: MentionMenuState) => state.rows.map((row) => mentionRowKey(row));
  const sessionCandidate = (sessionId: string): SessionReferenceCandidate => ({
    sessionId,
    label: sessionId,
    sameWorkspace: true,
    createdAt: 1,
    updatedAt: 2,
    mention: `@[${sessionId}](nexus-session:x)`,
  });
  const agentRow = (id: string, name = id) => ({
    source: 'agent' as const,
    agent: { id, name, description: '' },
    name,
    hint: '',
  });
  const agentHit = (generation: number): MentionMenuEvent => ({
    type: 'hit',
    generation,
    sources: ['agent'],
  });
  const agentSettled = (generation: number, ...ids: string[]): MentionMenuEvent => ({
    type: 'settled',
    generation,
    source: 'agent',
    rows: ids.map((id) => agentRow(id)),
  });

  it('只問委派給時，一回來選單就開（不需要檔案或會話確定可用）', () => {
    const state = run(agentHit(1), agentSettled(1, 'a', 'b'));
    expect(mentionMenuOpen(state)).toBe(true);
    expect(state.availability).toEqual({ file: 'unknown', session: 'unknown', agent: 'available' });
    expect(keys(state)).toEqual(['agent:a', 'agent:b']);
  });

  it('與檔案、會話一起問：委派給排最上面，段內照給的先後', () => {
    const state = run(
      { type: 'hit', generation: 1, sources: ['file', 'session', 'agent'] },
      settled(1, ok(file('/a.ts'))),
      {
        type: 'settled',
        generation: 1,
        source: 'session',
        outcome: { kind: 'ok', result: { available: true, candidates: [sessionCandidate('s1')] } },
      },
      agentSettled(1, 'x'),
    );
    expect(keys(state)).toEqual(['agent:x', 'file:/a.ts', 'session:s1']);
  });

  it('檔案還沒回來時委派給先畫；後到的檔案併進去，選中的那一列跟著自己走', () => {
    let state = run(
      { type: 'hit', generation: 1, sources: ['file', 'agent'] },
      agentSettled(1, 'x', 'y'),
      { type: 'move', dir: 1 },
    );
    expect(mentionPickable(state)?.name).toBe('y');
    state = reduceMentionMenu(state, settled(1, ok(file('/a.ts'))));
    expect(keys(state)).toEqual(['agent:x', 'agent:y', 'file:/a.ts']);
    expect(mentionPickable(state)?.name).toBe('y');
  });

  it('過期的結果丟掉；回來是空的而且沒有別的來源在等，就收起來', () => {
    expect(run(agentHit(1), agentHit(2), agentSettled(1, 'old')).rows).toHaveLength(0);
    const empty = run(agentHit(1), agentSettled(1));
    expect(empty.status).toBe('closed');
    expect(mentionMenuOpen(empty)).toBe(false);
  });

  it('列的身分帶來源前綴，不會跟檔案或會話撞', () => {
    expect(mentionRowKey(agentRow('same'))).toBe('agent:same');
  });
});
