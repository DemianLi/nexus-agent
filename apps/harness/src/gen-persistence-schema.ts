/**
 * 命令列入口：從原始碼抽出會話日誌落盤的型別圖，重新生成 `docs/persistence-schema.json`
 * （[#1856](https://github.com/DemianLi/nexus-agent/issues/1856) ⓪b-1，照 dsh `scripts/gen-persistence-catalog.ts`）。
 *
 * 抽取規則在 {@link ./persistence-schema.ts}；新鮮度由 `persistence-schema.test.ts` 在 CI 驗。`--check` 只比對、不寫檔，
 * 過期就以非零碼結束（照 dsh 的 `--check`）。抽取失敗時不寫檔、印出原因並以非零碼結束。
 *
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryRoot } from './package-invariants.js';
import {
  extractPersistenceSchema,
  PERSISTENCE_SCHEMA_PATH,
  PERSISTENCE_SCHEMA_REGENERATE,
  renderPersistenceSchema,
} from './persistence-schema.js';

const root = repositoryRoot();
const check = process.argv.includes('--check');
const path = join(root, PERSISTENCE_SCHEMA_PATH);

let rendered: string;
try {
  rendered = renderPersistenceSchema(extractPersistenceSchema(root));
} catch (error) {
  console.error('gen-persistence-schema：抽取失敗，沒有寫檔');
  console.error(`  ${String(error)}`);
  process.exit(1);
}

if (check) {
  let committed: string | undefined;
  try {
    committed = readFileSync(path, 'utf8');
  } catch {
    committed = undefined;
  }
  if (committed !== rendered) {
    console.error(
      `gen-persistence-schema：${PERSISTENCE_SCHEMA_PATH} 跟原始碼不一致。重新生成：${PERSISTENCE_SCHEMA_REGENERATE}`,
    );
    process.exit(1);
  }
  console.log(`gen-persistence-schema：${PERSISTENCE_SCHEMA_PATH} 是最新的。`);
} else {
  writeFileSync(path, rendered);
  console.log(`gen-persistence-schema：寫入 ${PERSISTENCE_SCHEMA_PATH}。`);
}
