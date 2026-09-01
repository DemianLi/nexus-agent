/**
 * **`checkpoint_ns` 的形狀，逐條釘住。**
 *
 * 這一檔不是在驗一個函式對不對，它是在**擋一種靜默失敗**。`checkpoint_ns` 的巢狀格式
 * （`a|b`）沒有出現在 LangGraph 的公開契約裡，只出現在它的行為裡；升版把格式改掉的話，
 * 解析會安靜地退化成「整串都是最後一段」＝每一次呼叫都被當成 root，而那表示 root 與
 * subagent 的狀態合成一份，看起來像正常運作。
 *
 * 所以下面每一條都直接寫死那張表的一格。表本身量自 2026-09-01 的探針，見
 * `.docs/subagent-session-log-survey.md`。
 */

import { describe, expect, it } from 'vitest';
import { sessionAddressKey, toolCallSessionAddress } from './session-address.js';

/** 照探針量到的形狀組一份 config。 */
function configWith(namespace: string): unknown {
  return { configurable: { checkpoint_ns: namespace, thread_id: 'irrelevant' } };
}

describe('toolCallSessionAddress', () => {
  it('單段就是 root——root 的呼叫只有自己那一段', () => {
    expect(toolCallSessionAddress(configWith('tools:631b83bf'))).toEqual({ kind: 'root' });
  });

  it('兩段就是 subagent，身分是前面那一段', () => {
    expect(toolCallSessionAddress(configWith('tools:a21dcf6c|tools:592c983e'))).toEqual({
      kind: 'subagent',
      runId: 'tools:a21dcf6c',
    });
  });

  it('同一次 spawn 裡叫兩次工具，身分是同一個——變的是最後一段', () => {
    const first = toolCallSessionAddress(configWith('tools:25c89826|tools:2b729d72'));
    const second = toolCallSessionAddress(configWith('tools:25c89826|tools:558088f6'));
    expect(first).toEqual(second);
  });

  it('併發 spawn 的兩次是兩個身分——前綴不同', () => {
    const left = toolCallSessionAddress(configWith('tools:eadf414d|tools:bd3ae75e'));
    const right = toolCallSessionAddress(configWith('tools:180484ef|tools:c5fb7a1b'));
    expect(left).not.toEqual(right);
  });

  it('三段（subagent 再 spawn）身分是前兩段', () => {
    expect(toolCallSessionAddress(configWith('tools:a|tools:b|tools:c'))).toEqual({
      kind: 'subagent',
      runId: 'tools:a|tools:b',
    });
  });

  /**
   * **這一條是絆索本體。**
   *
   * 它釘的是分隔符**就是 `|`**。哪天 LangGraph 換成別的字元，這一條會紅——而紅在這裡，
   * 遠比讓 subagent 的寫入靜靜地流進 root 的日誌便宜。
   */
  it('分隔符是 `|`，不是別的——換掉就不再分得出巢狀', () => {
    expect(toolCallSessionAddress(configWith('tools:a|tools:b'))).toEqual({
      kind: 'subagent',
      runId: 'tools:a',
    });
    // 同樣兩段但用別的字元分：認不出巢狀，整串被當成一段。
    expect(toolCallSessionAddress(configWith('tools:a/tools:b'))).toEqual({ kind: 'root' });
  });

  it.each([
    ['整個 config 缺席', undefined],
    ['config 不是物件', 'nope'],
    ['沒有 configurable', {}],
    ['configurable 是 null', { configurable: null }],
    ['沒有 checkpoint_ns', { configurable: { thread_id: 't' } }],
    ['checkpoint_ns 是空字串', { configurable: { checkpoint_ns: '' } }],
    ['checkpoint_ns 不是字串', { configurable: { checkpoint_ns: 7 } }],
  ])('%s 就是認不出來，**不猜成 root**', (_label, config) => {
    expect(toolCallSessionAddress(config)).toBeUndefined();
  });
});

describe('sessionAddressKey', () => {
  it('root 與 subagent 是兩個鍵', () => {
    expect(sessionAddressKey({ kind: 'root' })).not.toBe(
      sessionAddressKey({ kind: 'subagent', runId: 'x' }),
    );
  });

  it('不同的 runId 是不同的鍵', () => {
    expect(sessionAddressKey({ kind: 'subagent', runId: 'a' })).not.toBe(
      sessionAddressKey({ kind: 'subagent', runId: 'b' }),
    );
  });

  /** 前綴拿掉的話這一條會紅——而那個撞法的下場是靜默合流。 */
  it('runId 剛好叫 root 也撞不到 root 那一格', () => {
    expect(sessionAddressKey({ kind: 'subagent', runId: 'root' })).not.toBe(
      sessionAddressKey({ kind: 'root' }),
    );
  });
});
