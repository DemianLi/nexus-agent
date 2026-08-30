/**
 * plugin 清單：echo 加上**已經打開**的計劃模式。
 *
 *   pnpm --filter @nexus/harness run serve:live --plugins src/plan-mode.fixture.ts
 *
 * **`serve` 是唯一該用這一份的入口。** `exit_plan_mode` 是需要核准的工具，而 CLI 與
 * eval 走 `HEADLESS_APPROVALS`（[#113](https://github.com/DemianLi/nexus-agent/issues/113)）
 * ——在那裡打開計劃模式，模型提了計劃就被確定性拒絕，模式沒關，而今天沒有第二條路
 * 出去。整輪只剩指引。這不是缺陷，是 `startActive` 的 JSDoc 已經寫明的後果。
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
