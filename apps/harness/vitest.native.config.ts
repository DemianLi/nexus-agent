import { mergeConfig } from 'vitest/config';

import base from './vitest.config.ts';

/**
 * 同一套測試改跑 native agent loop（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：沒指定 loop 的組裝一律當成
 * `--agent-loop native`，見 `src/native-loop.setup.ts`。只換得到同一個行程裡的組裝；起子行程跑回合的測試照 `NEXUS_TEST_AGENT_LOOP`
 * 自己帶旗標（`src/conversation-process.test.ts`）。產品程式碼不讀這個變數。
 *
 * `pnpm --filter @nexus/harness exec vitest run --config vitest.native.config.ts`
 */
export default mergeConfig(base, {
  test: {
    setupFiles: ['./src/native-loop.setup.ts'],
    env: { NEXUS_TEST_AGENT_LOOP: 'native' },
    // 登記過的已知差異照登記的方式跑（`src/native-loop-known-differences.ts`）。
    runner: './native-loop.runner.ts',
  },
});
