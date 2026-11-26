/**
 * 命令列入口：重新產生 `docs/tool-catalog.md`（[#442](https://github.com/DemianLi/nexus-agent/issues/442)）。
 *
 * 邏輯都在 {@link ./tool-catalog.ts}；這裡只負責寫檔。新鮮度由 `tool-catalog.test.ts` 在 CI 驗，所以 CI 不需要多一個 step。
 *
 * @module
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryRoot } from './package-invariants.js';
import { collectToolCatalog, renderToolCatalog } from './tool-catalog.js';

const root = repositoryRoot();
const sections = await collectToolCatalog(root);
const target = join(root, 'docs', 'tool-catalog.md');
writeFileSync(target, renderToolCatalog(sections));
console.log(
  `gen-tool-catalog：寫了 ${target}（${String(sections.reduce((n, s) => n + s.tools.length, 0))} 個工具，${String(sections.length)} 個來源）。`,
);
process.exit(0);
