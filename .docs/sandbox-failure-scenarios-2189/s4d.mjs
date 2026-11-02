import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  startFakeModel,
  patchFile,
  startServe,
  client,
  turn,
  toolResults,
  streams,
} from './lib.mjs';
const home = '/small/h',
  roots = `${home}/thread-roots`,
  ws = '/run2189/ws',
  log = `${home}/log`;
for (const d of [log, ws]) mkdirSync(d, { recursive: true });
writeFileSync(`${ws}/plain.txt`, 'plain\n');
const fill = (p) => {
  const fd = openSync(p, 'a');
  let n = 0;
  for (const sz of [1 << 20, 1 << 16, 4096, 512, 1]) {
    const b = Buffer.alloc(sz, 1);
    try {
      for (;;) {
        writeSync(fd, b);
        n += sz;
      }
    } catch {}
  }
  closeSync(fd);
  return n;
};
const m = await startFakeModel();
patchFile('/run2189/p.yml', m.baseUrl);
let s = await startServe({ home, ws, logDir: log, patch: '/run2189/p.yml' });
let c = await client(s);
let t0 = Date.now();
s.child.on('exit', (a, b) =>
  console.log(
    'SERVE EXIT',
    a,
    b,
    Date.now() - t0,
    'ms; 尾',
    s.output().slice(-700).replace(/\n/g, ' / '),
  ),
);
const ready = async () => {
  const r = await fetch(`${s.url}/readyz`);
  return `${r.status} ${await r.text()}`;
};
const go = async (l, t, st) => {
  const n0 = toolResults(m).length;
  const r = await turn(c, t, st, { limitMs: 30000 });
  const root = r.frames
    .filter((f) => f.method === 'lifecycle' && f.params.data?.graph_name === 'root')
    .map((f) => f.params.data)
    .at(-1);
  console.log(
    `[${l}] ${r.end} ${JSON.stringify(root).slice(0, 160)} :: ${toolResults(m).slice(n0).join('|').replace(/\s+/g, ' ').slice(0, 220)}`,
  );
};
await go('seed', 'a', [
  { name: 'write_file', args: { file_path: '/keep.txt', content: 'ORIGINAL\n' } },
]);
const r = `${roots}/${readdirSync(roots).filter((x) => x.startsWith('thread-'))[0]}`;
fill(`${home}/filler`);
await go('滿 同 thread 寫', 'a', [
  { name: 'write_file', args: { file_path: '/keep.txt', content: 'NEW'.repeat(100000) } },
]);
await go('滿 新 thread', 'b', [{ name: 'read_file', args: { file_path: '/shared/plain.txt' } }]);
console.log(
  'keep',
  JSON.stringify(readFileSync(`${r}/keep.txt`, 'utf8').slice(0, 30)),
  'readyz',
  await ready(),
  'tmps',
  execFileSync('sh', ['-c', `find ${home} -name '*.tmp*' | head -5`])
    .toString()
    .trim(),
);
const pid = s.child.pid;
const url = s.url;
t0 = Date.now();
s.child.kill('SIGTERM');
const st = () => {
  try {
    const x = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return x.slice(x.lastIndexOf(')') + 2, x.lastIndexOf(')') + 3);
  } catch {
    return 'gone';
  }
};
for (let i = 0; i < 14; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const l = await fetch(`${url}/readyz`).then(
    (r) => r.status,
    (e) => 'conn:' + (e.cause?.code ?? e.message),
  );
  console.log(`+${Date.now() - t0}ms state=${st()} readyz=${l} exitCode=${s.child.exitCode}`);
  if (st() === 'gone' || st() === 'Z') break;
}
console.log('tail', s.output().slice(-600).replace(/\n/g, ' / '));
for (const k of Object.keys(streams)) delete streams[k];
try {
  s = await startServe({ home, ws, logDir: log, patch: '/run2189/p.yml' });
  c = await client(s);
  console.log('滿時重啟 ok');
} catch (e) {
  console.log('滿時重啟 FAIL', e.message.slice(0, 400).replace(/\n/g, ' / '));
}
rmSync(`${home}/filler`);
if (s.child.exitCode !== null || s.child.killed) {
  for (const k of Object.keys(streams)) delete streams[k];
  s = await startServe({ home, ws, logDir: log, patch: '/run2189/p.yml' });
  c = await client(s);
  console.log('釋放後重啟 ok');
}
await go('釋放後續接', 'a', [{ name: 'read_file', args: { file_path: '/keep.txt' } }]);
s.child.kill('SIGTERM');
m.close();
setTimeout(() => process.exit(0), 1500);
