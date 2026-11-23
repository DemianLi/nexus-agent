/**
 * 檔案工具開關換算成基座 `tools` 白名單（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605) N0355）。
 * 掛進整個 agent、模型實際看得到哪幾顆，在 `apps/harness/src/tool-fs.test.ts`。
 */

import { createFilesystemMiddleware } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { FILESYSTEM_TOOL_NAMES, filesystemToolWhitelist } from './fs-tools-options.js';

const on = { write: true, edit: true };

describe('FILESYSTEM_TOOL_NAMES 對著基座', () => {
  it('跟基座實際建出來的工具名一致：升版後基座多了或少了一顆，這裡先紅', () => {
    const { tools } = createFilesystemMiddleware({
      backend: {} as never,
      // 全部列出：不列的話 `execute` 在建工具時就過濾掉了。
      tools: [...FILESYSTEM_TOOL_NAMES],
    });
    const built = (tools ?? []).map((each) => each.name).sort();
    // `execute` 在 backend 不支援執行時基座會在執行期濾掉，建工具時可能在也可能不在：以不含它的比。
    expect(built.filter((name) => name !== 'execute')).toEqual(
      [...FILESYSTEM_TOOL_NAMES].filter((name) => name !== 'execute').sort(),
    );
  });
});

describe('filesystemToolWhitelist', () => {
  it('缺席或全開：不傳 tools（回 undefined）', () => {
    expect(filesystemToolWhitelist(undefined)).toBeUndefined();
    expect(filesystemToolWhitelist(on)).toBeUndefined();
  });

  it('write:false 拿掉 write_file 與 delete，其餘（含 edit_file、read_file）都在', () => {
    const names = filesystemToolWhitelist({ write: false, edit: true });
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('delete');
    expect(names).toContain('edit_file');
    expect(names).toContain('read_file');
    expect(names).toEqual(
      FILESYSTEM_TOOL_NAMES.filter((name) => name !== 'write_file' && name !== 'delete'),
    );
  });

  it('edit:false 只拿掉 edit_file', () => {
    expect(filesystemToolWhitelist({ write: true, edit: false })).toEqual(
      FILESYSTEM_TOOL_NAMES.filter((name) => name !== 'edit_file'),
    );
  });

  it('兩個都關：只剩讀取面與 execute；read_file 永遠在（基座要求）', () => {
    const names = filesystemToolWhitelist({ write: false, edit: false });
    expect(names).toEqual(['ls', 'read_file', 'glob', 'grep', 'execute']);
    // 基座真的收得下這份名單（沒有 read_file 會拋）。
    expect(() => createFilesystemMiddleware({ backend: {} as never, tools: names })).not.toThrow();
  });
});
