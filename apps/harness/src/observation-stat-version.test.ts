/**
 * **寫與改前的版本比對只做 stat**（[#2030](https://github.com/DemianLi/nexus-agent/issues/2030)）的驗收：圍堵 backend 用 stat token、
 * 不讀內容；沒有 stat 的那一格（這裡用只認得 `readRaw` 的假 backend 當插件路由）照舊整份讀、算內容雜湊，兩種 token 各歸各的 backend。
 *
 * 組裝照產品的形狀：圍堵 backend 是 default，外面一層 {@link ModifiedOrderCompositeBackend} 掛路由——基座建 composite 時把子 backend
 * 換成轉接物件，這一層要穿得過去；另一條把 composite 再包一層，驗一層層照轉。讀檔那一側「`read_file` 回報的 token 與這裡比的逐字相同」由 `contained-read-window.test.ts` 的驗收 2b 釘著。
 */

import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import {
  createObservationPolicy,
  ModifiedOrderCompositeBackend,
  OBSERVED_EDIT_TOOL,
  OBSERVED_READ_TOOL,
  toolErrorOf,
} from '@nexus/core';
import type { AnyBackendProtocol } from 'deepagents';
import { FilesystemBackend } from 'deepagents';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ContainedFilesystemBackend } from './contained-backend.js';

type Wrapper = (
  request: unknown,
  handler: (request: unknown) => Promise<unknown>,
) => Promise<unknown>;

const requestFor = (toolName: string, path: string): unknown => ({
  toolCall: { name: toolName, args: { file_path: path }, id: 'call-1' },
  tool: undefined,
});

const ok = async (): Promise<ToolMessage> =>
  new ToolMessage({ content: '跑過了', tool_call_id: 'call-1' });

/** 沒有 stat 的 backend：只認得 `readRaw`，內容與時間戳記在 map 裡，數 `readRaw` 叫了幾次。 */
function memoryRoute(): {
  backend: AnyBackendProtocol;
  set(path: string, content: string, modifiedAt: string): void;
  readonly reads: number;
} {
  const files = new Map<string, { content: string; modified_at: string }>();
  let reads = 0;
  return {
    backend: {
      readRaw(path: string) {
        reads += 1;
        const file = files.get(path);
        return file === undefined ? { error: `File '${path}' not found` } : { data: file };
      },
    } as unknown as AnyBackendProtocol,
    set: (path, content, modifiedAt) => files.set(path, { content, modified_at: modifiedAt }),
    get reads() {
      return reads;
    },
  };
}

let root: string;
let contained: ContainedFilesystemBackend;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-stat-version-'));
  contained = new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 產品的形狀：圍堵 backend 當 default，`/mem/` 掛沒有 stat 的路由。 */
function assemble(): { wrap: Wrapper; memory: ReturnType<typeof memoryRoute> } {
  const memory = memoryRoute();
  const composite = new ModifiedOrderCompositeBackend(contained, { '/mem/': memory.backend });
  const policy = createObservationPolicy(composite) as { wrapToolCall?: Wrapper };
  return { wrap: policy.wrapToolCall!, memory };
}

describe('圍堵 backend：比對只做 stat', () => {
  it('讀過、改之前的比對不呼叫 readRaw，改得了', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(1024 * 1024));
    const raw = vi.spyOn(FilesystemBackend.prototype, 'readRaw');
    const { wrap } = assemble();
    await wrap(requestFor(OBSERVED_READ_TOOL, '/big.txt'), ok);
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/big.txt'), ok)) as ToolMessage;
    expect(result.status).not.toBe('error');
    expect(raw).not.toHaveBeenCalled();
  });

  it('讀過之後被改成等長的內容（mtime 變了）→ FS_STALE_VERSION', async () => {
    const file = join(root, 'same-size.txt');
    await writeFile(file, 'before\n');
    await utimes(file, 1_000, 1_000);
    const { wrap } = assemble();
    await wrap(requestFor(OBSERVED_READ_TOOL, '/same-size.txt'), ok);
    await writeFile(file, 'BEFORE\n');
    await utimes(file, 2_000, 2_000);
    const result = (await wrap(
      requestFor(OBSERVED_EDIT_TOOL, '/same-size.txt'),
      ok,
    )) as ToolMessage;
    expect(toolErrorOf(result)?.code).toBe('FS_STALE_VERSION');
  });

  it('composite 再包一層：一層層照轉到圍堵 backend，仍不呼叫 readRaw', async () => {
    await writeFile(join(root, 'nested.txt'), 'nested\n');
    const raw = vi.spyOn(FilesystemBackend.prototype, 'readRaw');
    const inner = new ModifiedOrderCompositeBackend(contained, {});
    const outer = new ModifiedOrderCompositeBackend(memoryRoute().backend, { '/inner/': inner });
    const { wrapToolCall: wrap } = createObservationPolicy(outer) as { wrapToolCall: Wrapper };
    await wrap(requestFor(OBSERVED_READ_TOOL, '/inner/nested.txt'), ok);
    const result = (await wrap(
      requestFor(OBSERVED_EDIT_TOOL, '/inner/nested.txt'),
      ok,
    )) as ToolMessage;
    expect(result.status).not.toBe('error');
    expect(raw).not.toHaveBeenCalled();
  });

  it('讀過之後大小變了 → FS_STALE_VERSION', async () => {
    const file = join(root, 'grown.txt');
    await writeFile(file, 'a\n');
    const { wrap } = assemble();
    await wrap(requestFor(OBSERVED_READ_TOOL, '/grown.txt'), ok);
    await writeFile(file, 'a\nb\n');
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/grown.txt'), ok)) as ToolMessage;
    expect(toolErrorOf(result)?.code).toBe('FS_STALE_VERSION');
  });
});

describe('沒有 stat 的路由：照舊整份讀、比內容雜湊', () => {
  it('沒被動過 → 改得了，而且比對真的讀了內容', async () => {
    const { wrap, memory } = assemble();
    memory.set('/note.md', '原本的', '2026-01-01T00:00:01.000Z');
    await wrap(requestFor(OBSERVED_READ_TOOL, '/mem/note.md'), ok);
    const before = memory.reads;
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/mem/note.md'), ok)) as ToolMessage;
    expect(result.status).not.toBe('error');
    expect(memory.reads).toBeGreaterThan(before);
  });

  it('同一毫秒內被改成等長的內容 → 內容雜湊擋下（FS_STALE_VERSION）', async () => {
    const { wrap, memory } = assemble();
    memory.set('/note.md', '原本的', '2026-01-01T00:00:01.000Z');
    await wrap(requestFor(OBSERVED_READ_TOOL, '/mem/note.md'), ok);
    memory.set('/note.md', '別人的', '2026-01-01T00:00:01.000Z');
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/mem/note.md'), ok)) as ToolMessage;
    expect(toolErrorOf(result)?.code).toBe('FS_STALE_VERSION');
  });
});
