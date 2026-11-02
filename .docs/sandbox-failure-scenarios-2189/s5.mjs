import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  startFakeModel,
  patchFile,
  mcpPatch,
  startServe,
  client,
  turn,
  toolResults,
  procs,
  streams,
} from './lib.mjs';
const B = process.env.B;
const home = `${B}/home`,
  ws = `${B}/ws`,
  log = `${home}/log`,
  roots = `${home}/thread-roots`;
for (const d of [log, ws]) mkdirSync(d, { recursive: true });
writeFileSync(`${ws}/plain.txt`, 'plain\n');
execFileSync('mkfifo', [`${ws}/p.fifo`]);
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const interesting = () =>
  procs()
    .filter((p) => /mcp-fake|spawner|\brg\b|\bgit\b|serve\.js/.test(p.cmd))
    .map((p) => `${p.pid}/ppid${p.ppid}/${p.state} ${p.cmd.slice(0, 70)}`);
const m = await startFakeModel();
patchFile(`${B}/p.yml`, m.baseUrl, mcpPatch());
let s = await startServe({ home, ws, logDir: log, patch: `${B}/p.yml` });
let c = await client(s);
await turn(c, 'seed', [
  { name: 'write_file', args: { file_path: '/seed.txt', content: 'keep' } },
  { name: 'mcp__free__ping', args: {} },
  { name: 'mcp__box__ping', args: {} },
]);
const root = `${roots}/${readdirSync(roots).filter((x) => x.startsWith('thread-'))[0]}`;
console.log('warm', toolResults(m).length, interesting());
const bg = [];
const go = (t, steps) => {
  bg.push(turn(c, t, steps, { limitMs: 600000 }).catch(() => {}));
};
go('h-box', [{ name: 'mcp__box__hang', args: {} }]);
go('h-free', [{ name: 'mcp__free__hang', args: {} }]);
go('rg', [{ name: 'grep', args: { pattern: 'x', path: '/shared/p.fifo' } }]);
go('rg2', [{ name: 'glob', args: { pattern: '**/*', path: '/shared' } }]);
await sleep(1500);
console.log('during', interesting());
console.log(
  'rgres',
  toolResults(m)
    .slice(-2)
    .map((x) => x.slice(0, 200)),
);
// 大檔寫到一半殺
go('big', [
  {
    name: 'write_file',
    args: {
      file_path: '/big.bin',
      content: '@BIG',
      size: Number(process.env.BIG ?? 200 * 1024 * 1024),
    },
  },
]);
const t0 = Date.now();
let seen;
while (Date.now() - t0 < 30000) {
  try {
    seen = readdirSync(`${roots}`)
      .flatMap((d) => (d.startsWith('thread-') ? readdirSync(`${roots}/${d}`) : []))
      .find((n) => /tmp/.test(n));
  } catch {}
  if (seen) break;
  await new Promise((r) => setImmediate(r));
}
console.log('saw tmp', seen, Date.now() - t0);
const pre = interesting();
s.child.kill('SIGKILL');
const k = Date.now();
await sleep(1000);
console.log('+1s', interesting());
await sleep(6000);
console.log('+7s', interesting());
const leftovers = () => {
  try {
    return execFileSync('find', [
      home,
      '-name',
      '*.tmp*',
      '-o',
      '-name',
      'serve.lock',
      '-o',
      '-name',
      '*.lock',
    ])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch (e) {
    return [e.message];
  }
};
console.log('leftover', leftovers());
for (const k of Object.keys(streams)) delete streams[k];
const t1 = Date.now();
try {
  s = await startServe({ home, ws, logDir: log, patch: `${B}/p.yml` });
  c = await client(s);
  console.log(
    'restart ok',
    Date.now() - t1,
    s
      .output()
      .split('\n')
      .filter((l) => /\[W\]|\[E\]|lock|孤|殘/.test(l))
      .map((l) => l.slice(20, 170))
      .slice(0, 8),
  );
} catch (e) {
  console.log('restart FAIL', e.message.slice(0, 600));
  process.exit(0);
}
await sleep(1500);
console.log('after restart procs', interesting());
for (const t of ['seed', 'h-box', 'h-free', 'big']) {
  const n0 = toolResults(m).length;
  const r = await turn(c, t, [{ name: 'read_file', args: { file_path: '/seed.txt' } }], {
    limitMs: 30000,
  }).catch((e) => ({ end: 'THROW ' + e.message.slice(0, 200) }));
  console.log(
    `[續接 ${t}] ${r.end} ::`,
    toolResults(m).slice(n0).join('|').slice(0, 160).replace(/\n/g, ' '),
  );
}
const h = await c.threadHistory?.('big').catch((e) => e.message);
console.log('big 歷史尾', JSON.stringify(h)?.slice(-300));
console.log('leftover after', leftovers(), 'root', readdirSync(root));
s.child.kill('SIGTERM');
await sleep(2500);
console.log('end procs', interesting());
m.close();
process.exit(0);
