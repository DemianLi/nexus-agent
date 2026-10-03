/**
 * 量真的下行路由在客戶端斷線之後漏掉幾條訂閱（見 `subscriber-leak.ts`）。不進 CI。
 *
 * ```bash
 * pnpm --filter @nexus/harness exec tsx src/measure/subscriber-leak-cli.ts --total 400 --concurrency 16
 * # 對照修前的 wire-server：
 * git show d63afae^:apps/harness/src/wire-server.ts | sed "s#'./wire-handler.js'#'../wire-handler.js'#" > src/measure/_old-wire-server.ts
 * pnpm --filter @nexus/harness exec tsx src/measure/subscriber-leak-cli.ts --wire-server ./src/measure/_old-wire-server.ts
 * ```
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { StartWireServer } from './abort-delivery.js';
import { measureSubscriberLeak } from './subscriber-leak.js';
import type { LeakRoute } from './subscriber-leak.js';

const { values } = parseArgs({
  options: {
    total: { type: 'string', default: '400' },
    concurrency: { type: 'string', default: '16' },
    settle: { type: 'string', default: '3000' },
    'gc-every': { type: 'string', default: '25' },
    route: { type: 'string', default: 'stream,feed' },
    'wire-server': { type: 'string' },
  },
});

let startWireServer: StartWireServer | undefined;
if (values['wire-server'] !== undefined) {
  const module = (await import(pathToFileURL(resolve(values['wire-server'])).href)) as {
    startWireServer: StartWireServer;
  };
  startWireServer = module.startWireServer;
}

for (const route of values.route!.split(',') as LeakRoute[]) {
  const result = await measureSubscriberLeak({
    route,
    total: Number(values.total),
    concurrency: Number(values.concurrency),
    settleMs: Number(values.settle),
    gcEveryMs: Number(values['gc-every']),
    ...(startWireServer !== undefined && { startWireServer }),
  });
  console.log(
    `${route}：放棄 ${result.total} 次（並行 ${values.concurrency}），訂了 ${result.subscribed} 條，沒收掉 ${result.leaked}${values['wire-server'] === undefined ? '' : `（${values['wire-server']}）`}`,
  );
}
process.exit(0);
