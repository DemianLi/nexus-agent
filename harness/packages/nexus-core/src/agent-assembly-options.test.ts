/**
 * 交給 `createFilesystemMiddleware` 的選項（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605) 驗收 14）：
 * 全開時**沒有 `tools` 這個鍵**，即使把全集傳進去也不行。
 *
 * 傳全集建出的工具與不傳相同，`assembly-parity` 與模型看到的工具清單都看不出差別，只有選項物件看得到。
 * 這個函式是 root、一次性子代理、背景子代理三條路唯一的出口；下面另外有一條絆索，確認組裝點的每一處 `createFilesystemMiddleware(` 呼叫
 * 都經過它（有人在某一處直接寫選項物件，這條當場紅）。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { filesystemMiddlewareOptions } from './agent-assembly.js';
import { filesystemToolDescriptions } from './fs-tool-descriptions.js';

const backend = {} as never;
const limits = {
  readLimit: 2000,
  readMaxLineLength: 2000,
  readMaxBytes: 51_200,
  readStreamMinSize: 10 * 1024 * 1024,
};

describe('filesystemMiddlewareOptions', () => {
  it.each([
    ['沒有 tool-fs 組態', undefined],
    ['write／edit 都開', { write: true, edit: true, ...limits }],
  ])('%s：選項物件沒有 tools 這個鍵', (_name, fileTools) => {
    const options = filesystemMiddlewareOptions({
      backend,
      descriptions: filesystemToolDescriptions({
        readContinuation: true,
        searchDescriptions: false,
      }),
      ...(fileTools !== undefined && { fileTools }),
    });

    expect(Object.keys(options)).not.toContain('tools');
    expect(options.backend).toBe(backend);
  });

  it('write 關：tools 白名單沒有 write_file／delete，有 edit_file 與讀取面', () => {
    const options = filesystemMiddlewareOptions({
      backend,
      fileTools: { write: false, edit: true, ...limits },
    });

    expect(options.tools).not.toContain('write_file');
    expect(options.tools).not.toContain('delete');
    expect(options.tools).toEqual(
      expect.arrayContaining(['ls', 'read_file', 'edit_file', 'glob', 'grep']),
    );
  });

  it('edit 關：tools 白名單沒有 edit_file', () => {
    const options = filesystemMiddlewareOptions({
      backend,
      fileTools: { write: true, edit: false, ...limits },
    });

    expect(options.tools).not.toContain('edit_file');
    expect(options.tools).toEqual(expect.arrayContaining(['write_file', 'delete']));
  });

  it('permissions、描述有給才帶', () => {
    const plain = filesystemMiddlewareOptions({ backend });
    expect(Object.keys(plain)).toEqual(['backend']);

    const full = filesystemMiddlewareOptions({
      backend,
      permissions: [],
      descriptions: filesystemToolDescriptions({
        readContinuation: true,
        searchDescriptions: false,
      }),
    });
    expect(Object.keys(full).sort()).toEqual(['backend', 'customToolDescriptions', 'permissions']);
  });
});

describe('組裝點的 createFilesystemMiddleware 呼叫', () => {
  it('只在 filesystemMiddleware 裡建；root 一處、子代理預設疊一處都經過 filesystemMiddlewareOptions', () => {
    const source = readFileSync(new URL('./agent-assembly.ts', import.meta.url), 'utf8');
    const direct = [...source.matchAll(/(?<![\w.])createFilesystemMiddleware\(\s*(\S+)/gu)].map(
      (match) => match[1],
    );
    const wrapped = [
      ...source.matchAll(/(?<![\w.]|function )filesystemMiddleware\(\s*(\S+)/gu),
    ].map((match) => match[1]);

    // 基座那一顆的 `wrapToolCall` 換成 core 的、`wrapModelCall` 由 core 包住（#2415 W3），所以直接建的只有包裝裡那一處。
    expect(direct).toEqual(['options);']);
    expect(wrapped).toHaveLength(2);
    for (const argument of wrapped) expect(argument).toMatch(/^filesystemMiddlewareOptions\(/u);
  });
});
