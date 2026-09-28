import type { FileReferenceCandidate, FileReferenceListOutcome } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  MENTION_MENU_CLOSED,
  mentionMenuOpen,
  mentionPickable,
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
    expect(state.availability).toBe('unavailable');
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
