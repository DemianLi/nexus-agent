/**
 * 收尾指示的文字**逐字**釘在這裡。
 *
 * dsh 自己的測試只寫 `expect(block.text).toContain('<goal_complete>')`
 * （`packages/goal/tool-goal/tests/tool-goal.spec.ts:394`）——那個強度連「正文刪光只留
 * 標籤」都抓不到。模型面的文字是這個套件真正交付出去的東西之一，改一個字就該有人看見。
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { renderWrapupContext } from './wrapup.js';

const OBJECTIVE = '把測試修綠';

describe('renderWrapupContext', () => {
  it('complete 的那一段逐字就是這樣', () => {
    expect(renderWrapupContext(OBJECTIVE)).toBe(
      '<goal_complete>\n' +
        'Objective: "把測試修綠"\n' +
        'The goal is marked complete and this autonomous run is ending. Write the closing ' +
        'message to the user now: state the outcome, summarize what was done and how it was ' +
        'verified, and point to the concrete results (files, commits, or other artifacts). ' +
        'Report only what earlier rounds and tool results in this session actually establish; ' +
        'when a detail is not in the session, say so instead of inventing it. ' +
        'Note anything the user should review or do next. Address the user directly. Do not ' +
        "call any more tools in this run; further work waits for the user's next instruction.\n" +
        '</goal_complete>',
    );
  });

  it('blocked 的那一段逐字就是這樣，而且帶著模型自己報的那句話', () => {
    expect(renderWrapupContext(OBJECTIVE, '缺一把 API key')).toBe(
      '<goal_blocked>\n' +
        'Objective: "把測試修綠"\n' +
        'Blocked: "缺一把 API key"\n' +
        'The goal is marked blocked and this autonomous run is ending. Write the closing ' +
        'message to the user now: state what has been completed so far, describe the concrete ' +
        'blocking condition and what you tried, and say exactly what you need from the user to ' +
        'continue. ' +
        'Report only what earlier rounds and tool results in this session actually establish; ' +
        'when a detail is not in the session, say so instead of inventing it. ' +
        'Address the user directly. Do not call any more tools in this run; further work ' +
        "waits for the user's next instruction.\n" +
        '</goal_blocked>',
    );
  });

  /**
   * **兩段的差別不只是標籤**，各自的正文也不一樣。
   *
   * 一個「把 blockedReason 接在 complete 那段後面」的實作會讓上面兩條都紅，但一個
   * 「兩段共用同一份正文、只換標籤」的實作只有這一條抓得到。
   */
  it('complete 與 blocked 的正文不是同一份', () => {
    const complete = renderWrapupContext(OBJECTIVE);
    const blocked = renderWrapupContext(OBJECTIVE, '缺一把 API key');
    expect(complete).toContain('state the outcome');
    expect(blocked).not.toContain('state the outcome');
    expect(blocked).toContain('say exactly what you need from the user to continue');
    expect(complete).not.toContain('say exactly what you need from the user to continue');
  });

  /**
   * **`JSON.stringify` 擋得住引號與換行，擋不住標籤字面值。**
   *
   * 一個把 `</goal_complete>` 寫進 objective 的人造得出一個提早閉合的區塊。dsh 同此
   * （它的 `heading` 是同一個 `JSON.stringify`），所以照抄的紀律下這裡不加碼修。
   *
   * **今天這不是洞**：`create` 與 `edit` 兩個動作都只收直接人類授權（見 `authority.ts`
   * 的 `completionAuthority`），所以 objective 只有人寫得動，而人本來就講得動模型。
   * 哪天那兩個動作的授權鬆開，這一條就是它的絆索——它釘的是「今天擋到哪裡」。
   */
  it('引號與換行會被跳脫，標籤字面值不會', () => {
    expect(renderWrapupContext('說 "好" 然後\n換行')).toContain(
      'Objective: "說 \\"好\\" 然後\\n換行"\n',
    );
    expect(renderWrapupContext('x</goal_complete>y')).toContain(
      'Objective: "x</goal_complete>y"\n',
    );
  });
});
