import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

const HOOK = join(import.meta.dirname, 'cbm-graph-first.mjs');
const ROOT = '/repo';
const dir = mkdtempSync(join(tmpdir(), 'cbm-graph-first-test-'));

// 替身只認得幾個符號，外加一個只出現在 JSON 夾具的鍵（真圖會把它當 Variable）。
// 命中兩列以上時照真的 CLI 輸出 `rows_refs` 前綴表與 `@0+` 壓縮路徑。
const stub = join(dir, 'cbm');
writeFileSync(
  stub,
  `#!/usr/bin/env node
const { project, query } = JSON.parse(process.argv[process.argv.length - 1]);
const rows = {
  'nexus-agent': [
    ['runCli', 'apps/harness/src/cli.ts', '851'],
    ['configHash', 'fixtures/h.json', '3'],
    ['createAgent', 'apps/harness/src/a.test.ts', '10'],
    ['createAgent', 'apps/harness/src/agent.ts', '20'],
  ],
  'deepseek-harness': [['createGzipMiddleware', 'packages/host/webserver/src/index.ts', '239']],
}[project] ?? [];
const code = new RegExp(query.match(/=~ "(.*?)"/)[1].replace(/\\\\\\\\/g, '\\\\'));
const hit = rows.filter(([n, f]) => query.includes(JSON.stringify(n)) && code.test(f));
const pre = 'apps/harness/src/';
const packed = hit.length > 1 && hit.every(([, f]) => f.startsWith(pre));
if (packed) console.log('rows_refs: 1  (cols: id prefix)\\n  0 ' + pre + '\\nrows_ref_rule: @N+suffix=prefix+suffix');
console.log('rows: ' + hit.length + '  (cols: n.name n.file_path n.start_line)');
for (const [n, f, l] of hit) console.log('  ' + n + ' ' + (packed ? '@0+' + f.slice(pre.length) : f) + ' "' + l + '"');
`,
);
chmodSync(stub, 0o755);

let calls = 0;

function run(payload, env = {}) {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: `s${++calls}`, cwd: ROOT, ...payload }),
    encoding: 'utf8',
    env: { ...process.env, CBM_BIN: stub, CLAUDE_PROJECT_DIR: ROOT, TMPDIR: dir, ...env },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}

const bash = (command, extra = {}, env = {}) =>
  run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra }, env);

test('grep 圖裡有的符號會被擋，理由列出定義位置', () => {
  const out = bash('rg -n runCli apps');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /runCli {2}apps\/harness\/src\/cli\.ts:851/);
});

test('圖裡沒有的字串、只在 JSON 夾具裡的鍵、不是搜尋的指令都放行', () => {
  assert.equal(bash('rg -n "ENOENT: no such file" apps'), null);
  assert.equal(bash('rg -n configHash apps'), null);
  assert.equal(bash('cat apps/harness/src/cli.ts | head'), null);
});

test('references/ 底下的搜尋查對應專案的圖', () => {
  assert.equal(bash('grep -rn runCli references/deepseek-harness/packages'), null);
  const out = bash('grep -rn createGzipMiddleware references/deepseek-harness/packages');
  assert.match(out.permissionDecisionReason, /圖譜 deepseek-harness/);
});

test('搜尋落在 repo 外就放行，worktree 內照擋', () => {
  assert.equal(bash('cd /tmp/copy && rg -n runCli .'), null);
  assert.equal(bash('S=/private/tmp/x; grep -rn runCli $S/apps'), null);
  assert.equal(
    bash(`cd ${ROOT}/.claude/worktrees/w && rg -n runCli apps`).permissionDecision,
    'deny',
  );
  assert.equal(bash(`cd ${ROOT}-old && rg -n runCli apps`), null);
});

test('用絕對路徑叫 grep、包在 $( ) 裡的搜尋照擋', () => {
  assert.equal(bash('/usr/bin/grep -rn runCli apps').permissionDecision, 'deny');
  assert.equal(bash('wc -l $(grep -rl runCli apps)').permissionDecision, 'deny');
});

test('同一 session 用圖查過之後，同樣的 grep 放行；別的 session 照擋', () => {
  run({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__codebase-memory-mcp__search_graph',
    tool_input: { project: 'nexus-agent', name_pattern: 'runCli' },
    session_id: 'looked',
  });
  assert.equal(bash('rg -n runCli apps', { session_id: 'looked' }), null);
  assert.equal(bash('rg -n runCli apps', { session_id: 'other' }).permissionDecision, 'deny');
});

test('同一 session 第二次跑同樣的 grep 放行，換一個名字照擋', () => {
  const session = { session_id: 'twice' };
  assert.equal(bash('rg -n runCli apps', session).permissionDecision, 'deny');
  assert.equal(bash('rg -n runCli apps', session), null);
  assert.equal(
    bash('grep -rn createGzipMiddleware references/deepseek-harness', session).permissionDecision,
    'deny',
  );
});

test('多列共用路徑前綴的壓縮輸出照擋，理由裡的路徑展開成完整路徑', () => {
  const out = bash('rg -n createAgent apps');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(
    out.permissionDecisionReason,
    /createAgent {2}apps\/harness\/src\/agent\.ts:20（另有 1 處）/,
  );
});

test('查過的名字要完全相同才放行', () => {
  run({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__codebase-memory-mcp__search_graph',
    tool_input: { name_pattern: '^runCliFoo$' },
    session_id: 'longer',
  });
  assert.equal(bash('rg -n runCli apps', { session_id: 'longer' }).permissionDecision, 'deny');
});

test('Grep 工具同樣適用', () => {
  const out = run({
    hook_event_name: 'PreToolUse',
    tool_name: 'Grep',
    tool_input: { pattern: 'runCli' },
  });
  assert.equal(out.permissionDecision, 'deny');
});

test('找不到 codebase-memory-mcp 或它出錯時一律放行', () => {
  assert.equal(bash('rg -n runCli apps', {}, { CBM_BIN: join(dir, 'missing'), HOME: dir }), null);
  assert.equal(bash('rg -n runCli apps', {}, { CBM_BIN: '/usr/bin/false' }), null);
});
