/**
 * 摘要歷史檔的暫存（[#1389](https://github.com/DemianLi/nexus-agent/issues/1389)）：範圍內只記不寫，結束時依
 * 「這一步有沒有生出摘要」提交。真摘要器配真 graph 的整合測試在 `apps/harness/src/summary-history-staging.test.ts`。
 */

import { AIMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { AnyBackendProtocol } from 'deepagents';
import { describe, expect, it } from 'vitest';
import type { AgentMiddleware } from './base-types.js';
import { SessionLog } from './session-log.js';
import type { SessionLookup } from './registry.js';
import { createHistoryStaging } from './summary-history-staging.js';

const PREFIX = '/conversation_history';
const FILE = `${PREFIX}/session_a.md`;

/** 記著每個呼叫的記憶體 backend；寫入立即生效，與基座的 `uploadFiles` 路徑同形。 */
class MemoryBackend {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  readonly failWith: { write?: Error; resultError?: string } = {};

  write(path: string, content: string) {
    this.calls.push(`write:${path}`);
    if (this.failWith.write !== undefined) throw this.failWith.write;
    if (this.failWith.resultError !== undefined) return { error: this.failWith.resultError };
    this.files.set(path, content);
    return { path };
  }

  edit(path: string, oldString: string, newString: string) {
    this.calls.push(`edit:${path}`);
    this.files.set(path, newString);
    return { path, occurrences: oldString === '' ? 0 : 1 };
  }

  uploadFiles(files: readonly (readonly [string, Uint8Array])[]) {
    for (const [path, bytes] of files) {
      this.calls.push(`upload:${path}`);
      this.files.set(path, new TextDecoder().decode(bytes));
    }
    return files.map(([path]) => ({ path, error: null }));
  }

  downloadFiles(paths: readonly string[]) {
    return paths.map((path) => {
      const content = this.files.get(path);
      return content === undefined
        ? { path, content: null, error: 'file_not_found' }
        : { path, content: new TextEncoder().encode(content), error: null };
    });
  }

  read(path: string) {
    return { content: this.files.get(path) ?? '' };
  }
}

const asBackend = (backend: MemoryBackend) => backend as unknown as AnyBackendProtocol;

/** 摘要器替身：`body` 在範圍內跑，可對 staged backend 做事、對日誌記事件、回 Command 或拋。 */
function summarizer(
  body: (context: { backend: AnyBackendProtocol; log: SessionLog }) => Promise<unknown>,
  staged: { backend: AnyBackendProtocol },
  log: SessionLog,
): AgentMiddleware {
  return {
    name: 'SummarizationMiddleware',
    wrapModelCall: async () => body({ backend: staged.backend, log }),
  } as unknown as AgentMiddleware;
}

const lookup = (log: SessionLog) => ({
  forCall: (): SessionLookup => ({ kind: 'ok', address: { kind: 'root' }, log }),
});

const run = (middleware: AgentMiddleware) =>
  middleware.wrapModelCall!(
    { messages: [], runtime: { configurable: {} } } as never,
    (async () => new AIMessage('由 handler 回')) as never,
  );

const record = (log: SessionLog, filePath: string | null) =>
  log.append('compaction/summary', { cutoffIndex: 1, messagesBefore: 3, filePath });

const eventCommand = (filePath: string | null) =>
  new Command({ update: { _summarizationEvent: { cutoffIndex: 1, filePath } } });

describe('暫存範圍之外：什麼都不攔', () => {
  it('不在範圍內的寫入直接進底下的 backend', async () => {
    const memory = new MemoryBackend();
    const staging = createHistoryStaging(asBackend(memory), PREFIX);

    await (staging.backend as unknown as MemoryBackend).write(FILE, '直寫');

    expect(memory.files.get(FILE)).toBe('直寫');
  });

  it('底下沒有 uploadFiles 就不宣稱有（基座靠這個選路）', () => {
    const bare = { write: () => ({ path: FILE }) } as unknown as AnyBackendProtocol;
    const staging = createHistoryStaging(bare, PREFIX);
    expect((staging.backend as unknown as { uploadFiles?: unknown }).uploadFiles).toBeUndefined();
  });
});

describe('暫存範圍之內：這一步生出了摘要才提交', () => {
  it('日誌上這一步記了 compaction/summary 指著它：結束時寫進去', async () => {
    const memory = new MemoryBackend();
    const log = new SessionLog('staging');
    const staging = createHistoryStaging(asBackend(memory), PREFIX);
    const wrapped = staging.wrap(
      summarizer(
        async ({ backend }) => {
          await (backend as unknown as MemoryBackend).write(FILE, '第一段');
          record(log, FILE);
          return new AIMessage('ok');
        },
        staging,
        log,
      ),
      lookup(log),
    );

    await run(wrapped);

    expect(memory.files.get(FILE)).toBe('第一段');
  });

  it('範圍內的寫入在結束前不落地', async () => {
    const memory = new MemoryBackend();
    const log = new SessionLog('staging');
    const staging = createHistoryStaging(asBackend(memory), PREFIX);
    let seenDuring: number | undefined;
    const wrapped = staging.wrap(
      summarizer(
        async ({ backend }) => {
          await (backend as unknown as MemoryBackend).write(FILE, '第一段');
          seenDuring = memory.files.size;
          record(log, FILE);
          return new AIMessage('ok');
        },
        staging,
        log,
      ),
      lookup(log),
    );

    await run(wrapped);

    expect(seenDuring).toBe(0);
  });

  /** S2：生摘要的呼叫失敗、基座吞掉照原請求送出——日誌沒有事件、也沒有 Command。 */
  it('這一步沒生出摘要（日誌沒事件、也沒回 Command）：丟棄', async () => {
    const memory = new MemoryBackend();
    const log = new SessionLog('staging');
    const staging = createHistoryStaging(asBackend(memory), PREFIX);
    const wrapped = staging.wrap(
      summarizer(
        async ({ backend }) => {
          await (backend as unknown as MemoryBackend).write(FILE, '寫了但沒生出摘要');
          return new AIMessage('ok');
        },
        staging,
        log,
      ),
      lookup(log),
    );

    await run(wrapped);

    expect(memory.files.size).toBe(0);
    expect(memory.calls).toEqual([]);
  });

  /** S1／S6：同一步內重摘，同一個檔寫兩次、第二次是「已提交的 ＋ 自己這一段」。 */
  it('同一路徑寫多次：最後一次勝出；讀到的是已提交的', async () => {
    const memory = new MemoryBackend();
    memory.files.set(FILE, '已提交的。\n');
    const log = new SessionLog('staging');
    const staging = createHistoryStaging(asBackend(memory), PREFIX);
    const reads: string[] = [];
    const wrapped = staging.wrap(
      summarizer(
        async ({ backend }) => {
          const view = backend as unknown as MemoryBackend;
          for (const section of ['第一次嘗試', '第二次嘗試']) {
            const [existing] = view.downloadFiles([FILE]);
            const committed = new TextDecoder().decode(existing!.content as Uint8Array);
            reads.push(committed);
            await view.uploadFiles([[FILE, new TextEncoder().encode(`${committed}${section}\n`)]]);
            record(log, FILE);
          }
          return new AIMessage('ok');
        },
        staging,
        log,
      ),
      lookup(log),
    );

    await run(wrapped);

    expect(reads).toEqual(['已提交的。\n', '已提交的。\n']);
    expect(memory.files.get(FILE)).toBe('已提交的。\n第二次嘗試\n');
    expect(memory.calls).toEqual([`upload:${FILE}`]);
  });

  /** S3／S4／S10：摘要生出來了、主請求才拋或被停——檔要留，事件與下一步補的 state 事件指著它。 */
  it('這一步拋了，但日誌上有指著它的事件：照樣提交，錯誤原樣往外', async () => {
    const memory = new MemoryBackend();
    const log = new SessionLog('staging');
    const staging = createHistoryStaging(asBackend(memory), PREFIX);
    const boom = new Error('upstream 503');
    const wrapped = staging.wrap(
      summarizer(
        async ({ backend }) => {
          await (backend as unknown as MemoryBackend).write(FILE, '摘要後才失敗');
          record(log, FILE);
          throw boom;
        },
        staging,
        log,
      ),
      lookup(log),
    );

    await expect(run(wrapped)).rejects.toBe(boom);

    expect(memory.files.get(FILE)).toBe('摘要後才失敗');
  });

  it('這一步拋了、日誌上也沒有事件：丟棄，錯誤原樣往外', async () => {
    const memory = new MemoryBackend();
    const log = new SessionLog('staging');
    const staging = createHistoryStaging(asBackend(memory), PREFIX);
    const boom = new Error('生摘要那次就拋了');
    const wrapped = staging.wrap(
      summarizer(
        async ({ backend }) => {
          await (backend as unknown as MemoryBackend).write(FILE, '不該留下');
          throw boom;
        },
        staging,
        log,
      ),
      lookup(log),
    );

    await expect(run(wrapped)).rejects.toBe(boom);

    expect(memory.files.size).toBe(0);
  });

  it('只回了 Command（查不到日誌）：事件的 filePath 相符就提交，不符就丟', async () => {
    for (const [commandPath, expected] of [
      [FILE, '有事件'],
      [`${PREFIX}/other.md`, undefined],
      [null, undefined],
    ] as const) {
      const memory = new MemoryBackend();
      const log = new SessionLog('staging');
      const staging = createHistoryStaging(asBackend(memory), PREFIX);
      const wrapped = staging.wrap(
        summarizer(
          async ({ backend }) => {
            await (backend as unknown as MemoryBackend).write(FILE, '有事件');
            return eventCommand(commandPath);
          },
          staging,
          log,
        ),
        { forCall: () => ({ kind: 'not-attached' }) },
      );

      await run(wrapped);

      expect(memory.files.get(FILE)).toBe(expected);
    }
  });

  it('日誌事件指著別的路徑：這個路徑丟棄、指到的那個提交', async () => {
    const memory = new MemoryBackend();
    const log = new SessionLog('staging');
    const staging = createHistoryStaging(asBackend(memory), PREFIX);
    const other = `${PREFIX}/session_b.md`;
    const wrapped = staging.wrap(
      summarizer(
        async ({ backend }) => {
          const view = backend as unknown as MemoryBackend;
          await view.write(FILE, '沒生出摘要的那份');
          await view.write(other, '生出摘要的那份');
          record(log, other);
          return new AIMessage('ok');
        },
        staging,
        log,
      ),
      lookup(log),
    );

    await run(wrapped);

    expect([...memory.files]).toEqual([[other, '生出摘要的那份']]);
  });

  it('範圍開始之前日誌上就有的事件不算這一步的', async () => {
    const memory = new MemoryBackend();
    const log = new SessionLog('staging');
    record(log, FILE);
    const staging = createHistoryStaging(asBackend(memory), PREFIX);
    const wrapped = staging.wrap(
      summarizer(
        async ({ backend }) => {
          await (backend as unknown as MemoryBackend).write(FILE, '這一步沒生出摘要');
          return new AIMessage('ok');
        },
        staging,
        log,
      ),
      lookup(log),
    );

    await run(wrapped);

    expect(memory.files.size).toBe(0);
  });

  it('歷史前綴以外的路徑照舊直寫，不暫存', async () => {
    const memory = new MemoryBackend();
    const log = new SessionLog('staging');
    const staging = createHistoryStaging(asBackend(memory), PREFIX);
    const wrapped = staging.wrap(
      summarizer(
        async ({ backend }) => {
          await (backend as unknown as MemoryBackend).write('/notes/a.md', '別的檔');
          return new AIMessage('ok');
        },
        staging,
        log,
      ),
      lookup(log),
    );

    await run(wrapped);

    expect(memory.files.get('/notes/a.md')).toBe('別的檔');
  });

  it('另一份暫存的範圍裡，這一份不攔（各管各的 backend）', async () => {
    const memory = new MemoryBackend();
    const log = new SessionLog('staging');
    const mine = createHistoryStaging(asBackend(memory), PREFIX);
    const theirs = createHistoryStaging(asBackend(new MemoryBackend()), PREFIX);
    const wrapped = theirs.wrap(
      summarizer(
        async () => {
          await (mine.backend as unknown as MemoryBackend).write(FILE, '不是它的範圍');
          return new AIMessage('ok');
        },
        theirs,
        log,
      ),
      lookup(log),
    );

    await run(wrapped);

    expect(memory.files.get(FILE)).toBe('不是它的範圍');
  });

  it('寫回去失敗只講一條 warn、不拋（拋出與回 error 兩種都是）', async () => {
    for (const failure of [{ write: new Error('磁碟滿了') }, { resultError: 'permission' }]) {
      const memory = new MemoryBackend();
      Object.assign(memory.failWith, failure);
      const log = new SessionLog('staging');
      const reports: string[] = [];
      const staging = createHistoryStaging(asBackend(memory), PREFIX, (message) =>
        reports.push(message),
      );
      const wrapped = staging.wrap(
        summarizer(
          async ({ backend }) => {
            await (backend as unknown as MemoryBackend).write(FILE, '寫不進去');
            record(log, FILE);
            return new AIMessage('ok');
          },
          staging,
          log,
        ),
        lookup(log),
      );

      await expect(run(wrapped)).resolves.toBeDefined();

      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain(FILE);
    }
  });

  it('forCall 拋了：當查不到日誌，回 Command 的判準仍在', async () => {
    const memory = new MemoryBackend();
    const log = new SessionLog('staging');
    const staging = createHistoryStaging(asBackend(memory), PREFIX);
    const wrapped = staging.wrap(
      summarizer(
        async ({ backend }) => {
          await (backend as unknown as MemoryBackend).write(FILE, '有事件');
          return eventCommand(FILE);
        },
        staging,
        log,
      ),
      {
        forCall() {
          throw new Error('註冊表壞了');
        },
      },
    );

    await run(wrapped);

    expect(memory.files.get(FILE)).toBe('有事件');
  });
});
