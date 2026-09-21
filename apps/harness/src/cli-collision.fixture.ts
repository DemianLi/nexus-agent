/**
 * 端到端測試用的 plugin：想搶出貨清單裡 `echo` 工具的一個 plugin。
 *
 *   pnpm --filter @nexus/harness run cli --patch src/cli-collision.patch.yml "說點什麼"
 *
 * 獨立成一個模組是因為那條測試要跑**真的入口**——衝突必須從 argv 進來（`--patch`），才驗得到
 * 「錯誤從 registry 一路傳到行程退出碼」這條路徑。測試裡直接呼叫 `loadPlugins` 驗得到衝突規則，
 * 但驗不到傳播。
 *
 * **兩個 plugin 都在這一個模組裡** 會違反 patch 語義（一個模組對一個 plugin），所以只留一顆。
 * 出貨清單上 `echo` 已經有了（id: `echo`），所以這一顆插進去就立刻撞。
 *
 * 兩個 plugin 的 `name` 刻意不同：驗收要求 stderr **指名撞的是哪兩個 plugin**，
 * 兩個都叫同一個名字就分不出來了——第一個是 `echo`（出貨的），第二個是這裡的那顆。
 */

import { tool } from '@langchain/core/tools';
import type { NexusPlugin } from '@nexus/core';
import { ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { z } from 'zod';

/**
 * 出貨清單裡的 `echo` 工具名。這裡模仿那個名稱製造衝突。
 *
 * **不 export**：斷言故意不看它。27 列的出貨清單上 `echo` 這個字本來就會出現在 stderr 裡，
 * 拿它當判準會假綠——判別衝突的是那兩個 plugin 名字的組合。
 */
const COLLIDING_TOOL_NAME = ECHO_TOOL_NAME;

/** 出貨清單上先註冊成功的那個（echo plugin）。 */
export const FIRST_PLUGIN_NAME = 'echo';

/** 這裡插進來要撞上去的那個。刻意不含 'echo' 來避免假綠——stderr 會有兩個名字，不能只憑包含關係判。 */
export const SECOND_PLUGIN_NAME = 'collision-probe';

const collidingEcho: NexusPlugin = {
  name: SECOND_PLUGIN_NAME,
  apply: (registry) => {
    registry.tools.register(
      tool(async (message: string) => message, {
        name: COLLIDING_TOOL_NAME,
        description: '一個冒充 echo 的工具，會跟出貨清單上的衝突。',
        schema: z.object({ message: z.string() }),
      }),
    );
  },
};

export default collidingEcho;
