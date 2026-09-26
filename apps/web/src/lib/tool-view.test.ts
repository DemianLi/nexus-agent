// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { classifyTool, isKnownTool, toolInputBody, toolSummary, toolTitle } from '@/lib/tool-view';

/**
 * `classifyTool` 涵蓋 nexus 每一個實際工具名（#406 驗收）。plugin 的工具名**從原始碼讀**（各 plugin 匯出的
 * `*_TOOL_NAME` 常數，外加 `apps/harness/src` 自己掛的，例如沙箱升級）：新增一個工具而沒在 `lib/tool-view.ts` 分類，這裡紅。基座的工具名是 deepagents 定的，
 * 手列（1.13.1；升版時對一次 `deepagents/dist` 的工具定義）。
 */

const PACKAGES = new URL('../../../../packages/', import.meta.url);
const HARNESS = new URL('../../../harness/src/', import.meta.url);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    // 測試與 fixture 裡的是假工具（`fixtures.ts` 的 `take_note`、`*.fixture.ts`），不是產品會掛的。
    return /\.ts$/.test(name) && !/\.(test|fixture)\.ts$|^fixtures\.ts$/.test(name) ? [path] : [];
  });
}

const pluginToolNames = [
  ...readdirSync(PACKAGES)
    .filter((name) => name.startsWith('nexus-plugin-'))
    .flatMap((name) => sources(join(PACKAGES.pathname, name, 'src'))),
  ...sources(HARNESS.pathname),
].flatMap((file) =>
  [...readFileSync(file, 'utf8').matchAll(/export const \w*TOOL_NAME\w* = '([a-z_]+)'/g)].map(
    (match) => match[1] ?? '',
  ),
);

const BASE_TOOL_NAMES = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute',
  'task',
];

describe('classifyTool', () => {
  it('從 plugin 原始碼讀得到工具名（量具本身沒壞）', () => {
    expect(pluginToolNames).toEqual(
      expect.arrayContaining([
        'echo',
        'ask_user_question',
        'run_javascript',
        'request_sandbox_escalation',
      ]),
    );
  });

  it.each([...BASE_TOOL_NAMES, ...new Set(pluginToolNames)])('%s 在表上有明寫', (name) => {
    expect(isKnownTool(name)).toBe(true);
    expect(toolTitle(name)).not.toBe('工具');
  });

  it.each([
    ['ls', 'read'],
    ['read_file', 'read'],
    ['glob', 'search'],
    ['grep', 'search'],
    ['write_file', 'write'],
    ['edit_file', 'edit'],
    ['execute', 'bash'],
    ['run_javascript', 'code'],
    ['task', 'others'],
    ['todo_write', 'others'],
  ] as const)('%s → %s', (name, variant) => {
    expect(classifyTool(name)).toBe(variant);
  });

  it('不認得的工具（例如 MCP 的）走通用卡', () => {
    expect(classifyTool('mcp__github__create_issue')).toBe('others');
    expect(isKnownTool('mcp__github__create_issue')).toBe(false);
    expect(toolTitle('mcp__github__create_issue')).toBe('工具');
  });
});

describe('摘要與展開內容', () => {
  it('摘要照類別挑欄位，只取第一行', () => {
    expect(toolSummary('read_file', '{"file_path":"src/App.tsx","limit":20}')).toBe('src/App.tsx');
    expect(toolSummary('execute', '{"command":"pnpm test\\npnpm build"}')).toBe('pnpm test');
    expect(toolSummary('grep', '{"pattern":"TODO","path":"src"}')).toBe('TODO');
    expect(toolSummary('mcp__x__y', '{"n":1,"q":"找這個"}')).toBe('找這個');
  });

  it('壞 JSON 退回原字串', () => {
    expect(toolSummary('read_file', '{"file_path":"src/Ap')).toBe('{"file_path":"src/Ap');
    expect(toolInputBody('read_file', '{"file_path":"src/Ap')).toEqual({
      text: '{"file_path":"src/Ap',
      lang: 'text',
    });
  });

  it('執行程式展開是那段程式、執行指令是那行指令，其他是排好的 JSON', () => {
    expect(toolInputBody('run_javascript', '{"code":"1 + 1"}')).toEqual({
      text: '1 + 1',
      lang: 'js',
    });
    expect(toolInputBody('execute', '{"command":"ls -la"}')).toEqual({
      text: 'ls -la',
      lang: 'bash',
    });
    expect(toolInputBody('echo', '{"message":"嗨"}')).toEqual({
      text: '{\n  "message": "嗨"\n}',
      lang: 'json',
    });
    expect(toolInputBody('echo', '')).toBeUndefined();
  });
});

/**
 * **`execute` 的絆索**（#601）：基座只在 backend 帶 shell 時才註冊 `execute`（deepagents 1.13.1 的 `isSandboxBackend`：
 * 有 `execute` 方法而且 `id` 非空）。今天 harness 只建這三種 backend，沒有一種帶 shell——`CompositeBackend` 的 `id`
 * 只在預設 backend 是 sandbox 時才轉出來，`ContainedFilesystemBackend` 繼承的是沒有 shell 的 `FilesystemBackend`，
 * `TextOnlyStateBackend` 繼承的是同樣沒有 shell 的 `StateBackend`。
 * 這裡紅了表示有新的 backend 進來：確認它會不會讓 `execute` 上線，會的話先補終端卡（dsh `terminal-card-model.ts`）。
 */
describe('execute 還沒上線', () => {
  const harnessSources = sources(HARNESS.pathname);

  it('harness 只建沒有 shell 的 backend', () => {
    const constructed = new Set(
      harnessSources.flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/new (\w*Backend)\(/g)].map((match) => match[1]),
      ),
    );
    expect([...constructed].sort()).toEqual([
      'CompositeBackend',
      'ContainedFilesystemBackend',
      'TextOnlyStateBackend',
    ]);
  });

  it('ContainedFilesystemBackend 沒有自己長出 execute', () => {
    const file = harnessSources.find((path) => path.endsWith('contained-backend.ts'));
    expect(file).toBeDefined();
    const source = readFileSync(file ?? '', 'utf8');
    expect(source).toContain('class ContainedFilesystemBackend extends FilesystemBackend');
    expect(source).not.toMatch(/\bexecute\s*\(/);
  });

  it('TextOnlyStateBackend 沒有自己長出 execute', () => {
    const file = harnessSources.find((path) => path.endsWith('binary-read.ts'));
    expect(file).toBeDefined();
    const source = readFileSync(file ?? '', 'utf8');
    expect(source).toContain('class TextOnlyStateBackend extends StateBackend');
    expect(source).not.toMatch(/\bexecute\s*\(/);
  });
});
