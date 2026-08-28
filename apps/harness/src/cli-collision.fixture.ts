/**
 * 端到端測試用的 plugin 清單：兩個 plugin 搶同一個工具名。
 *
 * 獨立成一個模組是因為那條測試要跑**真的入口**——衝突必須從 argv 進來
 * （`--plugins <這個檔>`），才驗得到「錯誤從 registry 一路傳到行程退出碼」這條路徑。
 * 測試裡直接呼叫 `loadPlugins` 驗得到衝突規則，但驗不到傳播。
 *
 * 兩個 plugin 的 `name` 刻意不同：驗收要求 stderr **指名撞的是哪兩個 plugin**，
 * 兩個都叫同一個名字就分不出來了。
 */

import type { NexusPlugin } from '@nexus/core';
import { fakeTool } from './fixtures.js';

/** 兩個 plugin 都想註冊的工具名。 */
export const COLLIDING_TOOL_NAME = 'search';

/** 先註冊成功的那個。 */
export const FIRST_PLUGIN_NAME = 'alpha-search';

/** 撞上去的那個。 */
export const SECOND_PLUGIN_NAME = 'beta-search';

const collidingPlugin = (name: string): NexusPlugin => ({
  name,
  apply: (registry) => void registry.tools.register(fakeTool(COLLIDING_TOOL_NAME)),
});

export default [
  collidingPlugin(FIRST_PLUGIN_NAME),
  collidingPlugin(SECOND_PLUGIN_NAME),
] satisfies NexusPlugin[];
