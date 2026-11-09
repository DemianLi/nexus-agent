/**
 * `read_file` 描述的換法（[#1563](https://github.com/DemianLi/nexus-agent/issues/1563)）：看讀到哪與搜尋說明掛不掛，換基座原文裡指定的片段。
 * 掛進整個 agent、模型實際收到什麼，在 `apps/harness/src/observation.test.ts`、`read-limits-openai.test.ts` 與 `assembly-parity.test.ts`。
 */

import { createFilesystemMiddleware } from 'deepagents';
import { describe, expect, it, vi } from 'vitest';

import { filesystemToolDescriptions } from './fs-tool-descriptions.js';

/** 基座自己建出來的三顆工具的描述（沒有 `customToolDescriptions`）。 */
function baseDescription(name: string): string {
  const { tools } = createFilesystemMiddleware({ backend: {} as never });
  const found = (tools ?? []).find((each) => each.name === name);
  if (found === undefined) throw new Error(`基座沒有 ${name}`);
  return String(found.description);
}

/** 把行號那一句換回基座的原文，剩下的差異才看得出來。 */
function withBaseLinePrefix(read: string): string {
  return read.replace(
    'then a tab, then the source line. The number and the tab are not file content: ' +
      'never include them in `write_file` content or in `edit_file` old_string or new_string.',
    'then two spaces, then the source line. Never include these line-number prefixes when editing.',
  );
}

describe('filesystemToolDescriptions', () => {
  it('讀到哪與搜尋說明都沒掛 → 不換（組成與基座逐位元組相同）', () => {
    expect(
      filesystemToolDescriptions({ readContinuation: false, searchDescriptions: false }),
    ).toBeUndefined();
  });

  it('讀檔續讀在場 → 只換 read_file 的預設行數（2000）與行號那一句，其餘一字不動', () => {
    const descriptions = filesystemToolDescriptions({
      readContinuation: true,
      searchDescriptions: false,
    });
    expect(Object.keys(descriptions ?? {})).toEqual(['read_file']);
    const read = descriptions?.read_file ?? '';
    expect(read).toContain('By default, it reads up to 2000 lines');
    expect(read).not.toContain('up to 100 lines');
    expect(withBaseLinePrefix(read).replace('up to 2000 lines', 'up to 100 lines')).toBe(
      baseDescription('read_file'),
    );
  });

  it('講行號的那一句照實際輸出寫 tab，禁止範圍涵蓋 write_file 與 edit_file（#2286）', () => {
    const read =
      filesystemToolDescriptions({ readContinuation: true, searchDescriptions: false })
        ?.read_file ?? '';
    expect(read).toContain('then a tab, then the source line');
    expect(read).toContain('`write_file` content');
    expect(read).toContain('`edit_file` old_string or new_string');
    expect(read).not.toContain('two spaces');
    expect(read).not.toContain('when editing');
  });

  it('基座講行號的那一句改了就拋，不會悄悄兩套說法並存（#2286）', async () => {
    vi.resetModules();
    vi.doMock('deepagents', async (original) => ({
      ...(await original<typeof import('deepagents')>()),
      createFilesystemMiddleware: () => ({
        tools: [{ name: 'read_file', description: 'By default, it reads up to 100 lines' }],
      }),
    }));
    try {
      const fresh = await import('./fs-tool-descriptions.js');
      expect(() =>
        fresh.filesystemToolDescriptions({ readContinuation: true, searchDescriptions: false }),
      ).toThrow('找不到「then two spaces');
    } finally {
      vi.doUnmock('deepagents');
      vi.resetModules();
    }
  });

  it('真的交給 createFilesystemMiddleware，建出來的工具就是換過的描述（拿掉 customToolDescriptions 這條就紅）', () => {
    const customToolDescriptions = filesystemToolDescriptions({
      readContinuation: true,
      searchDescriptions: false,
    });
    const { tools } = createFilesystemMiddleware({
      backend: {} as never,
      ...(customToolDescriptions !== undefined && { customToolDescriptions }),
    });
    const byName = Object.fromEntries(
      (tools ?? []).map((each) => [each.name, String(each.description)]),
    );
    expect(byName['read_file']).toBe(customToolDescriptions?.read_file);
    // 沒換的工具仍是基座的。
    expect(byName['write_file']).toBe(baseDescription('write_file'));
    expect(byName['edit_file']).toBe(baseDescription('edit_file'));
    expect(byName['grep']).toBe(baseDescription('grep'));
  });

  it('行數上限來自 tool-fs 設定：read_file 描述寫那個數字，其餘一字不動', () => {
    const descriptions = filesystemToolDescriptions(
      { readContinuation: true, searchDescriptions: false },
      {
        readLimit: 500,
      },
    );
    const read = descriptions?.read_file ?? '';
    expect(read).toContain('By default, it reads up to 500 lines');
    expect(withBaseLinePrefix(read).replace('up to 500 lines', 'up to 100 lines')).toBe(
      baseDescription('read_file'),
    );
  });
});

describe('filesystemToolDescriptions：grep 講正規式（#1605）', () => {
  it('grep 的 middleware 不在 → 不換（描述不能比 backend 的行為先講）', () => {
    expect(
      filesystemToolDescriptions({ readContinuation: true, searchDescriptions: false }),
    ).not.toHaveProperty('grep');
  });

  it('在場 → 只換開頭講字面的那兩段：第一句是 dsh 的，後面基座講輸出與 /large_tool_results/ 的原樣留著', () => {
    const descriptions = filesystemToolDescriptions({
      readContinuation: false,
      searchDescriptions: true,
    });
    expect(Object.keys(descriptions ?? {}).sort()).toEqual(['glob', 'grep']);
    const grep = descriptions?.grep ?? '';
    expect(grep.startsWith('Search file contents with a ripgrep regular expression.')).toBe(true);
    expect(grep).toContain('/conversation_history/');
    expect(grep).not.toContain('foo|bar');
    expect(grep).not.toContain('LITERAL');
    expect(grep).not.toContain('NOT regex');
    const base = baseDescription('grep');
    const tail = base.slice(base.indexOf('\n\nReturns matching files'));
    expect(grep.endsWith(tail)).toBe(true);
    expect(tail).toContain('/large_tool_results/');
  });

  it('真的交給 createFilesystemMiddleware，建出來的 grep 就是換過的描述；其他工具仍是基座的', () => {
    const customToolDescriptions = filesystemToolDescriptions({
      readContinuation: false,
      searchDescriptions: true,
    });
    const { tools } = createFilesystemMiddleware({
      backend: {} as never,
      ...(customToolDescriptions !== undefined && { customToolDescriptions }),
    });
    const byName = Object.fromEntries(
      (tools ?? []).map((each) => [each.name, String(each.description)]),
    );
    expect(byName['grep']).toBe(customToolDescriptions?.grep);
    expect(byName['glob']).toBe(customToolDescriptions?.glob);
    expect(byName['read_file']).toBe(baseDescription('read_file'));
  });
});

describe('filesystemToolDescriptions：glob 講 rg 的語意（#1605）', () => {
  it('不在 → 不換', () => {
    expect(
      filesystemToolDescriptions({ readContinuation: true, searchDescriptions: false }),
    ).not.toHaveProperty('glob');
  });

  it('在場 → 只換第一句（dsh 原句：不含目錄、含隱藏與被 ignore 的檔、照修改時間），基座講 `*`／`**`／`?` 的一段原樣留著', () => {
    const glob =
      filesystemToolDescriptions({ readContinuation: false, searchDescriptions: true })?.glob ?? '';
    expect(
      glob.startsWith(
        'Find files, not directories, whose paths match a glob pattern, including hidden and ignored files.',
      ),
    ).toBe(true);
    expect(glob).toContain('modification-time order');
    const base = baseDescription('glob');
    const tail = base.slice(base.indexOf('\n\n'));
    expect(glob.endsWith(tail)).toBe(true);
    expect(tail).toContain('Supports `*`');
  });
});
