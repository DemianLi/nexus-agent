#!/usr/bin/env node
// Claude Code 的專案層 hook（掛法見 .claude/settings.json），一支檔處理兩個事件：
// - PreToolUse（Bash、Grep）：搜尋字串裡長得像符號的詞到圖譜做名稱完全比對，只認程式碼檔裡的定義；
//   有命中就 deny，理由列出定義位置。
// - PostToolUse（codebase-memory-mcp 的工具）：把 tool_input 記進 tmpdir 底下以 session 為檔名的檔。
// 同一個 session 裡，名字記在那個檔（查過，或被擋過一次）就放行。
// 讀不到輸入、找不到 codebase-memory-mcp、圖查詢出錯或逾時、輸出格式對不上、state 寫不進去，一律放行。
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const allow = () => process.exit(0);

const BIN = [process.env.CBM_BIN, join(homedir(), '.local/bin/codebase-memory-mcp')].find(
  (p) => p && existsSync(p),
);
const STATE_DIR = join(tmpdir(), 'cbm-graph-first');
const SEARCH_VERB = /(^|[\s;&|(/`])(rg|git\s+grep|grep\s+(-\w*[rR]\w*|--recursive))\s/;
const SYSTEM_PATH = /^\/(usr|bin|opt|dev)\//;
const SYMBOL =
  /(?<![\w$/.=-])([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9])(?![\w/=-]|\.(?:ts|tsx|js|mjs|json|md)\b)/g;
const CODE_FILE = '.*\\\\.(ts|tsx|mts|cts|js|mjs|cjs|rs|py)$';
const REFS = /references\/([\w.-]+)/;

function symbolsIn(text) {
  return [...new Set([...text.matchAll(SYMBOL)].map((m) => m[1]).filter((s) => s.length >= 6))];
}

function repoRoot() {
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || '';
  return dir.replace(/\/\.claude\/worktrees\/.*$/, '');
}

function outsideRepo(path, root) {
  return (
    path.startsWith('/') && !SYSTEM_PATH.test(path) && path !== root && !path.startsWith(root + '/')
  );
}

// 搜尋路徑在 repo 根之外（scratchpad、/tmp 的副本、放在 repo 外的 checkout）時圖譜對不上，放行。
// .claude/worktrees/ 底下的 worktree、相對路徑，以及 /usr、/bin、/opt、/dev 都算 repo 內。
function searchesOutsideRepo(command, root) {
  const vars = Object.fromEntries(
    [...command.matchAll(/(?:^|[\s;&])(\w+)=("?)(\/[^\s;&"]+)\2/g)].map((m) => [m[1], m[3]]),
  );
  const expand = (s) => s.replace(/\$\{?(\w+)\}?/g, (m, v) => vars[v] ?? m);
  const outside = (p) => outsideRepo(p, root);
  for (const seg of command.split(/;|&&|\|\||\|/)) {
    const cd = seg.match(/^\s*cd\s+("?)([^\s"]+)\1/);
    if (cd && outside(expand(cd[2]))) return true;
    if (SEARCH_VERB.test(seg)) {
      const paths = seg.match(/(?:^|\s)["']?(\$\{?\w+\}?[^\s"']*|\/[^\s"']+)/g) ?? [];
      if (paths.map((p) => expand(p.trim().replace(/^["']/, ''))).some(outside)) return true;
    }
  }
  return false;
}

function stateFile(sessionId) {
  return join(STATE_DIR, String(sessionId).replace(/[^\w-]/g, '_'));
}

function remember(sessionId, value) {
  if (!sessionId) return;
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(stateFile(sessionId), JSON.stringify(value) + '\n');
}

function lookedUp(sessionId) {
  try {
    return readFileSync(stateFile(sessionId), 'utf8');
  } catch {
    return '';
  }
}

function graphHits(project, names) {
  const list = names.map((n) => JSON.stringify(n)).join(',');
  const query =
    `MATCH (n) WHERE n.name IN [${list}] AND n.file_path =~ "${CODE_FILE}" ` +
    `RETURN n.name, n.file_path, n.start_line LIMIT 60`;
  const res = spawnSync(
    BIN,
    ['cli', '--quiet', 'query_graph', JSON.stringify({ project, query })],
    {
      encoding: 'utf8',
      timeout: 3000,
    },
  );
  return res.status === 0 ? parseRows(res.stdout ?? '', names) : null;
}

// 解析 `codebase-memory-mcp cli` 給人看的文字輸出。多列共用路徑前綴時，前面會多一段
// `rows_refs`，各列的路徑寫成 `@<id>+<後綴>`。格式對不上就回 null，讓呼叫方放行。
function parseRows(stdout, names) {
  const lines = stdout.split('\n');
  const prefixes = {};
  let i = 0;
  if (/^rows_refs: \d+/.test(lines[0])) {
    for (i = 1; i < lines.length && !/^rows: \d+/.test(lines[i]); i++) {
      const m = lines[i].match(/^\s+(\d+)\s+(\S+)$/);
      if (m) prefixes[m[1]] = m[2];
    }
  }
  if (!/^rows: \d+/.test(lines[i] ?? '')) return null;
  const hits = [];
  for (const line of lines.slice(i + 1)) {
    const m = line.match(/^\s+(\S+)\s+(\S+)\s+"(\d+)"$/);
    if (!m || !names.includes(m[1])) continue;
    const ref = m[2].match(/^@(\d+)\+(.*)$/);
    if (ref && prefixes[ref[1]] === undefined) return null;
    hits.push({ name: m[1], file: ref ? prefixes[ref[1]] + ref[2] : m[2], line: m[3] });
  }
  return hits;
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow();
}

if (input.hook_event_name === 'PostToolUse') {
  try {
    remember(input.session_id, input.tool_input ?? {});
  } catch {
    // 記不下來照樣放行：最多讓之後同名的 grep 多被擋一次。
  }
  allow();
}

if (!BIN) allow();

let text;
if (input.tool_name === 'Bash') {
  text = String(input.tool_input?.command ?? '');
  if (!SEARCH_VERB.test(text) || searchesOutsideRepo(text, repoRoot())) allow();
} else if (input.tool_name === 'Grep') {
  const path = String(input.tool_input?.path ?? '');
  if (outsideRepo(path, repoRoot())) allow();
  text = `${input.tool_input?.pattern ?? ''} ${path}`;
} else {
  allow();
}

const project = text.match(REFS)?.[1] ?? 'nexus-agent';
const names = symbolsIn(text);
if (names.length === 0) allow();

const hits = graphHits(project, names);
if (!hits || hits.length === 0) allow();

const seen = new Set(symbolsIn(lookedUp(input.session_id)));
const pending = [...new Set(hits.map((h) => h.name))].filter((n) => !seen.has(n));
if (pending.length === 0) allow();

const listed = pending
  .map((n) => {
    const own = hits.filter((h) => h.name === n);
    const first = own.find((h) => !/\.(test|spec)\./.test(h.file)) ?? own[0];
    const more = own.length > 1 ? `（另有 ${own.length - 1} 處）` : '';
    return `- ${n}  ${first.file}:${first.line}${more}`;
  })
  .join('\n');
const reason = [
  `圖譜 ${project} 已有這些符號，先走圖再 grep：`,
  listed,
  '用 search_graph 找定義、trace_path 查呼叫關係；圖是主 checkout 的版本，內容用 Read 讀自己 worktree 的檔。',
  `同一個 grep 再跑一次就會放行（例如否定宣稱要配 grep 核對，或手上沒有圖譜工具）。`,
].join('\n');

try {
  remember(input.session_id, { denied: pending });
} catch {
  // 記不下這次的 deny，同一個 grep 再跑也找不到放行的紀錄，等於永遠擋住；寧可這次放行。
  allow();
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }),
);
