/**
 * 命令列入口：掃過每一處 `SessionEventMap` 宣告，重新生成 `@nexus/core` 的 `known-event-types.ts`。
 *
 * 規則與渲染都在 {@link ./known-event-types-catalog.ts}；新鮮度由 `known-event-types.test.ts` 在 CI 驗，所以
 * CI 不需要多一個 step。宣告違規時不寫檔、印出每一條並以非零碼結束。
 *
 * @module
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectSessionEventTypes,
  EVENT_CATALOG_ROOTS,
  KNOWN_EVENT_TYPES_PATH,
  renderKnownEventTypes,
} from './known-event-types-catalog.js';
import { repositoryRoot } from './package-invariants.js';

const root = repositoryRoot();
const { events, violations } = collectSessionEventTypes(root, EVENT_CATALOG_ROOTS);

if (violations.length > 0) {
  console.error('gen-known-event-types：SessionEventMap 的宣告有違規，沒有寫檔');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

writeFileSync(
  join(root, KNOWN_EVENT_TYPES_PATH),
  renderKnownEventTypes(events.map((event) => event.name)),
);
console.log(`gen-known-event-types：寫入 ${KNOWN_EVENT_TYPES_PATH}（${events.length} 種事件）。`);
