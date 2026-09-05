/**
 * plugin 清單：echo ＋ 一位**在安裝當下就建一個目標**的 `sessions` 參與者 ＋ 一個看到
 * `goal/change` 就吭聲的配套入口。
 *
 * ```
 * pnpm --filter @nexus/harness run cli --plugins src/cli-session-participant.fixture.ts "回聲一下"
 * ```
 *
 * **它證的是 CLI 那條路真的接了 `sessions` 通道**，而不是「goal 域算得對」（那件事在
 * `@nexus/plugin-goal` 自己的測試裡）。`createCliAgent` 那一層只證明 `attachSession`
 * 轉得下去，證不了 `runCli` 真的呼叫它——[#126](https://github.com/DemianLi/nexus-agent/issues/126)。
 *
 * **為什麼要靠一個會吭聲的配套入口當觀測點**：這條路唯一離開行程的東西是 stdout 與
 * stderr，而一個安裝成功的參與者本身一句話都不說。所以拿 `[不變量]` 那一行當回音——
 * 它印得出來，就代表參與者真的裝上了、真的寫進了那份日誌，而且**寫的那一筆被已經在看
 * 的檢查看到了**（接線順序：不變量先、參與者後）。
 *
 * 順帶釘住一件 `sessions` 通道的語意：**參與者在安裝當下就寫得動日誌，而且讀得回來**。
 * `GoalService` 的 `create()` 會在 append 之後立刻讀自己的折疊；`observe()` 如果是等
 * 這一輪裝完才生效，這一行會當場拋。
 *
 * **清單自己列，不 `import { DEFAULT_PLUGINS } from './cli.js'`——那會死鎖**，理由與
 * [`cli-invariant-violation.fixture.ts`](./cli-invariant-violation.fixture.ts) 那份一樣。
 */

import type { NexusPlugin } from '@nexus/core';
import { createEchoPlugin } from '@nexus/plugin-echo';
import { GoalService } from '@nexus/plugin-goal';

/** 這份清單認領的假 package 名。真的 package 不會用它，所以撞不到任何人。 */
export const GOAL_PROBE_PACKAGE = '@nexus/goal-probe';

/** 參與者建的那個目標的敘述，測試靠它認出回音。 */
export const PROBE_OBJECTIVE = '證明 CLI 這條路接上了 sessions 通道';

const probe: NexusPlugin = {
  name: 'goal-probe',
  apply(registry) {
    registry.sessions.join((subject) => {
      // 時鐘與 id 都固定：這份 fixture 手動跑的時候輸出要逐字一樣。
      const service = new GoalService(subject, { now: () => 0, newGoalId: () => 'goal-probe' });
      service.create({ objective: PROBE_OBJECTIVE });
    });
    registry.invariants.register(GOAL_PROBE_PACKAGE, (subject, fail) => {
      subject.observe((event) => {
        if (event.type === 'goal/change') fail(`看到 ${event.type}（seq ${event.seq}）`);
      });
    });
  },
};

export default [createEchoPlugin(), probe] satisfies NexusPlugin[];
