import { mkdirSync, writeFileSync, readdirSync, readFileSync, cpSync, copyFileSync } from 'node:fs';
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
  ws = `${process.env.B}/ws`,
  log = `${home}/log`,
  roots = `${home}/thread-roots`;
mkdirSync(log, { recursive: true });
mkdirSync(ws, { recursive: true });
copyFileSync('/big/huge.txt', `${ws}/huge.txt`);
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const inter = () =>
  procs()
    .filter((p) => /mcp-fake|spawner|\brg\b|\bgit\b|serve\.js/.test(p.cmd))
    .map(
      (p) =>
        `${p.pid}/ppid${p.ppid}/${p.state} ${p.cmd.replace(/.*\//, '').slice(0, 50)}|${p.cmd.split(' ')[0].split('/').pop()}`,
    );
const polite = `- insert:
    - id: mcp-nice
      name: '@nexus/plugin-mcp'
      config:
        serverName: nice
        approval: { default: allow }
        connection:
          transport: stdio
          command: /usr/local/bin/node
          args: [/run2189/mcpdir/mcp-fake.mjs, polite]
`;
const m = await startFakeModel();
patchFile(`${B}/p.yml`, m.baseUrl, polite);
let s = await startServe({ home, ws, logDir: log, patch: `${B}/p.yml` });
let c = await client(s);
const waitFor = async (re, ms) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const l = inter().filter((x) => re.test(x));
    if (l.length) return l;
    await sleep(20);
  }
  return null;
};
const crash = async (tag) => {
  s.child.kill('SIGKILL');
  await sleep(1000);
  console.log(tag, '+1s', inter());
  await sleep(4000);
  console.log(tag, '+5s', inter());
  console.log(
    tag,
    'tmp',
    execFileSync('sh', ['-c', `find ${home} -name '*.tmp*' | head`])
      .toString()
      .trim(),
  );
  for (const k of Object.keys(streams)) delete streams[k];
  s = await startServe({ home, ws, logDir: log, patch: `${B}/p.yml` });
  c = await client(s);
  console.log(tag, 'restart ok');
};
// rg 跑到一半
await turn(c, 'warm', [{ name: 'mcp__nice__ping', args: {} }]);
const p1 = turn(
  c,
  'rg',
  [{ name: 'grep', args: { pattern: 'no(such)+thing[0-9]{9}', path: '/shared' } }],
  { limitMs: 60000 },
).catch(() => {});
const rg = await waitFor(/\brg\b/, 20000);
console.log('rg seen', rg);
await crash('rg');
await sleep(200);
// git 跑到一半
const r2 = await turn(
  c,
  'gitseed',
  [{ name: 'write_file', args: { file_path: '/g.txt', content: 'g' } }],
  { limitMs: 30000 },
);
console.log('gitseed', r2.end);
const dirs = readdirSync(roots).filter((x) => x.startsWith('thread-'));
const gr = `${roots}/${dirs.at(-1)}`;
copyFileSync('/big/huge.txt', `${gr}/huge.bin`);
const p2 = turn(
  c,
  'gitseed',
  [{ name: 'write_file', args: { file_path: '/g2.txt', content: 'g' } }],
  { limitMs: 60000 },
).catch(() => {});
const git = await waitFor(/\bgit\b/, 20000);
console.log('git seen', git);
if (git) await crash('git');
// 寫檔到一半
const p3 = turn(
  c,
  'wr',
  [{ name: 'write_file', args: { file_path: '/w.bin', content: '@BIG', size: 30 * 1024 * 1024 } }],
  { limitMs: 60000 },
).catch(() => {});
const t0 = Date.now();
let seen;
while (Date.now() - t0 < 25000) {
  for (const d of readdirSync(roots)) {
    if (!d.startsWith('thread-')) continue;
    const h = readdirSync(`${roots}/${d}`).find((n) => /tmp/.test(n));
    if (h) seen = `${d}/${h}`;
  }
  if (seen) break;
  await sleep(1);
}
console.log('write tmp seen', seen, Date.now() - t0);
await crash('write');
console.log(
  'final tmp',
  execFileSync('sh', ['-c', `find ${home} -name '*.tmp*' | head`])
    .toString()
    .trim(),
);
for (const t of ['rg', 'gitseed', 'wr']) {
  const r = await turn(c, t, [{ name: 'glob', args: { pattern: '*', path: '/' } }], {
    limitMs: 30000,
  }).catch((e) => ({ end: 'THROW ' + e.message }));
  console.log(`[續接 ${t}] ${r.end}`, toolResults(m).at(-1)?.slice(0, 200).replace(/\n/g, ' '));
}
s.child.kill('SIGTERM');
await sleep(2000);
m.close();
process.exit(0);
