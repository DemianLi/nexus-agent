/**
 * `docs/operations.md`〈多人共用主機的部署清單〉第 5 條那份 MCP 容器範例的紅燈（[#1678](https://github.com/DemianLi/nexus-agent/issues/1678) Q5 (b)）。
 *
 * 範例是文件裡的一段 YAML，沒人載入它，就沒人知道它跟 MCP 設定的 schema 漂開了（[#1622](https://github.com/DemianLi/nexus-agent/issues/1622)
 * 才剛改過那份 schema）。這裡把它讀出來，交給管理者真的會走的那條路：`parsePatchList` 讀 patch、`applyEntryPatches` 疊、
 * `validateEntries` 驗條目、`resolveEntryModule` 載入 `@nexus/plugin-mcp`、`resolveEntries` 用它的 `Config` 驗設定。
 * 做法照 `documented-fixture.ts`（[#490](https://github.com/DemianLi/nexus-agent/issues/490)）：**抓不到或抓到兩段都拋，不回預設值**。
 *
 * 這一份只守「範例是一條載得進來的設定」與文件散文講的幾個旗標；podman 真的把 server 圍起來，不在這裡（證據在 PR 內文）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEntries } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import {
  applyEntryPatches,
  parsePatchList,
  resolveEntryModule,
  validateEntries,
} from './plugin-config.js';

const operationsDoc = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/operations.md');

const BEGIN = '<!-- mcp-container-example:begin';
const FENCE =
  /<!-- mcp-container-example:begin[^>]*-->\s*```yaml\n([\s\S]*?)\n```\s*<!-- mcp-container-example:end -->/gu;

/** 取出文件裡兩個標記之間的 YAML。標記不在、或不只一段，都丟錯，不回空字串。 */
function extractMcpContainerExample(markdown: string): string {
  const begins = markdown.split(BEGIN).length - 1;
  const blocks = [...markdown.matchAll(FENCE)];
  if (begins !== 1 || blocks.length !== 1 || blocks[0]?.[1] === undefined) {
    throw new Error(
      `operations.md 要剛好有一段 mcp-container-example 標記包住的 yaml 區塊，實際 ${String(begins)} 個標記、${String(blocks.length)} 段`,
    );
  }
  return blocks[0][1];
}

/** 範例走一遍載入：patch → 條目 → 模組 → 設定驗證。回驗過的設定。 */
async function loadExample(yaml: string): Promise<{ plugin: { name: string }; config: unknown }[]> {
  const label = 'operations.md 的 MCP 容器範例';
  const rows = applyEntryPatches([], parsePatchList(yaml, label));
  const entries = await Promise.all(validateEntries(rows, label).map(resolveEntryModule));
  return resolveEntries(entries).map((resolved) => ({
    plugin: resolved.plugin,
    config: resolved.config,
  }));
}

const example = extractMcpContainerExample(readFileSync(operationsDoc, 'utf8'));

describe('operations.md 的 MCP 容器範例', () => {
  it('是一條載得進來的設定：patch、條目與 MCP 的 schema 都過', async () => {
    const loaded = await loadExample(example);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.plugin.name).toBe('mcp');
    expect(loaded[0]?.config).toMatchObject({
      serverName: 'crm',
      connection: { transport: 'stdio', command: 'podman' },
    });
  });

  it('散文講的旗標都在：-i、--rm、--http-proxy=false、podman 專用的 HOME', async () => {
    const [loaded] = await loadExample(example);
    const connection = (
      loaded?.config as { connection: { args?: string[]; env?: Record<string, string> } }
    ).connection;
    const args = connection.args ?? [];
    // podman 的儲存預設落在 $HOME；不給專用的 HOME，就會寫進 harness home（第 2 條的 find 會掃出幾萬筆）
    expect(connection.env?.HOME).toBe('/var/lib/nexus-agent-podman');
    expect(args[0]).toBe('run');
    expect(args).toContain('-i');
    expect(args).toContain('--rm');
    expect(args).toContain('--http-proxy=false');
  });

  it('圍堵的旗標都在：--network=none、--read-only、--cap-drop=ALL、no-new-privileges', async () => {
    const [loaded] = await loadExample(example);
    const args = (loaded?.config as { connection: { args?: string[] } }).connection.args ?? [];
    expect(args).toContain('--network=none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
  });

  it('不給 pty（-t／--tty／-it 這類合併寫法都算），也不放寬網路、行程或使用者命名空間', async () => {
    const [loaded] = await loadExample(example);
    const args = (loaded?.config as { connection: { args?: string[] } }).connection.args ?? [];
    expect(args.filter((arg) => arg === '--tty' || /^-[A-Za-z]*t[A-Za-z]*$/u.test(arg))).toEqual(
      [],
    );
    expect(args.filter((arg) => /^--(net|network|pid|userns|ipc|uts)=host$/u.test(arg))).toEqual(
      [],
    );
    expect(args.filter((arg) => /^--(privileged|cap-add)/u.test(arg))).toEqual([]);
  });

  it('範例不放憑證，也不把 serve 帳號加進特權群組', () => {
    expect(example).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|nvapi-/iu);
    expect(example).not.toMatch(/--privileged|--group-add|docker\.sock/u);
  });

  it('connection.command 改名，載入就失敗（schema 是 strict）', async () => {
    const renamed = example.replace('command: podman', 'cmd: podman');
    expect(renamed).not.toBe(example);
    await expect(loadExample(renamed)).rejects.toThrow(/config 不合法/u);
  });

  it('serverName 不合規則，載入就失敗', async () => {
    const bad = example.replace('serverName: crm', 'serverName: crm.prod');
    expect(bad).not.toBe(example);
    await expect(loadExample(bad)).rejects.toThrow(/serverName/u);
  });
});

describe('extractMcpContainerExample', () => {
  const block = (body: string): string =>
    `<!-- mcp-container-example:begin（說明） -->\n\`\`\`yaml\n${body}\n\`\`\`\n<!-- mcp-container-example:end -->`;

  it('恰好一段時回傳那段 YAML', () => {
    expect(extractMcpContainerExample(`# 文件\n\n${block('- id: a')}\n`)).toBe('- id: a');
  });

  it('標記不在就丟錯，不回空字串', () => {
    expect(() => extractMcpContainerExample('# 沒有範例')).toThrow(/剛好有一段/u);
  });

  it('標記在、但裡面不是 yaml 區塊，也丟錯', () => {
    expect(() =>
      extractMcpContainerExample(
        '<!-- mcp-container-example:begin -->\n```bash\nls\n```\n<!-- mcp-container-example:end -->',
      ),
    ).toThrow(/剛好有一段/u);
  });

  it('兩段也丟錯，不猜該用哪一段', () => {
    expect(() => extractMcpContainerExample(`${block('- id: a')}\n\n${block('- id: b')}`)).toThrow(
      /2 個標記/u,
    );
  });
});
