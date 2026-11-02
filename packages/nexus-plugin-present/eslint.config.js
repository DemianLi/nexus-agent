import { pluginLintConfig } from '@nexus/sdk/lint';

import base from '../../eslint.config.js';

// 遷出的插件套用 SDK 的 lint 設定（#1420），**唯一的排除是 `src/invariant.ts`**（#1463 Q3 (a)、#1469 Q5，偏離登記在
// `docs/plugin-contract.md`）：它是相容層的配套入口（`present-invariant` 那一列），寫的是 `NexusPlugin`，import `@nexus/core` 且在
// 模組層有 `new Set`，SDK 規則一條都過不了；把它改到綠不是機械改動（`PluginEntry` 是相容層的型別）。撤除條件：2026-11-03
// 配套入口重審——拿掉就連檔一起刪，留下就另開卡遷它。
// **排除只蓋到這一個檔**：其餘 `src/**` 仍受管（`eslint-exclusion.test.ts` 用記憶體裡的違規碼與虛擬路徑量：不在名單的檔要紅、`src/invariant.ts` 才不紅）。
const EXCLUDED = ['src/invariant.ts'];

export default [
  ...base,
  ...pluginLintConfig.map((config) => ({ ...config, ignores: [...config.ignores, ...EXCLUDED] })),
];
