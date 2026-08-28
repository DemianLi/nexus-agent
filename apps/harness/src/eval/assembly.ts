/**
 * 基準任務的組裝 —— **CI 那半與尺寸比較那半共用的同一份**。
 *
 * [`runner.ts`](./runner.ts) 寫著「plugin 清單兩邊必須是同一份，否則比的不是模型是組裝」。
 * 那句話只有在真的**同一份**時才成立：各自寫一份一模一樣的清單，第一天是對的，
 * 第一次有人只改其中一邊的那天就靜靜地不對了，而且沒有任何東西會紅。
 *
 * 所以清單與 system prompt 放這裡，`eval.test.ts` 與 `compare.ts` 都從這裡拿。
 * **這是唯一的定義點。**
 */

import type { NexusPlugin } from '@nexus/core';
import { createEchoPlugin } from '@nexus/plugin-echo';

/** 基準任務跑的 plugin 清單。 */
export function benchmarkPlugins(): readonly NexusPlugin[] {
  return [createEchoPlugin()];
}

/**
 * 附加在基準任務上的 system prompt。
 *
 * 第二句是**必要的**而不是禮貌話：小模型很常把「我要呼叫 echo」寫在文字裡就交差，
 * 那會被評分器記成「該叫的沒叫」。這句話讓那個分數量的是能力而不是誤會。
 */
export const BENCHMARK_SYSTEM_PROMPT = [
  '你是 nexus-agent 的基準任務受測者。',
  '需要動用工具時就真的呼叫，不要只在文字裡描述你打算做什麼。',
].join('\n');
