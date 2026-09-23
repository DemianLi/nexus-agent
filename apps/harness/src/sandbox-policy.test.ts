/**
 * 圍堵模式那一刀的驗收：**旗標決定得了它、模型知道自己在哪一格、沒有圍堵時不謊報**。
 *
 * 三條斷言的目標各不同，別把它們併成一條：
 *
 * 1. **正面**：掛了 `--workspace` 的**組裝**（不是手搭的 middleware）真的把那句話送進
 *    system prompt，而且那句話給的位址是檔案工具收得下的那一種（`/`），不是主機路徑。手搭一個 middleware 去驗它會加字串，驗到的是 `concat` 會不會動，
 *    不是「這條產品路徑上有沒有人講」。
 * 2. **負面**：沒有 `--workspace` 的組裝**一個字都不能講**。這一條守的是說謊——那種
 *    組裝底下整道 fence 不在路徑上，講「目前是 workspace-write」會讓模型以為根外被擋著。
 * 3. **逐次解析**：fence 讀的是來源不是快照。少了這一條，執行期切換那一刀落地那天
 *    模式會靜靜地停在建構當下那一格，而**拒絕訊息還會照樣印出新的那個名字**。
 */

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent, parseCliArgs, runTurn } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import type { SandboxMode } from './contained-backend.js';
import { parseServeArgs } from './serve.js';
import { shippedPlugins } from './fixtures.js';

const shipped = await shippedPlugins();

const silent = { log: () => undefined, error: () => undefined };

/**
 * 一輪 prompt 裡的 system 訊息。政策那句話併進的是 system prompt，不是對話。
 *
 * **`content` 不一定是字串。** 基座這條路上它是一串 content block，直接 `String()` 會得到
 * `[object Object]`——而那樣的話**每一條否定斷言都會綠**（第一版就是這樣）。所以這裡逐塊
 * 取 `text`，取不到就整塊 JSON 化，寧可多字也不要少字。
 */
function systemPrompt(messages: readonly BaseMessage[]): string {
  return messages
    .filter((message) => message.getType() === 'system')
    .map((message) => flatten(message.content))
    .join('\n');
}

/** 把一則訊息的 `content` 攤成可以搜尋的字串。 */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(flatten).join('\n');
  if (content !== null && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : JSON.stringify(content);
  }
  return String(content);
}

/** 跑一輪，回傳模型這一輪收到的 system prompt。 */
async function promptOf(
  invocation: { readonly workspace?: string; readonly sandbox?: SandboxMode },
  cwd: string,
): Promise<string> {
  const { agent, dispose, model, sessionLog } = await createCliAgent(
    { live: false, ...invocation },
    shipped,
    cwd,
  );
  try {
    await runTurn(agent, '嗨。', silent, sessionLog);
  } finally {
    await dispose();
  }
  return systemPrompt((model as unknown as { lastPrompt: readonly BaseMessage[] }).lastPrompt);
}

describe('模型知不知道自己在哪一格', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-sandbox-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('掛了 --workspace 的組裝會講，而且用工具收的位址指名可寫根：`/`，不給主機路徑', async () => {
    const prompt = await promptOf({ workspace: root }, root);

    expect(prompt).toContain('目前的檔案政策：workspace-write');
    // **指名是重點**：「在工作區之內」對模型不是一個位址。但指名要用工具收的那一種位址。
    expect(prompt).toContain('`/` 就是工作區根');
    // **翻面的絆索**：這一條原本斷言 prompt 裡**有**主機路徑，把缺陷寫成了規格。第 2 階段 live
    // 量到用到檔案工具的 30 輪裡有 23 輪照著那個字串傳主機路徑，工具全都落空。macOS 的 tmpdir 還有一個
    // `/private` 前綴的別名，兩種寫法都不能出現。
    expect(prompt).not.toContain(root);
    expect(prompt).not.toContain(await realpath(root));
  });

  it('句子教的位址，backend 真的收：`/` 開頭落在可寫根，主機路徑落成巢狀', async () => {
    // **把提示句綁在 backend 的位址空間上**。哪天圍堵不再走 `virtualMode`、改收主機路徑，
    // 這一條會紅，提醒提示句也要跟著換回主機路徑（dsh 的形狀）。
    const backend = new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });

    expect((await backend.write('/src/taught.ts', '一')).error).toBeUndefined();
    expect(await readFile(join(root, 'src', 'taught.ts'), 'utf8')).toBe('一');

    await backend.write(join(root, 'host.txt'), '二');
    await expect(readFile(join(root, 'host.txt'), 'utf8')).rejects.toThrow('ENOENT');
  });

  it('--sandbox read-only 講的是 read-only 那一段，而且叫模型不要先拒絕', async () => {
    const prompt = await promptOf({ workspace: root, sandbox: 'read-only' }, root);

    expect(prompt).toContain('目前的檔案政策：read-only');
    // 照抄 dsh 的那一句。少了它，模型會把政策當成「這件事做不到」而連試都不試——
    // 那是把一道圍堵變成一個能力謊報。
    expect(prompt).toContain('不要只憑這一條就拒絕');
    expect(prompt).not.toContain('workspace-write');
  });

  it('**沒有 --workspace 就一個字都不講**——那種組裝一格圍堵都沒有', async () => {
    const prompt = await promptOf({}, root);

    expect(prompt).not.toContain('目前的檔案政策');
  });
});

describe('fence 讀的是來源不是快照', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-sandbox-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('同一顆 backend，來源換一格，下一次呼叫就照新的那一格判', async () => {
    let mode: SandboxMode = 'workspace-write';
    const backend = new ContainedFilesystemBackend({ rootDir: root, mode: () => mode });

    const allowed = await backend.write('/a.txt', '一');
    expect(allowed.error).toBeUndefined();

    mode = 'read-only';
    const denied = await backend.write('/b.txt', '二');

    expect(denied.error).toContain('這個 backend 是唯讀的');
    // **拒絕訊息要指名擋下它的那一格**，不是建構當下那一格。
    expect(denied.error).toContain('mode: read-only');
    expect(backend.mode).toBe('read-only');
  });

  it('給字面值等於給一個恆定的來源', () => {
    const backend = new ContainedFilesystemBackend({ rootDir: root, mode: 'danger-full-access' });

    expect(backend.mode).toBe('danger-full-access');
  });
});

describe('--sandbox 的解析', () => {
  it('沒配 --workspace 就拋——那個組合底下這個模式一個位元組都影響不到', () => {
    expect(() => parseCliArgs(['--sandbox', 'read-only'])).toThrow('要配 --workspace');
    expect(() => parseServeArgs(['--sandbox', 'read-only'])).toThrow('要配 --workspace');
  });

  it('認不得的模式名要拋，不能靜靜當成 workspace-write', () => {
    expect(() => parseCliArgs(['--workspace', '/w', '--sandbox', 'readonly'])).toThrow('認不得');
    expect(() => parseServeArgs(['--workspace', '/w', '--sandbox', 'readonly'])).toThrow('認不得');
  });

  it('兩個入口收下同一個值', () => {
    expect(parseCliArgs(['--workspace', '/w', '--sandbox', 'read-only']).sandbox).toBe('read-only');
    expect(parseServeArgs(['--workspace', '/w', '--sandbox', 'read-only']).sandbox).toBe(
      'read-only',
    );
  });

  it('沒給就是不給——預設留給 backend 決定', () => {
    expect(parseCliArgs(['--workspace', '/w']).sandbox).toBeUndefined();
  });
});
