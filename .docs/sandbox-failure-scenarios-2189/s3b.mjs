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
  log = `${home}/log`;
for (const d of [log, ws]) mkdirSync(d, { recursive: true });
const m = await startFakeModel();
patchFile(`${B}/p.yml`, m.baseUrl, mcpPatch());
const s = await startServe({ home, ws, logDir: log, patch: `${B}/p.yml` });
const c = await client(s);
const ps = () =>
  procs()
    .filter((p) => /mcp-fake/.test(p.cmd))
    .map((p) => `${p.pid}/${p.state}`);
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const clk = /一輪的時鐘[^\n]*/.exec(s.output())?.[0]?.slice(0, 40);
console.log(clk);
await turn(c, 'w', [
  { name: 'mcp__free__ping', args: {} },
  { name: 'mcp__box__ping', args: {} },
]);
console.log('warm', ps());
const one = async (t, steps, lim = 100000) => {
  const n0 = toolResults(m).length;
  const r = await turn(c, t, steps, { limitMs: lim });
  console.log(
    `[${t}] ${r.end} ${r.ms}ms ${ps()} ::`,
    toolResults(m)
      .slice(n0)
      .map((x) => x.replace(/\s+/g, ' ').slice(0, 260))
      .join(' || '),
  );
  return r;
};
// 取消
for (const [srv, tool] of [
  ['box', 'hang'],
  ['free', 'hang'],
]) {
  const t = `cancel-${srv}-${tool}`;
  const p = turn(c, t, [{ name: `mcp__${srv}__${tool}`, args: {} }], { limitMs: 30000 });
  await sleep(3000);
  const t0 = Date.now();
  await c.runCancel(t).catch((e) => console.log('cancel err', e.message));
  const r = await p;
  console.log(`[${t}] ${r.end} 取消到收尾 ${Date.now() - t0}ms ${ps()}`);
}
await one('ping-after-cancel', [{ name: 'mcp__box__ping', args: {} }], 70000);
// 預設 60 秒工具逾時
await one('tool-timeout-box-hang', [{ name: 'mcp__box__hang', args: {} }]);
await one('ping-box', [{ name: 'mcp__box__ping', args: {} }], 70000);
await one('tool-timeout-free-spin', [{ name: 'mcp__free__spin', args: {} }]);
await one('ping-free-after-spin', [{ name: 'mcp__free__ping', args: {} }]);
{
  const t = 'cancel-spin-box';
  const p = turn(c, t, [{ name: 'mcp__box__spin', args: {} }], { limitMs: 30000 });
  await sleep(3000);
  const t0 = Date.now();
  await c.runCancel(t);
  const r = await p;
  console.log(`[${t}] ${r.end} ${Date.now() - t0}ms ${ps()}`);
}
await sleep(5000);
console.log('still spinning?', ps());
const t0 = Date.now();
s.child.kill('SIGTERM');
await new Promise((r) => {
  s.child.once('exit', (a, b) => {
    console.log('serve exit', a, b, Date.now() - t0);
    r();
  });
  setTimeout(r, 40000);
});
await sleep(3000);
console.log('after term', ps());
m.close();
process.exit(0);
