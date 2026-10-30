import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
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
const B = process.env.B;
const home = `${B}/home`,
  log = `${home}/log`;
mkdirSync(log, { recursive: true });
console.log(
  execFileSync('sh', [
    '-c',
    'id; ls -ld /big /big/huge.txt; head -c 20 /big/huge.txt; echo; R=$(ls -d /run2189/nexus*/); $(find $R -name rg -type f | head -1) -c nexus /big | head -2',
  ]).toString(),
);
for (const [tag, ws] of [
  ['big', '/big'],
  ['tmpfs', `${B}/ws`],
]) {
  mkdirSync(`${B}/ws`, { recursive: true });
  writeFileSync(`${B}/ws/plain.txt`, 'nexus\n');
  const m = await startFakeModel();
  patchFile(`${B}/p.yml`, m.baseUrl);
  const h2 = `${home}-${tag}`;
  mkdirSync(`${h2}/log`, { recursive: true });
  let s = await startServe({ home: h2, ws, logDir: `${h2}/log`, patch: `${B}/p.yml` });
  let c = await client(s);
  const steps = [
    { name: 'write_file', args: { file_path: '/a.txt', content: 'nexus' } },
    { name: 'glob', args: { pattern: '*', path: '/' } },
    { name: 'glob', args: { pattern: '*', path: '/shared' } },
    { name: 'grep', args: { pattern: 'nexus', path: '/shared' } },
  ];
  let r = await turn(c, 't', steps, { limitMs: 30000 });
  console.log(
    tag,
    'first',
    r.end,
    toolResults(m).map((x) => x.slice(0, 140).replace(/\n/g, ' ')),
  );
  s.child.kill('SIGTERM');
  await new Promise((r) => s.child.once('exit', r));
  for (const k of Object.keys(streams)) delete streams[k];
  s = await startServe({ home: h2, ws, logDir: `${h2}/log`, patch: `${B}/p.yml` });
  c = await client(s);
  const n0 = toolResults(m).length;
  r = await turn(c, 't', steps.slice(1), { limitMs: 30000 });
  console.log(
    tag,
    'resumed',
    r.end,
    toolResults(m)
      .slice(n0)
      .map((x) => x.slice(0, 140).replace(/\n/g, ' ')),
  );
  s.child.kill('SIGTERM');
  await new Promise((r) => s.child.once('exit', r));
  m.close();
  for (const k of Object.keys(streams)) delete streams[k];
}
process.exit(0);
