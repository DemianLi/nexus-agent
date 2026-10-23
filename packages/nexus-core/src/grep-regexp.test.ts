/**
 * `grep` 兩格參數說明的換法（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605)）：模型看到的 `pattern`、`glob` 講正規式與單一篩選，
 * 其餘一格不動；執行時的工具仍是基座那個實例。掛進整個 agent、模型實際收到什麼，在 `apps/harness/src/assembly-parity.test.ts`。
 */

import { createFilesystemMiddleware } from 'deepagents';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { describe, expect, it } from 'vitest';

import {
  createGrepRegexpMiddleware,
  GREP_GLOB_DESCRIPTION,
  GREP_PATTERN_DESCRIPTION,
  GREP_REGEXP_MIDDLEWARE_NAME,
} from './grep-regexp.js';

type Wrap = (
  request: { tools: unknown[] },
  handler: (request: { tools: unknown[] }) => unknown,
) => unknown;

function baseTools() {
  const { tools } = createFilesystemMiddleware({ backend: {} as never });
  return tools ?? [];
}

/** 把 `tools` 交給 middleware，回它交給下一層的清單。 */
function through(tools: unknown[]): unknown[] {
  const middleware = createGrepRegexpMiddleware() as unknown as { wrapModelCall: Wrap };
  let seen: unknown[] = [];
  middleware.wrapModelCall({ tools }, (next) => {
    seen = next.tools;
    return undefined;
  });
  return seen;
}

describe('createGrepRegexpMiddleware', () => {
  it('名字固定（fs-tool-descriptions 看它在不在）', () => {
    expect(createGrepRegexpMiddleware().name).toBe(GREP_REGEXP_MIDDLEWARE_NAME);
  });

  it('grep 的 pattern、glob 兩格說明換掉，其餘（描述、別的參數、必填）與基座的轉換結果相同', () => {
    const grep = baseTools().find((tool) => tool.name === 'grep');
    if (grep === undefined) throw new Error('基座沒有 grep');
    const [swapped] = through([grep]) as Array<{
      function: {
        name: string;
        description: string;
        parameters: { properties: Record<string, { description?: string }>; required?: string[] };
      };
    }>;
    const original = convertToOpenAITool(grep as never) as NonNullable<typeof swapped>;

    expect(swapped?.function.parameters.properties['pattern']?.description).toBe(
      GREP_PATTERN_DESCRIPTION,
    );
    expect(swapped?.function.parameters.properties['glob']?.description).toBe(
      GREP_GLOB_DESCRIPTION,
    );
    // 其餘一格不動。
    for (const name of ['path', 'max_count', 'output_mode']) {
      expect(swapped?.function.parameters.properties[name]).toEqual(
        original.function.parameters.properties[name],
      );
    }
    expect(swapped?.function.parameters.required).toEqual(original.function.parameters.required);
    expect(swapped?.function.description).toBe(original.function.description);
    expect(swapped?.function.name).toBe('grep');
    // 不可列舉的 name：基座的工具排除 middleware 用它認工具（跟 read_file 的換法同一個理由）。
    expect((swapped as unknown as { name: string }).name).toBe('grep');
    expect(Object.keys(swapped as object)).not.toContain('name');
  });

  it('基座原本的說法確實是「字面」：絆線——升版後改了說法，這裡先紅', () => {
    const grep = baseTools().find((tool) => tool.name === 'grep');
    const properties = (
      convertToOpenAITool(grep as never) as {
        function: { parameters: { properties: Record<string, { description?: string }> } };
      }
    ).function.parameters.properties;
    expect(properties['pattern']?.description).toMatch(/literal/i);
    expect(properties['glob']).toBeDefined();
  });

  it('不是 grep 的工具原樣；沒有 grep 的請求不複製清單', () => {
    const read = baseTools().find((tool) => tool.name === 'read_file');
    const tools = [read];
    const middleware = createGrepRegexpMiddleware() as unknown as { wrapModelCall: Wrap };
    const request = { tools };
    let received: { tools: unknown[] } | undefined;
    middleware.wrapModelCall(request, (next) => {
      received = next;
      return undefined;
    });
    expect(received).toBe(request);
  });

  it('同一份工具進來兩次（兩層看到同一請求）拿到同一份定義', () => {
    const grep = baseTools().find((tool) => tool.name === 'grep');
    const [first] = through([grep]);
    const [second] = through([grep]);
    expect(second).toBe(first);
    expect(through([first])[0]).toBe(first);
  });
});
