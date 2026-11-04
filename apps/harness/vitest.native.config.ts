import { mergeConfig } from 'vitest/config';

import base from './vitest.config.ts';

/**
 * 同一套測試改跑 native agent loop（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：沒指定 loop 的組裝一律當成
 * `--agent-loop native`，見 `src/native-loop.setup.ts`。只換得到同一個行程裡的組裝；起子行程的測試（腳本 serve、`dist` 的 CLI）
 * 要自己帶旗標。
 *
 * `pnpm --filter @nexus/harness exec vitest run --config vitest.native.config.ts`
 */
export default mergeConfig(base, {
  test: {
    setupFiles: ['./src/native-loop.setup.ts'],
  },
});
