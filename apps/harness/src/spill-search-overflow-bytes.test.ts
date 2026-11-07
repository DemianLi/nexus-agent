/**
 * 超過筆數上限、又大到要外溢的 `grep`：模型看到的那則、外溢存檔、搜尋上限存檔，三份逐位元組釘住
 * （[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)）。
 *
 * 兩份存檔釘 sha256：期望值是 `1a30daf1` 上用同一支測試錄到的（那裡搜尋上限與外溢還是 stack 上的 middleware，這支釘兩種組裝的位元組相同），兩個 loop 相同，存檔名裡的
 * 隨機段換成 `<id>` 再算。要重錄，把這支複製到那個 commit 上跑、照失敗訊息裡的 received 抄回來。
 *
 * 模型看到的那則不釘雜湊：預覽切在哪取決於通知裡存檔名的 o200k 估算，存檔名有隨機段，同一份程式碼每跑一次切點都會動，所以逐位元組
 * 拼回來——頭是外溢存檔的開頭、尾是它的結尾、中間是 `[...]`、最後是省略位元組數算得對的那句通知。
 *
 * 有共用區與沒有共用區各一組：有共用區時前綴（`SHARED_WORKSPACE_CONTENT_NOTICE`）只能加一次。
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { SHARED_WORKSPACE_CONTENT_NOTICE } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';

const shipped = await shippedPlugins();

const flatten = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : (content as readonly { readonly type?: string; readonly text?: string }[])
        .map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`))
        .join('\n');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const normalize = (text: string): string =>
  text.replace(/\/large_tool_results\/[0-9a-f]{12}-/gu, '/large_tool_results/<id>-');
const sha = (text: string): string => createHash('sha256').update(normalize(text)).digest('hex');

const GAP = '\n\n[...]\n\n';
const NOTICE =
  /\n\n(\(Omitted (\d+) bytes\. Full formatted result stored at: \/large_tool_results\/[0-9a-f]{12}-grep\.txt\. Use read_file with offset\/limit, or grep this path to search within it\.\))$/u;

/** 模型那則拆回頭、尾與通知，再對外溢存檔逐位元組核。 */
function expectPreviewOf(model: string, spill: string): void {
  const notice = NOTICE.exec(model);
  expect(notice, '結尾是外溢通知').not.toBeNull();
  const body = model.slice(0, notice!.index);
  const gap = body.indexOf(GAP);
  expect(gap, '頭尾之間有 [...]').toBeGreaterThan(0);
  const head = body.slice(0, gap);
  const tail = body.slice(gap + GAP.length);
  expect(spill.startsWith(head)).toBe(true);
  expect(spill.endsWith(tail)).toBe(true);
  expect(head.length + tail.length).toBeLessThan(spill.length);
  const omitted =
    Buffer.byteLength(spill, 'utf8') -
    Buffer.byteLength(head, 'utf8') -
    Buffer.byteLength(tail, 'utf8');
  expect(Number(notice![2])).toBe(omitted);
  expect(model).toBe(`${head}${GAP}${tail}\n\n${notice![1]}`);
}

let shared: string;
let priv: string;
let stash: string;
beforeEach(async () => {
  const scratch = (tag: string) => mkdtemp(join(tmpdir(), `nexus-spill-bytes-${tag}-`));
  [shared, priv, stash] = await Promise.all([scratch('shared'), scratch('priv'), scratch('stash')]);
  const line = (index: number) => `bulk-hit-${index} ${'padding '.repeat(20)}`;
  const body = `${Array.from({ length: 300 }, (_, index) => line(index)).join('\n')}\n`;
  await Promise.all([
    writeFile(join(shared, 'a.md'), body, 'utf8'),
    writeFile(join(priv, 'a.md'), body, 'utf8'),
  ]);
});
afterEach(async () => {
  await Promise.all([shared, priv, stash].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 跑一次 `grep`，回模型看到的那則與兩份存檔（外溢、搜尋上限）。 */
async function grepOnce(withShared: boolean): Promise<{
  model: string;
  spill: string;
  results: string;
}> {
  const built = await createCliAgent(
    {
      live: false,
      workspace: withShared ? shared : priv,
      ...(withShared && { workspaceRoot: priv, sharedWorkspaceRoot: shared }),
      sandbox: 'workspace-write',
      toolResultStash: { rootDir: stash, session: 'spill-bytes' },
      spillPolicy: { maxInlineTokens: 300 },
    },
    withScriptedModel(shipped, [
      {
        content: '',
        toolCalls: [
          { name: 'grep', args: { pattern: 'bulk-hit-', path: withShared ? '/shared' : '/' } },
        ],
      },
      { content: '收工。' },
    ]),
    priv,
  );
  const detach = built.attachSession(built.sessions);
  let model = '';
  try {
    const state = (await built.agent.invoke(toAgentInvocation('搜。'), {
      configurable: { thread_id: 'spill-bytes' },
    })) as { messages: BaseMessage[] };
    model = flatten(state.messages.find((message) => message.getType() === 'tool')?.content ?? '');
  } finally {
    detach();
    await built.dispose();
  }
  const files = walk(stash);
  const one = (suffix: string): string => {
    const found = files.filter((file) => file.endsWith(suffix));
    expect(found, suffix).toHaveLength(1);
    return readFileSync(found[0]!, 'utf8');
  };
  return { model, spill: one('-grep.txt'), results: one('-grep-results.txt') };
}

/** `1a30daf1` 上錄到的兩份存檔的 sha256，兩個 loop 相同。 */
const EXPECTED: Record<'plain' | 'shared', { spill: string; results: string }> = {
  plain: {
    spill: 'c45c5effd6332770ed290dbc3342f038eb9b350cb0ee673064bf344e7e489f1f',
    results: 'c8d2946de9deee81ea1f2772a3632d4b921fe243c9325b54da4c01efc565544e',
  },
  shared: {
    spill: '5b6da472e719eb538eb569c19ada663518361705d08e643d5c6665dca9beb3ee',
    results: '728503ad62a185d8f98bd02c93901b89ca5a44065dfab5565e792002f17ebca7',
  },
};

describe('外溢加搜尋上限的 grep：三份位元組跟 `1a30daf1` 錄到的相同', () => {
  it.each([
    ['沒有共用區', 'plain', false],
    ['有共用區', 'shared', true],
  ] as const)(
    '%s',
    async (_label, key, withShared) => {
      const { model, spill, results } = await grepOnce(withShared);
      // 位元組之外先講形狀，紅了的時候好讀：外溢的提示在最後，搜尋上限的提示在外溢存檔的最後。
      expect(model).toMatch(/^(.+\n\n)?Found 250 of 300 matches\n\n/u);
      expect(model).toMatch(/\(Omitted \d+ bytes\. Full formatted result stored at: [^\n]+\)$/u);
      expect(spill).toMatch(/\(Full grep result stored at: [^\n]+\)$/u);
      expect(results).toMatch(/^(.+\n\n)?Found 300 matches\n\n/u);
      const notices = (text: string) => text.split(SHARED_WORKSPACE_CONTENT_NOTICE).length - 1;
      expect([notices(model), notices(spill), notices(results)]).toEqual(
        withShared ? [1, 1, 1] : [0, 0, 0],
      );
      expect({ spill: sha(spill), results: sha(results) }).toEqual(EXPECTED[key]);
      expectPreviewOf(model, spill);
    },
    60000,
  );
});
