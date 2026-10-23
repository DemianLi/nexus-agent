/**
 * `read_file` 描述的換法（[#1563](https://github.com/DemianLi/nexus-agent/issues/1563)）：看 middleware 在不在，換基座原文裡的**一句**。
 * 掛進整個 agent、模型實際收到什麼，在 `apps/harness/src/observation.test.ts`、`read-limits-openai.test.ts` 與 `assembly-parity.test.ts`。
 */

import { createFilesystemMiddleware } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { filesystemToolDescriptions } from './fs-tool-descriptions.js';
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
});
