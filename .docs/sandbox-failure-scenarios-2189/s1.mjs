import { mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import {
  startFakeModel,
  patchFile,
  startServe,
  client,
  turn,
  toolResults,
  toolList,
} from './lib.mjs';
const B = process.env.B;
const home = `${B}/home`,
  ws = `${B}/ws`,
  log = `${B}/log`,
  out = `${B}/outside`;
for (const d of [home, ws, log, out]) mkdirSync(d, { recursive: true });
const SECRET = 'OUTSIDE-SECRET-2189';
writeFileSync(`${out}/secret.txt`, SECRET + '\n');
writeFileSync(`${ws}/plain.txt`, 'plain\n');
symlinkSync(`${out}/secret.txt`, `${ws}/link.txt`);
symlinkSync(out, `${ws}/linkdir`);
symlinkSync('plain.txt', `${ws}/inner.txt`);
symlinkSync(`${out}/nope`, `${ws}/dangling`);
let planted = false;
const m = await startFakeModel({
  onRequest(body) {
    if (planted || !body.messages.some((x) => x.role === 'tool')) return;
    const d = `${home}/thread-roots`;
    const root = `${d}/${readdirSync(d)[0]}`;
    symlinkSync(`${out}/secret.txt`, `${root}/plink.txt`);
    symlinkSync(out, `${root}/plinkdir`);
    planted = true;
  },
});
patchFile(`${B}/p.yml`, m.baseUrl);
const s = await startServe({ home, ws, logDir: log, patch: `${B}/p.yml` });
const c = await client(s);
const P = '/shared';
const steps = [
  ['seed', 'write_file', { file_path: '/seed.txt', content: 'seed' }],
  ['read 普通檔(對照)', 'read_file', { file_path: `${P}/plain.txt` }],
  ['read 內部相對連結', 'read_file', { file_path: `${P}/inner.txt` }],
  ['read 根外檔連結', 'read_file', { file_path: `${P}/link.txt` }],
  ['read 根外目錄連結', 'read_file', { file_path: `${P}/linkdir/secret.txt` }],
  ['read 懸空連結', 'read_file', { file_path: `${P}/dangling` }],
  ['grep 對照 plain', 'grep', { pattern: 'pla[i]n', path: P }],
  ['grep /shared', 'grep', { pattern: 'OUTSIDE-SECRET-21[8]9', path: P }],
  ['grep 指連結檔', 'grep', { pattern: 'OUTSIDE-SECRET-21[8]9', path: `${P}/link.txt` }],
  ['grep 指連結目錄', 'grep', { pattern: 'OUTSIDE-SECRET-21[8]9', path: `${P}/linkdir` }],
  ['glob /shared', 'glob', { pattern: '**/*', path: P }],
  ['glob 指連結目錄', 'glob', { pattern: '**/*', path: `${P}/linkdir` }],
  ['write /shared 連結', 'write_file', { file_path: `${P}/link.txt`, content: 'X' }],
  ['read 私有根檔連結', 'read_file', { file_path: '/plink.txt' }],
  ['read 私有根目錄連結', 'read_file', { file_path: '/plinkdir/secret.txt' }],
  ['write 私有根檔連結', 'write_file', { file_path: '/plink.txt', content: 'PWN' }],
  ['write 私有根目錄連結', 'write_file', { file_path: '/plinkdir/new.txt', content: 'PWN' }],
  [
    'edit 私有根檔連結',
    'edit_file',
    { file_path: '/plink.txt', old_string: SECRET, new_string: 'PWN' },
  ],
  ['grep 私有根', 'grep', { pattern: 'OUTSIDE-SECRET-21[8]9', path: '/' }],
  ['glob 私有根', 'glob', { pattern: '**/*', path: '/' }],
];
const r = await turn(
  c,
  't2',
  steps.map(([, name, args]) => ({ name, args })),
  { limitMs: 120000 },
);
console.log('end', r.end, r.ms, 'tools', toolList(m).length);
const res = toolResults(m);
steps.forEach(([l], i) => {
  const t = res[i] ?? '<none>';
  console.log(`[${l}] leak=${t.includes(SECRET)} :: ${t.slice(0, 300).replace(/\n/g, ' ')}`);
});
console.log('outside', readdirSync(out), JSON.stringify(readFileSync(`${out}/secret.txt`, 'utf8')));
s.child.kill('SIGTERM');
m.close();
setTimeout(() => process.exit(0), 1500);
