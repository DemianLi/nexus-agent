import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  openSync,
  writeSync,
  closeSync,
  existsSync,
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
  tmp = '/small/t',
  ws = '/small/ws',
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
const df = (p) =>
  execFileSync('df', ['-k', p]).toString().trim().split('\n').pop().replace(/\s+/g, ' ');
const tmps = (d) => {
  try {
    return execFileSync('find', [d, '-name', '*.tmp*'])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};
const rootOf = () =>
  readdirSync(roots)
    .filter((x) => x.startsWith('thread-'))
    .map((x) => `${roots}/${x}`);
const m = await startFakeModel();
patchFile('/small/p.yml', m.baseUrl);
const env = { TMPDIR: tmp };
let s = await startServe({ home, ws, logDir: log, patch: '/small/p.yml', env });
let c = await client(s);
const ready = async () => {
  const r = await fetch(`${s.url}/readyz`).catch((e) => ({ status: e.message, text: () => '' }));
  return `${r.status} ${await r.text()}`;
};
const last = (n0) =>
  toolResults(m)
    .slice(n0)
    .map((x) => x.replace(/\s+/g, ' ').slice(0, 260))
    .join(' || ');
const big = (p, size) => ({ name: 'write_file', args: { file_path: p, content: '@BIG', size } });
const safe = async (label, f) => {
  const n0 = toolResults(m).length;
  try {
    const r = await f();
    console.log(`[${label}] ${r.end} ${r.ms}ms :: ${last(n0)}`);
    return r;
  } catch (e) {
    console.log(`[${label}] THROW ${e.constructor.name} ${e.message.slice(0, 300)} :: ${last(n0)}`);
  }
};
// A 工作區（thread-roots）滿
await safe('A seed', () =>
  turn(c, 'a', [{ name: 'write_file', args: { file_path: '/keep.txt', content: 'ORIGINAL\n' } }]),
);
const ra = rootOf()[0];
console.log('A root', ra, df(roots));
const fa = `${ra}/filler`;
console.log('A filled', fill(fa), df(roots));
await safe('A 覆寫大檔', () => turn(c, 'a', [big('/keep.txt', 256 * 1024)]));
await safe('A 新檔', () => turn(c, 'a', [big('/new.txt', 256 * 1024)]));
await safe('A 小編輯', () =>
  turn(c, 'a', [
    {
      name: 'edit_file',
      args: {
        file_path: '/keep.txt',
        old_string: 'ORIGINAL',
        new_string: 'EDITED-WITH-A-LONGER-STRING',
      },
    },
  ]),
);
console.log(
  'A keep',
  JSON.stringify(readFileSync(`${ra}/keep.txt`, 'utf8').slice(0, 40)),
  'tmps',
  tmps(roots),
  'readyz',
  await ready(),
  'dir',
  readdirSync(ra),
);
rmSync(fa);
console.log('A freed', df(roots));
await safe('A 釋放後重寫', () => turn(c, 'a', [big('/keep.txt', 256 * 1024)]));
console.log('A size', statSync(`${ra}/keep.txt`).size, 'tmps', tmps(roots));
// C 暫存目錄滿
const ft = `${tmp}/filler`;
console.log('C filled', fill(ft), df(tmp));
await safe('C 寫檔', () =>
  turn(c, 'c', [
    { name: 'write_file', args: { file_path: '/c.txt', content: 'c' } },
    { name: 'grep', args: { pattern: 'plain', path: '/shared' } },
    { name: 'read_file', args: { file_path: '/c.txt' } },
  ]),
);
await safe('C 大結果外溢', () =>
  turn(c, 'c', [
    big('/c-big.txt', 300 * 1024),
    { name: 'read_file', args: { file_path: '/c-big.txt' } },
  ]),
);
console.log('C readyz', await ready());
rmSync(ft);
// B home 滿（日誌同檔案系統）
const fh = `${home}/filler`;
console.log('B seed');
await safe('B seed', () =>
  turn(c, 'b', [{ name: 'write_file', args: { file_path: '/b.txt', content: 'b' } }]),
);
console.log('B filled', fill(fh), df(home));
const r1 = await safe('B 滿時開輪', () =>
  turn(c, 'b', [{ name: 'write_file', args: { file_path: '/b2.txt', content: 'b2' } }], {
    limitMs: 30000,
  }),
);
console.log(
  'B root frames',
  JSON.stringify(
    r1?.frames
      .filter((f) => f.method === 'lifecycle' && f.params.data?.graph_name === 'root')
      .map((f) => f.params.data),
  ).slice(0, 400),
);
const r2 = await safe('B 滿時新 thread', () =>
  turn(c, 'b-new', [{ name: 'read_file', args: { file_path: '/shared/plain.txt' } }], {
    limitMs: 30000,
  }),
);
console.log(
  'B new-thread',
  JSON.stringify(
    r2?.frames
      .filter((f) => f.method === 'lifecycle' && f.params.data?.graph_name === 'root')
      .map((f) => f.params.data),
  ).slice(0, 500),
);
console.log(
  'B readyz',
  await ready(),
  'alive',
  s.child.exitCode,
  'stderr-tail',
  s.output().slice(-500).replace(/\n/g, ' / '),
);
rmSync(fh);
console.log('B freed', df(home));
await safe('B 釋放後同 thread', () =>
  turn(c, 'b', [{ name: 'write_file', args: { file_path: '/b3.txt', content: 'b3' } }], {
    limitMs: 30000,
  }),
);
await safe('B 釋放後 b-new', () =>
  turn(c, 'b-new2', [{ name: 'read_file', args: { file_path: '/shared/plain.txt' } }], {
    limitMs: 30000,
  }),
);
console.log('B readyz', await ready());
// 重啟續接
const ex = new Promise((r) => s.child.once('exit', (c, g) => r([c, g])));
s.child.kill('SIGTERM');
console.log('term', await ex);
for (const k of Object.keys(streams)) delete streams[k];
s = await startServe({ home, ws, logDir: log, patch: '/small/p.yml', env });
c = await client(s);
await safe('重啟後續接 b', () =>
  turn(c, 'b', [{ name: 'write_file', args: { file_path: '/b4.txt', content: 'b4' } }], {
    limitMs: 30000,
  }),
);
await safe('重啟後續接 a', () =>
  turn(c, 'a', [{ name: 'read_file', args: { file_path: '/keep.txt' } }], { limitMs: 30000 }),
);
const lf = execFileSync('sh', ['-c', `grep -l b2.txt $(find ${log} -name '*.jsonl')`])
  .toString()
  .trim();
console.log(
  'b2 在日誌',
  lf.length > 0,
  'tool/result 筆數',
  readFileSync(lf.split('\n')[0], 'utf8')
    .split('\n')
    .filter((l) => l.includes('"tool/result"')).length,
);
s.child.kill('SIGTERM');
m.close();
setTimeout(() => process.exit(0), 1500);
