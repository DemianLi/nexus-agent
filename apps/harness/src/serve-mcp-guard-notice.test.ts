/**
 * 這台主機包不了 `--guard` 時，serve 起動講一次（[#2197](https://github.com/DemianLi/nexus-agent/issues/2197)）。
 * 哪些主機包不了在 `mcp-sandbox.test.ts`；這一檔量 `serve.ts` 的接線。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bodyLog } from './fixtures.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

vi.mock('./mcp-sandbox.js', async (importActual) => ({
  ...(await importActual<typeof import('./mcp-sandbox.js')>()),
  mcpGuardNotice: () => '[MCP] 測試用的一句',
}));

let serve: ScriptedServe | undefined;

afterEach(async () => {
  await serve?.close();
  serve = undefined;
});

describe('serve 起動', () => {
  it('包不了 --guard 講一次', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe([{ content: '好。' }] as never, { log: bodyLog(lines) });
    expect(lines.filter((line) => line.includes('[MCP] 測試用的一句'))).toHaveLength(1);
  });
});
