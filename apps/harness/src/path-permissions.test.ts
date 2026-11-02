/**
 * `path-permissions.ts` 照抄的比對，拿基座**真的工具層**當對照（[#2260](https://github.com/DemianLi/nexus-agent/issues/2260)）：
 * 同一份規則、同一條路徑，`createFilesystemMiddleware({ permissions })` 的 `read_file`／`write_file`／`delete` 回的拒絕句，
 * 要跟這裡算出來的逐字相同（基座多一個 `Error: ` 開頭）；基座放行的，這裡也放行。
 *
 * backend 是假的：沒被規則擋下的呼叫走到它，回一句跟拒絕分得開的錯。`delete` 照基座的判法問 `ls`，
 * 回「不是目錄」就是確定的一般檔，回有東西就是可能有子樹。
 */

import { createFilesystemMiddleware } from 'deepagents';
import type { FilesystemPermission } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { deleteDenial, permissionDenial } from './path-permissions.js';

/** 規則表；`except` 照 fold 寫成排在自己那條 deny 前面的 allow。「只擋寫」是 fold 折不出來、給比對多一種判定的。 */
const RULE_SETS: Record<string, FilesystemPermission[]> = {
  子樹: [{ operations: ['read', 'write'], paths: ['/secret/**'], mode: 'deny' }],
  例外: [
    { operations: ['read', 'write'], paths: ['/secrets/public/**'], mode: 'allow' },
    { operations: ['read', 'write'], paths: ['/secrets/**'], mode: 'deny' },
  ],
  點檔: [{ operations: ['read', 'write'], paths: ['/.env*'], mode: 'deny' }],
  大括號與深層: [{ operations: ['read', 'write'], paths: ['/**/*.key', '/{a,b}/x'], mode: 'deny' }],
  單層萬用: [{ operations: ['read', 'write'], paths: ['/work/*'], mode: 'deny' }],
  排在前面的例外: [
    { operations: ['read', 'write'], paths: ['/tmp/ok'], mode: 'allow' },
    { operations: ['read', 'write'], paths: ['/tmp/**'], mode: 'deny' },
  ],
  只擋寫: [{ operations: ['write'], paths: ['/locked/**'], mode: 'deny' }],
};

const PATHS = [
  '/',
  '/notes.md',
  '/secret',
  '/secret/a.txt',
  '/secret/deep/b.txt',
  '/secret/.hidden',
  '/.ssh/z.key',
  '/secrets',
  '/secrets/x',
  '/secrets/public/y',
  '/.env',
  '/.env.local',
  '/a/.env',
  '/k/z.key',
  '/a/x',
  '/b/x',
  '/c/x',
  '/work',
  '/work/app',
  '/work/app/child',
  '/work/notes.txt',
  '/tmp/ok',
  '/tmp/no',
  '/locked/a',
  '//secret//a.txt',
];

const NOT_DENIED = 'backend reached';

type Tool = { name: string; invoke: (args: unknown, config: unknown) => Promise<unknown> };

/** 基座的工具層，backend 是假的；`leaf` 決定 `ls` 把目標說成一般檔還是目錄。 */
function baseTools(rules: FilesystemPermission[], leaf: boolean): Map<string, Tool> {
  const refuse = async (): Promise<{ error: string }> => ({ error: NOT_DENIED });
  const backend = {
    ls: async () =>
      leaf ? { error: 'not a directory' } : { files: [{ path: '/x/child', is_dir: false }] },
    read: refuse,
    readRaw: refuse,
    write: refuse,
    edit: refuse,
    delete: refuse,
    grep: async () => ({ matches: [] }),
    glob: async () => ({ files: [] }),
  };
  const middleware = createFilesystemMiddleware({
    backend: backend as never,
    permissions: rules,
  }) as unknown as { tools: Tool[] };
  return new Map(middleware.tools.map((tool) => [tool.name, tool]));
}

/** 基座這一次的拒絕句（去掉 `Error: `）；沒被規則擋下回 `undefined`。 */
async function baseDenial(
  tools: Map<string, Tool>,
  name: string,
  args: object,
): Promise<string | undefined> {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`基座沒有 ${name}`);
  const result = (await tool.invoke(args, { toolCall: { id: 'c', name, args } })) as {
    content?: unknown;
  };
  const text = JSON.stringify(result.content ?? result);
  if (text.includes(NOT_DENIED)) return undefined;
  const content = typeof result.content === 'string' ? result.content : text;
  if (!content.startsWith('Error: permission denied')) throw new Error(`認不得的結果：${content}`);
  return content.slice('Error: '.length);
}

describe.each(Object.entries(RULE_SETS))('規則「%s」：跟基座的判定逐字相同', (_label, rules) => {
  it.each(PATHS)('讀、寫：%s', async (path) => {
    const tools = baseTools(rules, true);
    expect(permissionDenial(rules, 'read', path)).toBe(
      await baseDenial(tools, 'read_file', { file_path: path }),
    );
    expect(permissionDenial(rules, 'write', path)).toBe(
      await baseDenial(tools, 'write_file', { file_path: path, content: 'x' }),
    );
  });

  it.each(PATHS)('刪除（確定是一般檔、可能是目錄）：%s', async (path) => {
    expect(deleteDenial(rules, path, false)).toBe(
      await baseDenial(baseTools(rules, true), 'delete', { file_path: path }),
    );
    expect(deleteDenial(rules, path, true)).toBe(
      await baseDenial(baseTools(rules, false), 'delete', { file_path: path }),
    );
  });
});

describe('對照表本身有在擋', () => {
  it('每一種判定都出現過：讀被擋、讀放行、例外放行、只擋寫', () => {
    expect(permissionDenial(RULE_SETS['子樹'] ?? [], 'read', '/secret/a.txt')).toBeDefined();
    expect(permissionDenial(RULE_SETS['子樹'] ?? [], 'read', '/notes.md')).toBeUndefined();
    expect(permissionDenial(RULE_SETS['例外'] ?? [], 'read', '/secrets/public/y')).toBeUndefined();
    expect(permissionDenial(RULE_SETS['只擋寫'] ?? [], 'read', '/locked/a')).toBeUndefined();
    expect(permissionDenial(RULE_SETS['只擋寫'] ?? [], 'write', '/locked/a')).toBeDefined();
  });

  it('沒有規則就不判', () => {
    expect(permissionDenial([], 'read', '/secret/a.txt')).toBeUndefined();
    expect(deleteDenial([], '/secret', true)).toBeUndefined();
  });
});
