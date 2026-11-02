/**
 * `serve` 起動時檢查 `memory` 來源（[#2271](https://github.com/DemianLi/nexus-agent/issues/2271)）。
 *
 * 從 `runServe` 起量：真的 serve、出貨的組裝、`--patch` 掛上的 `memory` 插件。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { scriptedPatchText } from './scripted-serve.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join('/var/tmp', prefix));
  temporary.push(dir);
  return dir;
}

const memoryRows = (sources: readonly string[]): string => `- insert:
    - id: memory
      name: '@nexus/plugin-memory'
      config:
        sources: ${JSON.stringify(sources)}
`;

/** 起一台帶 `--workspace` 的 serve，回起動輸出裡 `[記憶]` 那幾行。 */
async function startupLines(
  rows: string,
  prepare: (workspace: string) => Promise<unknown> = () => Promise.resolve(),
): Promise<{ lines: string[]; workspace: string }> {
  const home = await scratch('nexus-memory-check-home-');
  const workspace = await scratch('nexus-memory-check-ws-');
  await prepare(workspace);
  const patch = join(await scratch('nexus-memory-check-patch-'), 'script.patch.yml');
  await writeFile(patch, scriptedPatchText([{ content: '好。' }], rows), 'utf8');
  const output: string[] = [];
  running = (await runServe({
    argv: ['--port', '0', '--workspace', workspace, '--patch', patch],
    log: (line) => output.push(line),
    env: { [HARNESS_HOME_ENV]: home },
  })) as RunningServe;
  return { lines: output.filter((line) => line.includes('[記憶]')), workspace };
}

describe('serve 起動時檢查 memory 來源（#2271）', () => {
  it('不在 /shared/ 底下：警告，指名來源與要改成什麼，照樣起來', async () => {
    const { lines } = await startupLines(memoryRows(['/MEMORY.md']));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"/MEMORY.md"');
    expect(lines[0]).toContain('/shared/MEMORY.md');
    expect(running).toBeDefined();
  }, 60000);

  it('在底下但檔案不存在：警告，指名來源與主機路徑', async () => {
    const { lines, workspace } = await startupLines(memoryRows(['/shared/MEMORY.md']));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"/shared/MEMORY.md"');
    expect(lines[0]).toContain(join(workspace, 'MEMORY.md'));
  }, 60000);

  it('是目錄不是檔：同樣警告', async () => {
    const { lines } = await startupLines(memoryRows(['/shared/notes']), (workspace) =>
      mkdir(join(workspace, 'notes')),
    );
    expect(lines).toHaveLength(1);
  }, 60000);

  it('在底下且存在：不警告', async () => {
    const { lines } = await startupLines(memoryRows(['/shared/MEMORY.md']), (workspace) =>
      writeFile(join(workspace, 'MEMORY.md'), 'DEPLOY-MEMORY', 'utf8'),
    );
    expect(lines).toEqual([]);
  }, 60000);

  it('沒掛 memory 插件：不多輸出', async () => {
    const { lines } = await startupLines('');
    expect(lines).toEqual([]);
  }, 60000);
});
