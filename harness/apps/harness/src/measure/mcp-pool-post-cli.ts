/**
 * 印後測的三條過關條件（{@link ./mcp-pool-post.ts}）。不進 CI：原始數據在本機證據目錄。
 *
 * ```bash
 * pnpm --filter @nexus/harness exec tsx src/measure/mcp-pool-post-cli.ts <組1.json> [<組2.json> …]
 * ```
 */

import { readFileSync } from 'node:fs';
import { reportPost } from './mcp-pool-post.js';
import type { Group } from './mcp-pool-agg.js';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('用法：mcp-pool-post-cli.ts <組.json>…');
process.stdout.write(
  reportPost(files.map((file) => JSON.parse(readFileSync(file, 'utf8')) as Group)),
);
