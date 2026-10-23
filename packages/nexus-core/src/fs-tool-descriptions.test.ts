/**
 * `read_file` 描述的換法（[#1563](https://github.com/DemianLi/nexus-agent/issues/1563)）：看 middleware 在不在，換基座原文裡的**一句**。
 * 掛進整個 agent、模型實際收到什麼，在 `apps/harness/src/observation.test.ts`、`read-limits-openai.test.ts` 與 `assembly-parity.test.ts`。
 */

import { createFilesystemMiddleware } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { filesystemToolDescriptions } from './fs-tool-descriptions.js';
import { SEARCH_DESCRIPTIONS_MIDDLEWARE_NAME } from './search-descriptions.js';
import { OBSERVATION_POLICY_MIDDLEWARE_NAME } from './observation.js';
import { READ_CONTINUATION_MIDDLEWARE_NAME } from './read-continuation.js';

/** 基座自己建出來的三顆工具的描述（沒有 `customToolDescriptions`）。 */
function baseDescription(name: string): string {
  const { tools } = createFilesystemMiddleware({ backend: {} as never });
  const found = (tools ?? []).find((each) => each.name === name);
  if (found === undefined) throw new Error(`基座沒有 ${name}`);
  return String(found.description);
}

describe('filesystemToolDescriptions', () => {
  it('讀檔續讀不在 → 不換（組成與基座逐位元組相同）', () => {
    expect(filesystemToolDescriptions([])).toBeUndefined();
    expect(filesystemToolDescriptions([{ name: 'whatever' }])).toBeUndefined();
  });

  it('先讀後改在場也不換 write_file／edit_file：規則住在系統提示詞（observation.ts），不在描述', () => {
    expect(
      filesystemToolDescriptions([{ name: OBSERVATION_POLICY_MIDDLEWARE_NAME }]),
    ).toBeUndefined();
  });

  it('讀檔續讀在場 → 只換 read_file 的預設行數（2000），其餘一字不動', () => {
    const descriptions = filesystemToolDescriptions([
      { name: READ_CONTINUATION_MIDDLEWARE_NAME },
      { name: OBSERVATION_POLICY_MIDDLEWARE_NAME },
    ]);
    expect(Object.keys(descriptions ?? {})).toEqual(['read_file']);
    const read = descriptions?.read_file ?? '';
    expect(read).toContain('By default, it reads up to 2000 lines');
    expect(read).not.toContain('up to 100 lines');
    expect(read.replace('up to 2000 lines', 'up to 100 lines')).toBe(baseDescription('read_file'));
  });

  it('真的交給 createFilesystemMiddleware，建出來的工具就是換過的描述（拿掉 customToolDescriptions 這條就紅）', () => {
    const customToolDescriptions = filesystemToolDescriptions([
      { name: READ_CONTINUATION_MIDDLEWARE_NAME },
    ]);
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
    const descriptions = filesystemToolDescriptions([{ name: READ_CONTINUATION_MIDDLEWARE_NAME }], {
      readLimit: 500,
    });
    const read = descriptions?.read_file ?? '';
    expect(read).toContain('By default, it reads up to 500 lines');
    expect(read.replace('up to 500 lines', 'up to 100 lines')).toBe(baseDescription('read_file'));
  });
});

describe('filesystemToolDescriptions：grep 講正規式（#1605）', () => {
  it('grep 的 middleware 不在 → 不換（描述不能比 backend 的行為先講）', () => {
    expect(
      filesystemToolDescriptions([{ name: READ_CONTINUATION_MIDDLEWARE_NAME }]),
    ).not.toHaveProperty('grep');
  });

  it('在場 → 只換開頭講字面的那兩段：第一句是 dsh 的，後面基座講輸出與 /large_tool_results/ 的原樣留著', () => {
    const descriptions = filesystemToolDescriptions([
      { name: SEARCH_DESCRIPTIONS_MIDDLEWARE_NAME },
    ]);
    expect(Object.keys(descriptions ?? {}).sort()).toEqual(['glob', 'grep']);
    const grep = descriptions?.grep ?? '';
    expect(grep.startsWith('Search file contents with a ripgrep regular expression.')).toBe(true);
    expect(grep).toContain('foo|bar');
    expect(grep).not.toContain('LITERAL');
    expect(grep).not.toContain('NOT regex');
    const base = baseDescription('grep');
    const tail = base.slice(base.indexOf('\n\nReturns matching files'));
    expect(grep.endsWith(tail)).toBe(true);
    expect(tail).toContain('/large_tool_results/');
  });

  it('真的交給 createFilesystemMiddleware，建出來的 grep 就是換過的描述；其他工具仍是基座的', () => {
    const customToolDescriptions = filesystemToolDescriptions([
      { name: SEARCH_DESCRIPTIONS_MIDDLEWARE_NAME },
    ]);
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
      filesystemToolDescriptions([{ name: READ_CONTINUATION_MIDDLEWARE_NAME }]),
    ).not.toHaveProperty('glob');
  });

  it('在場 → 只換第一句（dsh 原句：不含目錄、含隱藏與被 ignore 的檔、照修改時間），基座講 `*`／`**`／`?` 的一段原樣留著', () => {
    const glob =
      filesystemToolDescriptions([{ name: SEARCH_DESCRIPTIONS_MIDDLEWARE_NAME }])?.glob ?? '';
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
