/**
 * 寫入口在寫入前試掛（[#2073](https://github.com/DemianLi/nexus-agent/issues/2073)）：新冒出的 `apply`／`requires` 失敗當場拒收；
 * 原本就壞、這次仍然壞的列不擋無關的修改。樹上的列在 `apply` 掉那一條在 `plugin-tree-new-failure.test.ts`（要起 serve 對照）。
 *
 * 量具：home 底下一顆相容層的插件 `probe`，設定的 `ok` 不是 `true` 就在 `apply` 拋；`ws-probe` 沒有 `--workspace` 就在 `apply` 拋；
 * 一顆樹上的插件 `waiting`，要一個沒人提供的服務，所以一直缺服務。
 */

import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin, PluginChangeRejected } from './plugin-change.js';
import type { PluginChange, PluginChangeOptions } from './plugin-change.js';
import { appendRaw, journalPathOf, seedHomePatch } from './plugin-journal.fixture.js';
import { readJournal } from './plugin-journal.js';

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REASON = '故意在 apply 裡壞掉';

function write(dir: string, name: string, source: string): void {
  writeFileSync(join(dir, name), source, { mode: 0o600 });
}

/** 一個 home，底下放好三顆夾具插件；`rows` 是遷移進紀錄的那幾列。 */
function home(rows: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-plugin-trial-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  write(
    dir,
    'probe.ts',
    `export default { name: 'probe', apply(_registry, config) { if (config?.ok !== true) throw new Error('${REASON}'); } };\n`,
  );
  write(
    dir,
    'ws-probe.ts',
    "export default { name: 'ws-probe', apply(registry) { if (registry.services.get('workspaceRoot') === undefined) throw new Error('要 --workspace'); } };\n",
  );
  write(
    dir,
    'waiting.mjs',
    `import { z } from 'zod';
export const name = 'waiting';
export const inject = { nobody: { range: '^1.0.0' } };
export const Config = z.strictObject({ n: z.number() });
export const manifest = {
  id: 'waiting', version: '1.0.0', owner: 't',
  provides: [], consumes: [{ token: 'nobody', range: '^1.0.0' }],
  config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply() {}
`,
  );
  seedHomePatch(dir, `- insert:\n${rows}`);
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

const probeRow = (ok: boolean) =>
  `    - id: probe\n      name: './probe.ts'\n      config:\n        ok: ${String(ok)}\n`;

function opsOf(dir: string): string[] {
  return (readJournal(journalPathOf(dir))?.records ?? []).map((record) => record.op);
}

async function rejected(
  change: PluginChange,
  options: PluginChangeOptions,
): Promise<PluginChangeRejected> {
  const error = await changePlugin(change, options).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof PluginChangeRejected)) throw new Error(`預期被拒，卻是：${String(error)}`);
  return error;
}

describe('新冒出的失敗當場拒收', () => {
  it('相容層的列會在 apply 掉：拒收，訊息帶列 id、哪一步、原因與 --patch／--workspace 的提醒；紀錄裡沒有被接受的那一筆', async () => {
    const { dir, env } = home(probeRow(true));
    const error = await rejected({ op: 'config-set', id: 'probe', config: { ok: false } }, { env });
    expect(error.message).toContain('"probe"（apply）：');
    expect(error.message).toContain(REASON);
    expect(error.message).toContain('--patch 或 --workspace');
    expect(opsOf(dir)).toEqual(['patch', 'rejected']);
  });

  it('原本就壞的列改成另一個仍然壞的宣告：算新，拒收', async () => {
    const { dir, env } = home(probeRow(false));
    await rejected({ op: 'config-set', id: 'probe', config: { ok: false, n: 2 } }, { env });
    expect(opsOf(dir)).toEqual(['patch', 'rejected']);
  });

  it('必掛的列壞著：無關的修改也拒收', async () => {
    const { dir, env } = home(probeRow(true));
    await appendRaw(dir, {
      op: 'config-set',
      id: 'system-prompt',
      name: '@nexus/plugin-system-prompt',
      before: null,
      after: { personaPrefix: '{{nope}}' },
    });
    const error = await rejected({ op: 'disable', id: 'todo' }, { env });
    expect(error.message).toContain('"system-prompt"（apply，必掛）');
  });
});

describe('不是新的失敗照收', () => {
  it('原本就壞、這次仍然壞的列，不擋無關的修改', async () => {
    const { dir, env } = home(probeRow(false));
    const result = await changePlugin({ op: 'disable', id: 'todo' }, { env });
    expect(result.outcome).toBe('recorded');
    expect(opsOf(dir)).toEqual(['patch', 'disable']);
  });

  it('把壞掉的列改好：照收', async () => {
    const { env } = home(probeRow(false));
    const result = await changePlugin(
      { op: 'config-set', id: 'probe', config: { ok: true } },
      { env },
    );
    expect(result.outcome).toBe('recorded');
  });

  it('樹上的列缺服務是在等提供者，不算失敗：改它的設定照收', async () => {
    const { env } = home(
      `    - id: waiting\n      name: './waiting.mjs'\n      config:\n        n: 1\n`,
    );
    const result = await changePlugin(
      { op: 'config-set', id: 'waiting', config: { n: 2 } },
      { env },
    );
    expect(result.outcome).toBe('recorded');
  });
});

describe('--workspace', () => {
  it('serve 帶 --workspace 才起得來的列：沒帶就拒收，帶了照收；試掛不在工作區底下留檔', async () => {
    const { env } = home(
      `    - id: ws-probe\n      name: './ws-probe.ts'\n      config:\n        n: 1\n`,
    );
    const change = { op: 'config-set', id: 'ws-probe', config: { n: 2 } } as const;
    const error = await rejected(change, { env });
    expect(error.message).toContain('要 --workspace');

    const workspace = mkdtempSync(join(tmpdir(), 'nexus-plugin-trial-ws-'));
    temporary.push(workspace);
    const result = await changePlugin(change, { env, workspace });
    expect(result.outcome).toBe('recorded');
    expect(readdirSync(workspace)).toEqual([]);
  });
});
