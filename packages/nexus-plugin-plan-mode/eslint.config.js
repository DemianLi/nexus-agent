import { pluginLintConfig } from '@nexus/sdk/lint';

import base from '../../eslint.config.js';

// 遷出的插件套用 SDK 的 lint 設定（#1420），**排除只有兩個檔**（#2551，偏離登記在 `docs/plugin-contract.md`）：
// - `src/invariant.ts`：相容層的配套入口（`plan-mode-invariant` 那一列），照 #1463 Q3 (a)。撤除條件：配套入口重審——拿掉就連檔一起刪，
//   留下就另開卡遷它。
// - `src/model-call-cell.ts`：plan-mode 留在相容層的那一格（`plan-mode-model-call` 那一列），寫的是 `NexusPlugin` 與 LangChain 的
//   middleware，樹上還沒有對應的接縫。撤除條件：#2358 把這一格搬上樹，連檔一起刪。
// **排除只蓋到這兩個檔**：其餘 `src/**` 仍受管（`eslint-exclusion.test.ts` 用記憶體裡的違規碼與虛擬路徑量：不在名單的檔要紅、這兩個檔才不紅）。
const EXCLUDED = ['src/invariant.ts', 'src/model-call-cell.ts'];

export default [
  ...base,
  ...pluginLintConfig.map((config) => ({ ...config, ignores: [...config.ignores, ...EXCLUDED] })),
];
