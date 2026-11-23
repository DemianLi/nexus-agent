import { pluginLintConfig } from '@nexus/sdk/lint';

import base from '../../eslint.config.js';

// 遷出的插件套用 SDK 的 lint 設定（#1420），**排除只有一個檔**（#2551，偏離登記在 `docs/plugin-contract.md`）：
// `src/invariant.ts`，相容層的配套入口（`plan-mode-invariant` 那一列），照 #1463 Q3 (a)。撤除條件：配套入口重審——拿掉就連檔一起刪，
// 留下就另開卡遷它。
// **排除只蓋到這個檔**：其餘 `src/**` 仍受管（`eslint-exclusion.test.ts` 用記憶體裡的違規碼與虛擬路徑量：不在名單的檔要紅、這個檔才不紅）。
const EXCLUDED = ['src/invariant.ts'];

export default [
  ...base,
  ...pluginLintConfig.map((config) => ({ ...config, ignores: [...config.ignores, ...EXCLUDED] })),
];
