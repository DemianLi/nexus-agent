// #1946 A 第 5 條：每次 spawn 多出的時間，從 Node 量（不進 repo）。
// 終點對齊研究 S3 的 node-spawn3.mjs：收到結束碼，而且 stdin、stdout、stderr 三條都關了。p50 取排序後 round((n-1)*p)，暖機 30 次，
// 每個 iteration 用帶種子的 mulberry32 打亂變體順序。
// 用法：node bench.mjs <N> <seed> <concurrency>
//   concurrency=1：一次一個；>1：每個 iteration 每個變體同時起 C 個，量每一個的牆鐘。
// 變體：
//   true      /bin/true，stdio pipe（direct／spawner）
//   cat       寫 4096 bytes、讀回來核對
//   loop      CPU 為主的子行程（sh 迴圈 3000 次）：量子行程本身有沒有變慢（推測執行緩解旗標會被繼承）
//   syscalls  syscall 為主的子行程（dd bs=1 count=4000，約 8000 次 read/write）：量繼承的過濾器每次 syscall 的成本
//   aa        direct 對 direct（A/A），看量具本身的偏差
import { spawn } from 'node:child_process';
import { Spawner } from './client.mjs';

const [nArg, seedArg, cArg] = process.argv.slice(2);
const N = Number(nArg),
  SEED = Number(seedArg) >>> 0,
  C = Number(cArg || 1);
const BIN = process.env.SPAWNER || '/b/nexus-sandbox-spawner';
const WS = process.env.WS || '/work/ws';
const READABLE = ['/usr', '/bin', '/lib', '/etc', '/proc', '/dev/zero'].concat(
  process.env.EXTRA_RO ? [process.env.EXTRA_RO] : [],
);
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.round((s.length - 1) * p)].toFixed(1);
};
const PAYLOAD = Buffer.alloc(4096);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 31 + 7) & 0xff;
const hr = () => process.hrtime.bigint();
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function direct(argv, input) {
  return new Promise((res) => {
    const p = spawn(argv[0], argv.slice(1), {
      stdio: 'pipe',
      cwd: WS,
      env: { PATH: '/usr/bin:/bin' },
    });
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.resume();
    p.stdin.on('error', () => {});
    p.stdin.end(input || undefined);
    p.on('close', (code, sig) => res({ code, sig, started: true, out: Buffer.concat(out) }));
  });
}

const CMDS = {
  true: ['/bin/true'],
  cat: ['/bin/cat'],
  loop: ['/bin/sh', '-c', 'i=0; while [ $i -lt 3000 ]; do i=$((i+1)); done'],
  syscalls: ['/bin/dd', 'if=/dev/zero', 'of=/dev/null', 'bs=1', 'count=4000', 'status=none'],
};
const spawner = new Spawner(BIN, process.env.SOCK || '/tmp/spawner.sock');
await spawner.ready;
const vars = [];
for (const [name, argv] of Object.entries(CMDS)) {
  vars.push({ name, how: 'direct', argv, w: [], bad: 0, why: [] });
  vars.push({ name, how: 'spawner', argv, w: [], bad: 0, why: [] });
}
vars.push(
  { name: 'aa', how: 'direct', argv: CMDS.true, w: [], bad: 0, why: [] },
  { name: 'aa', how: 'direct2', argv: CMDS.true, w: [], bad: 0, why: [] },
);

const once = async (v) => {
  const input = v.name === 'cat' ? PAYLOAD : null;
  const t = hr();
  const r =
    v.how === 'spawner'
      ? await spawner.run(v.argv, input, { ws: WS, readable: READABLE })
      : await direct(v.argv, input);
  const w = Number(hr() - t) / 1e3;
  let why = null;
  if (r.code !== 0) why = `code=${r.code} sig=${r.sig} fail=${JSON.stringify(r.fail)}`;
  else if (v.name === 'cat' && !r.out.equals(PAYLOAD)) why = `cat mismatch ${r.out.length}`;
  else if (v.how === 'spawner' && (!r.started || r.partial))
    why = `started=${r.started} partial=${r.partial}`;
  return [w, why];
};
const batch = async (v) => {
  const rs = await Promise.all(Array.from({ length: C }, () => once(v)));
  for (const [w, why] of rs) {
    v.w.push(w);
    if (why) {
      v.bad++;
      if (v.why.length < 3) v.why.push(why);
    }
  }
};

for (let k = 0; k < 30; k++)
  for (const v of shuffle([...vars]))
    await (C > 1 ? Promise.all(Array.from({ length: C }, () => once(v))) : once(v));
for (let k = 0; k < N; k++) for (const v of shuffle([...vars])) await batch(v);
console.log(
  JSON.stringify({
    header: true,
    n: N,
    seed: SEED,
    concurrency: C,
    warmup: 30,
    node: process.version,
    spawner: spawner.info,
  }),
);
const p50 = {};
for (const v of vars) {
  p50[`${v.name}/${v.how}`] = pct(v.w, 0.5);
  console.log(
    JSON.stringify({
      variant: v.name,
      how: v.how,
      samples: v.w.length,
      bad: v.bad,
      why: v.why,
      p50_us: pct(v.w, 0.5),
      p90_us: pct(v.w, 0.9),
      p99_us: pct(v.w, 0.99),
    }),
  );
}
const delta = (n) => +(p50[`${n}/spawner`] - p50[`${n}/direct`]).toFixed(1);
console.log(
  JSON.stringify({
    delta_p50_us: {
      true: delta('true'),
      cat: delta('cat'),
      loop: delta('loop'),
      syscalls: delta('syscalls'),
      aa: +(p50['aa/direct2'] - p50['aa/direct']).toFixed(1),
    },
  }),
);
spawner.close();
