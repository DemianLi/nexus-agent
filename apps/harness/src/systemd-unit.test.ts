/**
 * `docs/operations.md`〈用 systemd 常駐〉那份單元檔範本（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 5）的紅燈。
 *
 * 範本是文件裡的一段文字，沒人跑它就沒人知道它跟程式碼脫鉤了。這裡把它讀出來，釘住四件會靜靜壞掉的事：
 * `TimeoutStopSec` 要比 serve 自己的收尾上限大、`ExecStart` 直接 exec node 且旗標是 serve 真的收的、
 * home 與工作區不重疊（#1620 會讓 serve 起不來）、key 不寫進單元檔。
 * 真的交給 systemd 跑的證據在 PR 內文，不在這裡。
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PROCESS_SHUTDOWN_TIMEOUT_MS } from './process-shutdown.js';
import { parseServeArgs } from './serve.js';

const operationsDoc = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/operations.md');

type Unit = Record<string, Record<string, string[]>>;

/** 取出文件裡兩個標記之間的 ini 區塊。標記不在就丟錯，不回空字串。 */
function extractUnitText(markdown: string): string {
  const match =
    /<!-- systemd-unit:begin[^>]*-->\s*```ini\n([\s\S]*?)\n```\s*<!-- systemd-unit:end -->/u.exec(
      markdown,
    );
  if (match?.[1] === undefined)
    throw new Error('operations.md 找不到 systemd-unit 標記包住的 ini 區塊');
  return match[1];
}

/** 最小的 ini 解析：`[段]`、`鍵=值`（同鍵可重複）、`#` 開頭是註解。 */
function parseUnit(text: string): Unit {
  const unit: Unit = {};
  let section: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/u.exec(line);
    if (header?.[1] !== undefined) {
      section = header[1];
      unit[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (section === undefined || eq < 1) throw new Error(`認不得的單元檔行：${line}`);
    const key = line.slice(0, eq);
    ((unit[section] ??= {})[key] ??= []).push(line.slice(eq + 1));
  }
  return unit;
}

function one(unit: Unit, section: string, key: string): string {
  const values = unit[section]?.[key];
  if (values?.length !== 1 || values[0] === undefined) {
    throw new Error(`[${section}] ${key} 要剛好出現一次，實際 ${String(values?.length ?? 0)} 次`);
  }
  return values[0];
}

const unitText = extractUnitText(readFileSync(operationsDoc, 'utf8'));
const unit = parseUnit(unitText);
const execStart = one(unit, 'Service', 'ExecStart').split(/\s+/u);

describe('operations.md 的 systemd 單元檔範本', () => {
  it('KillSignal 是 SIGTERM，TimeoutStopSec 比 serve 的收尾上限大', () => {
    expect(one(unit, 'Service', 'KillSignal')).toBe('SIGTERM');
    const seconds = Number(one(unit, 'Service', 'TimeoutStopSec'));
    // serve 的 SIGTERM 收尾上限到了會自己結束（退出碼 0）；systemd 的 SIGKILL 必須排在它之後，
    // 否則 systemctl stop 會把一次乾淨的收尾變成被殺（status=9/KILL）。
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds * 1000).toBeGreaterThan(PROCESS_SHUTDOWN_TIMEOUT_MS);
  });

  it('ExecStart 直接 exec node 的絕對路徑跑 lib/serve.js，不經 pnpm、npx 或 shell', () => {
    const [node, entry] = execStart;
    expect(node !== undefined && isAbsolute(node)).toBe(true);
    expect(node).toMatch(/\/node$/u);
    expect(entry !== undefined && isAbsolute(entry)).toBe(true);
    expect(entry).toMatch(/\/lib\/serve\.js$/u);
    expect(execStart.join(' ')).not.toMatch(/\b(pnpm|npx|npm|tsx)\b|\/bin\/(ba|z)?sh/u);
  });

  it('ExecStart 的旗標 serve 真的收，且是常駐該有的樣子', () => {
    const invocation = parseServeArgs(execStart.slice(2));
    expect(invocation.live).toBe(true);
    expect(invocation.port).toBe(8787);
    expect(invocation.workspace).toBeDefined();
  });

  it('home 是 StateDirectory、WorkingDirectory 與 NEXUS_AGENT_HOME 同一處，且不在工作區裡', () => {
    const home = `/var/lib/${one(unit, 'Service', 'StateDirectory')}`;
    expect(one(unit, 'Service', 'Environment')).toBe(`NEXUS_AGENT_HOME=${home}`);
    expect(one(unit, 'Service', 'WorkingDirectory')).toBe(home);
    const workspace = parseServeArgs(execStart.slice(2)).workspace ?? '';
    // #1620：工作區與 home 任一方向重疊，serve 當場起不來。
    const down = relative(workspace, home);
    const up = relative(home, workspace);
    const overlaps = (rel: string): boolean =>
      rel === '' || !(rel.startsWith('..') || isAbsolute(rel));
    expect(overlaps(down) || overlaps(up)).toBe(false);
  });

  it('只在失敗時重啟，並限制重啟次數', () => {
    expect(one(unit, 'Service', 'Restart')).toBe('on-failure');
    expect(one(unit, 'Unit', 'StartLimitBurst')).toBe('5');
    expect(one(unit, 'Unit', 'StartLimitIntervalSec')).toBe('60');
  });

  it('不把 key 寫進單元檔', () => {
    expect(unitText).not.toMatch(/API_KEY|nvapi-/u);
    expect(unit.Service?.EnvironmentFile).toBeUndefined();
  });
});

describe('extractUnitText／parseUnit', () => {
  it('標記不在就丟錯，不回空字串', () => {
    expect(() => extractUnitText('# 沒有範本')).toThrow(/找不到/u);
  });

  it('同鍵重複與認不得的行都不吞掉', () => {
    expect(parseUnit('[A]\nk=1\nk=2').A?.k).toEqual(['1', '2']);
    expect(() => parseUnit('k=1')).toThrow(/認不得/u);
    expect(() => one(parseUnit('[A]\nk=1\nk=2'), 'A', 'k')).toThrow(/剛好出現一次/u);
  });
});
