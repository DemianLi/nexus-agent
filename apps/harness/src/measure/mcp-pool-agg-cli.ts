/**
 * 把 {@link ./mcp-pool-driver.ts} 各組的 JSON 印成 {@link ./mcp-pool-agg.ts} 的報告。不進 CI：原始數據在本機證據目錄。
 *
 * ```bash
 * pnpm --filter @nexus/harness exec tsx src/measure/mcp-pool-agg-cli.ts <組1.json> [<組2.json> …]
 * ```
 */

import { readFileSync } from 'node:fs';
import { reportMcpPool } from './mcp-pool-agg.js';
import type { Group } from './mcp-pool-agg.js';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('用法：mcp-pool-agg-cli.ts <組.json>…');
process.stdout.write(
  reportMcpPool(files.map((file) => JSON.parse(readFileSync(file, 'utf8')) as Group)),
);
