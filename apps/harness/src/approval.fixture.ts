/**
 * plugin 清單：預設那份，外加把兩個工具標成要人核准。
 *
 * **它存在是因為驗收句要它。** Phase 5 的驗收是「瀏覽器完成提問 → 看事件流 →
 * **核准工具** → 收結果」，而預設清單（只有 echo）不觸發任何中斷 —— 沒有這一份，
 * 那半句在瀏覽器裡跑不出來。
 *
 *   pnpm --filter @nexus/harness run serve --plugins src/approval.fixture.ts
 *
 * 標的兩個工具都是**假模型腳本真的會呼叫**的（`cli.ts` 的 `CLI_SCRIPT`：先 echo、
 * 再 write_file），所以一條假對話會停兩次 —— 第二次順帶證明核准之後那條下行還活著，
 * 沒有因為換了一個 run 物件而斷掉。
 *
 * `write_file` 是基座自己帶的工具，擋它是合法的 —— **而且現在不必再向誰證明它存在**：
 * 閘門拿到的是執行當下的那一次呼叫，沒有名字宇宙要對齊（[#111](https://github.com/DemianLi/nexus-agent/issues/111)）。
 */

import type { NexusPlugin } from '@nexus/core';
import { ECHO_TOOL_NAME, createEchoPlugin } from '@nexus/plugin-echo';

/** 這份清單裡要人核准的工具。 */
export const GATED_TOOL_NAMES: readonly string[] = [ECHO_TOOL_NAME, 'write_file'];

const gatePlugin: NexusPlugin = {
  name: 'approval-demo',
  apply(registry) {
    // 一位 listener 判所有工具，而不是逐個工具註冊一筆 —— 這正是換掉宣告式清單之後
    // 該有的寫法：名字在 `exec` 上，不在我們手上的一份表裡。
    registry.approvals.gate((exec, next) =>
      GATED_TOOL_NAMES.includes(exec.name)
        ? { kind: 'ask', reason: `${exec.name} 會動到外面，先給人看過` }
        : next(),
    );
  },
};

export default [createEchoPlugin(), gatePlugin] satisfies NexusPlugin[];
