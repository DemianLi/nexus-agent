/**
 * **不打端點更新快照夾具**（[#1556](https://github.com/DemianLi/nexus-agent/issues/1556) C077）：每個場景用已提交夾具的回覆重放，
 * 把夾具寫成這一版產品落盤的樣子（`harness.ts` 的 `refreshScenario`）。不帶 `--live`、不讀金鑰。不進測試，手動跑：
 *
 * ```
 * cd apps/harness
 * node_modules/.bin/tsx --tsconfig ../../tsconfig.runtime.json src/snapshot/refresh.ts [場景名…]
 * ```
 *
 * 不給場景名就跑全部。模型呼叫次數變了（多叫或少叫一次）refresh 不了，停在那個場景、拋錯，要用 `record.ts` 重錄。
 *
 * @module
 */

import { parseArgs } from 'node:util';

import { listScenarios, loadScenario, refreshScenario } from './harness.js';

const { positionals } = parseArgs({ allowPositionals: true });
const names = positionals.length === 0 ? await listScenarios() : positionals;
for (const name of names) {
  const changed = await refreshScenario(await loadScenario(name));
  console.log(`${name}：${changed ? '夾具已更新' : '沒有變'}`);
}
