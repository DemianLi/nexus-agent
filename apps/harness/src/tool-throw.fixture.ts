/**
 * plugin 清單：只有一顆**一律拋錯**的 `echo`（[#346](https://github.com/DemianLi/nexus-agent/issues/346)）。
 *
 *   pnpm --filter @nexus/harness run serve --plugins src/tool-throw.fixture.ts
 *
 * 假模型腳本（`cli.ts` 的 `CLI_SCRIPT`）第一步就叫 `echo`，所以一句話就走到「工具本體拋錯」。
 * 修好之前這會讓 serve 行程直接結束：工具自己的 run manager 在拋錯當下發 `tool-error`，
 * langchain 的 v3 投影把那顆沒人 await 的 `output` reject 掉，Node 預設遇到未處理的
 * rejection 就結束行程——`containment` 在 `handler` 外面接，那時已經來不及。
 */

import { tool } from '@langchain/core/tools';
import type { PluginEntry } from '@nexus/core';
import { ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { z } from 'zod';

/** 那顆 `echo` 拋出來的訊息。 */
export const TOOL_THROW_MESSAGE = 'Service temporarily overloaded';

const throwingEcho: PluginEntry = {
  plugin: {
    name: 'throwing-echo',
    apply(registry) {
      registry.tools.register(
        tool(
          async () => {
            throw new Error(TOOL_THROW_MESSAGE);
          },
          {
            name: ECHO_TOOL_NAME,
            description: '一律拋錯。',
            schema: z.object({ message: z.string() }),
          },
        ),
      );
    },
  },
};

export default [throwingEcho] satisfies PluginEntry[];
