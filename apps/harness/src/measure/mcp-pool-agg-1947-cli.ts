/**
 * 用 #1947 留下的原始數據印出 {@link ./mcp-pool-agg-1947.ts} 的報告，拿去跟 `agg.py` 的輸出逐字比對。不進 CI：原始數據在本機證據目錄。
 *
 * ```bash
 * pnpm --filter @nexus/harness exec tsx src/measure/mcp-pool-agg-1947-cli.ts <out 目錄> > ts.txt
 * python3.12 -I agg.py <out 目錄> > py.txt && cmp py.txt ts.txt
 * ```
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { report1947 } from './mcp-pool-agg-1947.js';

const dir = process.argv[2];
if (dir === undefined) throw new Error('用法：mcp-pool-agg-1947-cli.ts <out 目錄>');
const runs = ['run1', 'run2'].map((tag): [string, unknown[]] => {
  const data = JSON.parse(readFileSync(join(dir, `${tag}.json`), 'utf8')) as { results: unknown[] };
  return [tag, data.results];
});
process.stdout.write(report1947(runs));
