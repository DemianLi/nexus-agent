/**
 * 量客戶端斷線時 handler 的 `request.signal` 有沒有中止（見 `abort-delivery.ts`）。不進 CI。
 *
 * ```bash
 * pnpm --filter @nexus/harness exec tsx src/measure/abort-delivery-cli.ts --total 400 --concurrency 16
 * # 對照修前的 wire-server（抽出來放在 src 底下任一處，import 要改成對得上的相對路徑）：
 * git show d63afae^:apps/harness/src/wire-server.ts > src/measure/_old-wire-server.ts
 * pnpm --filter @nexus/harness exec tsx src/measure/abort-delivery-cli.ts --wire-server ./_old-wire-server.ts
 * ```
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { measureAbortDelivery } from './abort-delivery.js';
import type { DeliveryShape, StartWireServer } from './abort-delivery.js';

const { values } = parseArgs({
  options: {
    total: { type: 'string', default: '400' },
    concurrency: { type: 'string', default: '16' },
    hold: { type: 'string', default: '1500' },
    'gc-every': { type: 'string', default: '0' },
    shape: { type: 'string', default: 'list,sse' },
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

for (const shape of values.shape!.split(',') as DeliveryShape[]) {
  const result = await measureAbortDelivery({
    shape,
    total: Number(values.total),
    concurrency: Number(values.concurrency),
    holdMs: Number(values.hold),
    gcEveryMs: Number(values['gc-every']),
    ...(startWireServer !== undefined && { startWireServer }),
  });
  console.log(
    `${shape}：放棄 ${result.total} 次（並行 ${values.concurrency}），handler 收到中止 ${result.noticed}，一直沒收到 ${result.lost}${values['wire-server'] === undefined ? '' : `（${values['wire-server']}）`}`,
  );
}
process.exit(0);
