import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  startFakeModel,
  patchFile,
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
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const inter = () =>
  procs()
    .filter((p) => /\bgit\b|\brg\b/.test(p.cmd))
    .map((p) => `${p.pid}/${p.ppid}/${p.state} ${p.cmd.slice(0, 70)}`);
const m = await startFakeModel();
patchFile(`${B}/p.yml`, m.baseUrl);
let s = await startServe({ home, ws, logDir: log, patch: `${B}/p.yml` });
let c = await client(s);
await turn(c, 'g', [{ name: 'write_file', args: { file_path: '/a.txt', content: 'a' } }]);
const r = `${roots}/${readdirSync(roots).filter((x) => x.startsWith('thread-'))[0]}`;
execFileSync('git', ['-C', r, 'init', '-q']);
for (let i = 0; i < 30000; i++) writeFileSync(`${r}/f${i}.txt`, `line ${i}\n`);
const p = turn(c, 'g', [{ name: 'write_file', args: { file_path: '/b.txt', content: 'b' } }], {
  limitMs: 60000,
}).catch(() => {});
const t0 = Date.now();
let g = [];
while (Date.now() - t0 < 30000) {
  g = inter();
  if (g.length) break;
  await sleep(5);
}
console.log('git seen', g, Date.now() - t0);
s.child.kill('SIGKILL');
await sleep(1000);
console.log('+1s', inter());
await sleep(4000);
console.log('+5s', inter());
for (const k of Object.keys(streams)) delete streams[k];
s = await startServe({ home, ws, logDir: log, patch: `${B}/p.yml` });
c = await client(s);
const a = await turn(c, 'g', [{ name: 'read_file', args: { file_path: '/a.txt' } }], {
  limitMs: 30000,
});
console.log('resume', a.end, toolResults(m).at(-1)?.slice(0, 120));
s.child.kill('SIGTERM');
await sleep(2000);
m.close();
process.exit(0);
