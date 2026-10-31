import { mkdirSync, writeFileSync } from 'node:fs';
import {
  startFakeModel,
  patchFile,
  mcpPatch,
  startServe,
  client,
  turn,
  toolResults,
  procs,
} from './lib.mjs';
const B = process.env.B;
const home = `${B}/home`,
  ws = `${B}/ws`,
  log = `${B}/log`;
for (const d of [home, ws, log]) mkdirSync(d, { recursive: true });
writeFileSync(`${ws}/plain.txt`, 'plain\n');
const m = await startFakeModel();
patchFile(
  `${B}/p.yml`,
  m.baseUrl,
  `- id: turn-timeout\n  config:\n    timeoutMs: ${process.env.TURN_MS ?? 45000}\n` + mcpPatch(),
);
const s = await startServe({ home, ws, logDir: log, patch: `${B}/p.yml` });
const c = await client(s);
const ps = () =>
  procs()
    .filter((p) => /mcp-fake|spawner/.test(p.cmd))
    .map((p) => `${p.pid}/${p.ppid}/${p.state} ${p.cmd.slice(0, 50)}`);
console.log('turnClock line', /一輪的時鐘[^\n]*/.exec(s.output())?.[0]?.slice(0, 60));
await turn(c, 'warm', [
  { name: 'mcp__free__ping', args: {} },
  { name: 'mcp__box__ping', args: {} },
]);
console.log(
  'warm',
  toolResults(m).map((x) => x.slice(-14)),
  ps(),
);
for (const [srv, tool, cancelAt] of [
  ['box', 'hang'],
  ['free', 'hang'],
  ['box', 'spin'],
  ['free', 'spin'],
  ['box', 'hang', 3000],
  ['free', 'spin', 3000],
]) {
  const t = `x-${srv}-${tool}-${cancelAt ?? 'none'}`;
  const n0 = toolResults(m).length,
    t0 = Date.now();
  const p = turn(c, t, [{ name: `mcp__${srv}__${tool}`, args: {} }], { limitMs: 130000 });
  await new Promise((r) => setTimeout(r, 1500));
  const bt = Date.now();
  const b = await turn(
    c,
    `${t}-other`,
    [{ name: 'read_file', args: { file_path: '/shared/plain.txt' } }],
    { limitMs: 20000 },
  );
  const otherMs = Date.now() - bt;
  const pt = Date.now();
  const bb = await turn(c, `${t}-ping`, [{ name: `mcp__${srv}__ping`, args: {} }], {
    limitMs: 100000,
  });
  const pingMs = Date.now() - pt;
  if (cancelAt) {
    await c.runCancel(t).catch((e) => console.log('cancel err', e.message));
  }
  const r = await p;
  const res = toolResults(m).slice(n0);
  console.log(
    `[${t}] end=${r.end} ${r.ms}ms other=${b.end}/${otherMs}ms ping=${bb.end}/${pingMs}ms cpu-procs=${JSON.stringify(ps())}`,
  );
  console.log('   results', res.map((x) => x.replace(/\s+/g, ' ').slice(0, 200)).join(' || '));
  const f = r.frames
    .filter(
      (f) =>
        f.method === 'lifecycle' &&
        f.params.namespace.length === 0 &&
        f.params.data?.graph_name === 'root',
    )
    .map((f) => JSON.stringify(f.params.data).slice(0, 220));
  console.log('   root', f.slice(-2).join(' '));
  const a = await turn(c, `${t}-after`, [{ name: `mcp__${srv}__ping`, args: {} }], {
    limitMs: 75000,
  });
  console.log('   after-ping', a.end, a.ms, toolResults(m).at(-1)?.slice(-40).replace(/\s+/g, ' '));
}
const t0 = Date.now();
s.child.kill('SIGTERM');
await new Promise((r) => {
  s.child.once('exit', (c, sg) => {
    console.log('serve exit', c, sg, Date.now() - t0);
    r();
  });
  setTimeout(r, 40000);
});
await new Promise((r) => setTimeout(r, 3000));
console.log('after-term procs', JSON.stringify(ps()));
m.close();
process.exit(0);
