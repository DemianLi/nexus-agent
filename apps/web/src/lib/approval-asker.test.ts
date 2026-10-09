// @vitest-environment node
import { emptyConversation, reduceAll } from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { pendingAsker } from '@/lib/approval-asker';
import { pendingLabel } from '@/lib/pending-label';
import { Script } from '@/test/conversation-frames';

/** 前景子代理要核准時，畫面認出是誰在問（#328 第 1 項）。 */

/** 派出一個前景子代理（`task` 的 `tool-started`，namespace 就是它之後所有東西的第一段）。 */
const script = new Script();
function delegated(callId: string, namespace: string, input: Record<string, unknown> | string) {
  const event = script.started(callId, 'task', input);
  return { ...event, params: { ...event.params, namespace: [namespace] } } as typeof event;
}

const SUB_A = { subagent_type: 'explore', description: '整理 README\n第二行不要' };

/** 帶 `seq` 的 frame 要照序到：先開一輪，再依次派出去（frame 用函式交進來，到這裡才產生，seq 才跟著順序走）。 */
function foldWith(...frames: (() => ReturnType<Script['started']>)[]): ConversationState {
  return reduceAll(emptyConversation(), [script.running(), ...frames.map((make) => make())]);
}

const pendingOf = (namespace: readonly string[]) => ({ namespace });

describe('pendingAsker', () => {
  it('root 自己問的（namespace 是空的）：沒有，畫面逐字同以前', () => {
    const state = foldWith(() => delegated('c1', 'tools:u1', SUB_A));
    expect(pendingAsker(state, pendingOf([]))).toBeUndefined();
  });

  it('子代理問的：名字來自折疊器的歸屬，說明沿用委派卡的 description（單行）', () => {
    const state = foldWith(() => delegated('c1', 'tools:u1', SUB_A));
    expect(pendingAsker(state, pendingOf(['tools:u1']))).toEqual({
      label: '子代理「explore」',
      description: '整理 README',
    });
  });

  it('兩個子代理平行：各認各的，不串', () => {
    const state = foldWith(
      () => delegated('c1', 'tools:u1', SUB_A),
      () => delegated('c2', 'tools:u2', { subagent_type: 'writer', description: '寫測試' }),
    );
    expect(pendingAsker(state, pendingOf(['tools:u1']))?.label).toBe('子代理「explore」');
    expect(pendingAsker(state, pendingOf(['tools:u2']))).toEqual({
      label: '子代理「writer」',
      description: '寫測試',
    });
  });

  it('對不到委派卡（例如重新整理後即時那條線沒有重播）：只說「子代理」，不編名字也不編在做的事', () => {
    const state = foldWith(() => delegated('c1', 'tools:u1', SUB_A));
    expect(pendingAsker(state, pendingOf(['tools:unknown']))).toEqual({ label: '子代理' });
  });

  it.each([
    ['參數不是 JSON', '{壞掉'],
    ['沒有 description', { subagent_type: 'explore' }],
    ['description 是空白', { subagent_type: 'explore', description: '   ' }],
  ])('委派卡的參數不給說明（%s）：只有名字', (_case, input) => {
    const state = foldWith(() => delegated('c1', 'tools:u1', input));
    const asker = pendingAsker(state, pendingOf(['tools:u1']));
    // 參數不是 JSON 時折疊器認不出子代理名，歸屬根本不成立：連名字都沒有。
    expect(asker?.description).toBeUndefined();
  });

  it('面板名稱：誰在問寫在工具名後面，跨面板進度仍在最後；root 的名稱不變', () => {
    const approval = {
      kind: 'approval',
      interruptId: 'i',
      namespace: ['tools:u1'],
      actions: [{ name: 'write_file', args: {} }],
      allowedDecisions: ['approve', 'reject'],
    } as never;
    expect(pendingLabel(approval, { index: 0, total: 1 })).toBe('等待核准：write_file');
    expect(pendingLabel(approval, { index: 0, total: 2 }, '子代理「explore」')).toBe(
      '等待核准：write_file（子代理「explore」要的）（1／2）',
    );
  });
});
