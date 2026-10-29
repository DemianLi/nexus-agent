// #1946 第 6 條：bwrap 在 spawner 的子行程裡建不建得了 namespace（繼承的 seccomp 擋 namespace 系列）。
import { Spawner } from './client.mjs';
const s = new Spawner(process.env.SPAWNER, '/tmp/spawner-bwrap.sock');
await s.ready;
console.log(JSON.stringify({ spawner: s.info }));
const ws = process.env.WS;
for (const argv of [
  ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '/bin/true'],
  ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-all', '/bin/true'],
  ['/usr/bin/unshare', '--user', '/bin/true'],
]) {
  const r = await s.run(argv, null, { ws, readable: ['/'], writable: [ws, '/tmp'] });
  console.log(
    JSON.stringify({
      argv: argv.join(' '),
      code: r.code,
      sig: r.sig,
      fail: r.fail,
      stderr: r.err.toString().trim(),
    }),
  );
}
s.close();
