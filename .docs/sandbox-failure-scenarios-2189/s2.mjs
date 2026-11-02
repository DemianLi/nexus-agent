import { mkdirSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import {
  startFakeModel,
  patchFile,
  mcpPatch,
  startServe,
  client,
  turn,
  toolResults,
  toolList,
} from './lib.mjs';
const B = process.env.B;
const home = `${B}/home`,
  ws = `${B}/ws`,
  log = `${B}/log`;
for (const d of [home, ws, log]) mkdirSync(d, { recursive: true });
let queries = 0,
  mode = 'answer';
const u = createSocket('udp4');
u.on('message', (q, r) => {
  queries++;
  if (mode === 'hole') return;
  const a = Buffer.concat([
    q.subarray(0, 2),
    Buffer.from([0x81, 0x80]),
    q.subarray(4, 6),
    Buffer.from([0, 1, 0, 0, 0, 0]),
    q.subarray(12),
    Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 127, 0, 0, 2]),
  ]);
  u.send(a, r.port, r.address);
});
await new Promise((r) => u.bind(53, '127.0.0.1', r));
const m = await startFakeModel();
patchFile(`${B}/p.yml`, m.baseUrl, mcpPatch());
const s = await startServe({ home, ws, logDir: log, patch: `${B}/p.yml` });
const c = await client(s);
const H = 'svc.nexus-2189.test';
for (const md of ['answer', 'hole'])
  for (const srv of ['free', 'box']) {
    mode = md;
    const q0 = queries,
      n0 = toolResults(m).length,
      t0 = Date.now();
    const r = await turn(c, `d-${md}-${srv}`, [{ name: `mcp__${srv}__dns`, args: { host: H } }], {
      limitMs: 90000,
    });
    console.log(
      `[${md}/${srv}] ${r.end} ${Date.now() - t0}ms queries=${queries - q0} ::`,
      toolResults(m).slice(n0).join('|').slice(0, 400),
    );
  }
console.log(
  'tools',
  toolList(m)
    .filter((x) => x.startsWith('mcp__'))
    .join(','),
);
s.child.kill('SIGTERM');
m.close();
setTimeout(() => process.exit(0), 1500);
