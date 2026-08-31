/**
 * plugin 清單：echo 加上**已經打開**的計劃模式。
 *
 *   pnpm --filter @nexus/harness run serve:live --plugins src/plan-mode.fixture.ts
 *
 * **`serve` 是該用這一份的入口。** `exit_plan_mode` 是需要核准的工具，而 CLI 與
 * eval 走 `HEADLESS_APPROVALS`（[#113](https://github.com/DemianLi/nexus-agent/issues/113)）
 * ——在那裡打開計劃模式，模型提了計劃就被確定性拒絕。
 *
 * **[#120](https://github.com/DemianLi/nexus-agent/issues/120) 之後 CLI 上多了一條出路
 * （`/plan off`），但那不改變這一份的用途**：CLI 走 `HEADLESS_APPROVALS` 這件事沒變，
 * 所以那裡走完的是「規劃 → 交計劃 → 被拒 → 自己爬出來」，不是那條正路。而且 CLI 的
 * 預設清單裡計劃模式本來就在了（關著的），要在 CLI 上試 `/plan` 不需要換清單。
 *
 * **`serve` 那條線上還沒有命令介面**，所以 web 那端打不到 `/plan`——這一份就是那裡
 * 打開計劃模式的辦法。
 *
 * **而且要 `--live` 才看得到全程。** 假模型的腳本寫死在 `cli.ts` 的 `CLI_SCRIPT`
 * （先 echo、再 write_file），它不會呼叫 `exit_plan_mode`——換一份 plugin 清單改不了
 * 模型的腳本。所以假模型下這一份證明的是「掛得起來、工具排進了清單、指引進了 prompt」，
 * 真的走完「規劃 → 交計劃 → 有人按批准 → 開始動手」要真模型。
 */

import type { NexusPlugin } from '@nexus/core';
import { createEchoPlugin } from '@nexus/plugin-echo';
import { createPlanModePlugin } from '@nexus/plugin-plan-mode';

export default [
  createEchoPlugin(),
  createPlanModePlugin({ startActive: true }),
] satisfies NexusPlugin[];
