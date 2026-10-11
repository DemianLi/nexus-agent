/**
 * 摘要歷史檔的寫入先暫存，這一步結束才決定寫不寫
 * （[#1389](https://github.com/DemianLi/nexus-agent/issues/1389)）。
 *
 * ## 缺的是什麼
 *
 * 基座的 `summarizeMessages` **先**把被換掉的原文寫進歷史檔（`offloadToBackend`），**才**生摘要、才送請求
 * （`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:3113-3114`）。那個寫入走 `__pregel_send` 進這個節點的寫入，
 * 之後不管這一步怎麼收，它都跟著這個 task 走。實測（#1389 盤點，`91c87252` 上重量）有兩條路留下殘餘：
 *
 * | 路徑 | 殘餘 |
 * | --- | --- |
 * | S1／S6：同一次呼叫內端點回超窗，分派器換 retain 0 重摘，**同一個檔又 append 一段** | 第 2 段把第 1 段又抄一遍；連續兩次超窗是三段巢狀 |
 * | S2：生摘要的那次模型呼叫自己失敗（基座吞掉、照原請求送出） | 檔寫了、沒有事件；下一輪摘要又 append 一段，原文兩份 |
 *
 * 摘要後**主請求**才失敗（S3、S4、S10）不在這裡：#1390 之後，那筆事件在下一步請求前補回 state，下一輪接著它的切點摘要，
 * 歷史檔的各段互不重複（#1389 在 `91c87252` 上重量，S3／S4／S10 都是互不重複的區段）。**那種情況檔案要留**——
 * 日誌上的事件與補上去的 state 事件指著它。
 *
 * ## 做法
 *
 * 摘要器的 `backend` 換成一層暫存（{@link createHistoryStaging}），摘要器外面包一層（{@link HistoryStaging.wrap}）
 * 替每一次 `wrapModelCall` 開一個範圍（`AsyncLocalStorage`）：
 *
 * - 範圍內對歷史前綴的 `write`／`edit`／`uploadFiles` **只記不寫**，同一個路徑最後一次勝出；`downloadFiles` 讀的是
 *   已提交的內容。所以第二次嘗試是「已提交的 ＋ 自己這一段」，不是「已提交的 ＋ 第一次那段 ＋ 自己這一段」（S1／S6）。
 * - 範圍結束（回傳或拋出都一樣）時，**這一步真的生出過摘要的路徑**才寫進去。判準是這一步的日誌上有一筆
 *   `compaction/summary` 指著它，或回傳的 `Command` 帶著 `filePath` 相同的 `_summarizationEvent`。
 *   生摘要失敗的那一步兩者都沒有，暫存丟掉（S2）。
 * - 寫回去用的是範圍結束那一刻、仍在這個節點的執行環境裡的真 backend 呼叫，所以與以前一樣是這個 task 的寫入，
 *   進同一次 checkpoint；寫入的內容就是基座原本要寫的那一份。
 *
 * ## 偏離登記（AGENTS.md「偏離規則」）
 *
 * dsh 的壓縮不寫任何檔案（原文留在會話日誌，`compaction-basic/README.zh.md`），壓縮是一筆交易，沒有「寫了一半」。
 * 我們的歷史檔是基座無條件建、關不掉的（`agent-factory.ts` 的 `withConversationHistory` 已登記一次），寫入點在
 * 基座裡、先於生摘要。**退到最接近的：在 backend 接縫上做交易化**——寫入先暫存，提交與否跟著「這一步有沒有生出
 * 摘要」走。照 #1390 的處理，我們對基座的節點本身一個字不動。
 *
 * **殘餘**：暫存只管摘要器自己的 backend 實例；`createFilesystemMiddleware` 搬超大使用者訊息的寫入
 * （`/conversation_history/<uuid>`，另一條路、另一個檔名）不經過這一層，也不受影響。沒有會話註冊表的組裝
 * （`eval/runner.ts`、多數測試）無從查日誌，維持直接寫。
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { isCommand } from '@langchain/langgraph';
import type { AnyBackendProtocol } from 'deepagents';
import type { AgentMiddleware } from './base-types.js';
import type { SessionLookup } from './registry.js';

/** 這一步暫存的寫入：路徑 → 提交時要做的那一個呼叫（同一路徑最後一次勝出）。 */
interface Scope {
  readonly owner: object;
  readonly pending: Map<string, () => unknown>;
}

const scopes = new AsyncLocalStorage<Scope>();

export interface HistoryStaging {
  /** 換給摘要器當 `backend` 的那一份：範圍內對歷史前綴的寫入只記不寫，其餘照舊。 */
  readonly backend: AnyBackendProtocol;
  /**
   * 包在摘要器外面：為每次 `wrapModelCall` 開一個暫存範圍，結束時依判準寫入或丟棄。
   *
   * **不准拋**：寫回去失敗只講一條 warn（歷史檔寫不進去不能扳倒模型呼叫，同基座對 offload 失敗的處理）。
   */
  wrap(
    base: AgentMiddleware,
    sessions: { forCall(config: unknown): SessionLookup },
  ): AgentMiddleware;
}

/**
 * @param backend - 摘要器原本要寫的 backend。
 * @param historyPathPrefix - 摘要器的歷史前綴（`settings.historyPathPrefix`，不寫死）；只暫存落在它底下的路徑。
 * @param report - 寫回去失敗時往哪裡講；省略即 `console.warn`。
 */
export function createHistoryStaging(
  backend: AnyBackendProtocol,
  historyPathPrefix: string,
  report: (message: string) => void = (message) => console.warn(message),
): HistoryStaging {
  const owner = {};
  const directory = historyPathPrefix.endsWith('/') ? historyPathPrefix : `${historyPathPrefix}/`;
  const staged = (path: string): Scope | undefined => {
    const scope = scopes.getStore();
    return scope !== undefined && scope.owner === owner && path.startsWith(directory)
      ? scope
      : undefined;
  };
  const real = backend as unknown as Record<string, (...args: unknown[]) => unknown>;

  const intercepted: Record<string, (...args: unknown[]) => unknown> = {
    write: (path, content) => {
      const scope = staged(path as string);
      if (scope === undefined) return real.write!(path, content);
      scope.pending.set(path as string, () => real.write!(path, content));
      return { path };
    },
    edit: (path, oldString, newString, replaceAll) => {
      const scope = staged(path as string);
      if (scope === undefined) return real.edit!(path, oldString, newString, replaceAll);
      scope.pending.set(path as string, () => real.edit!(path, oldString, newString, replaceAll));
      return { path, occurrences: 1 };
    },
    uploadFiles: async (files) => {
      const entries = files as readonly (readonly [string, Uint8Array])[];
      if (!entries.some(([path]) => staged(path) !== undefined)) return real.uploadFiles!(files);
      const responses: unknown[] = [];
      for (const [path, content] of entries) {
        const scope = staged(path);
        if (scope === undefined) {
          const [response] = (await real.uploadFiles!([[path, content]])) as unknown[];
          responses.push(response);
          continue;
        }
        scope.pending.set(path, () => real.uploadFiles!([[path, content]]));
        responses.push({ path, error: null });
      }
      return responses;
    },
  };

  const proxied = new Proxy(backend as object, {
    get(target, property) {
      if (typeof property === 'string' && Object.hasOwn(intercepted, property)) {
        // 底下沒有這個方法就不宣稱有：基座靠 `if (backend.uploadFiles)` 選路。
        if (typeof Reflect.get(target, property, target) !== 'function') return undefined;
        return intercepted[property];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as AnyBackendProtocol;

  return {
    backend: proxied,
    wrap(base, sessions) {
      const inner = base.wrapModelCall?.bind(base);
      /* v8 ignore next -- 摘要器一定有 wrapModelCall；沒有的話包了也沒意義，原樣回去。 */
      if (inner === undefined) return base;
      return {
        ...base,
        wrapModelCall: async (request, handler) => {
          const scope: Scope = { owner, pending: new Map() };
          let log:
            | { readonly events: readonly { readonly type: string; readonly data?: unknown }[] }
            | undefined;
          let start = 0;
          try {
            const found = sessions.forCall({
              configurable: (request as { runtime?: { configurable?: unknown } }).runtime
                ?.configurable,
            });
            if (found.kind === 'ok') {
              log = found.log;
              start = found.log.events.length;
            }
          } catch {
            // 找不到這次呼叫的日誌（註冊表異常）：只剩 `Command` 這一條判準，寫入照樣能提交。
            log = undefined;
          }
          let outcome: unknown;
          try {
            outcome = await scopes.run(scope, () => inner(request, handler));
            return outcome as ReturnType<typeof inner>;
          } finally {
            await commit(scope, log, start, outcome, report);
          }
        },
      } as AgentMiddleware;
    },
  };
}

/** 這一步生出過摘要的路徑：日誌上這一步新增的 `compaction/summary`，加上回傳 `Command` 帶的那一筆。 */
function summarizedPaths(
  log:
    { readonly events: readonly { readonly type: string; readonly data?: unknown }[] } | undefined,
  start: number,
  outcome: unknown,
): Set<string> {
  const paths = new Set<string>();
  for (const event of log?.events.slice(start) ?? []) {
    if (event.type !== 'compaction/summary') continue;
    const filePath = (event.data as { filePath?: unknown } | undefined)?.filePath;
    if (typeof filePath === 'string') paths.add(filePath);
  }
  if (isCommand(outcome)) {
    const update = outcome.update as { _summarizationEvent?: { filePath?: unknown } } | undefined;
    const filePath = update?._summarizationEvent?.filePath;
    if (typeof filePath === 'string') paths.add(filePath);
  }
  return paths;
}

async function commit(
  scope: Scope,
  log:
    { readonly events: readonly { readonly type: string; readonly data?: unknown }[] } | undefined,
  start: number,
  outcome: unknown,
  report: (message: string) => void,
): Promise<void> {
  if (scope.pending.size === 0) return;
  const keep = summarizedPaths(log, start, outcome);
  for (const [path, write] of scope.pending) {
    if (!keep.has(path)) continue;
    try {
      const result = (await write()) as
        { error?: unknown } | readonly { error?: unknown }[] | undefined;
      const failed = Array.isArray(result)
        ? result.find((each) => each?.error)
        : (result as { error?: unknown } | undefined);
      if (failed?.error) report(`摘要歷史檔寫入失敗（${path}）：${String(failed.error)}`);
    } catch (error) {
      report(
        `摘要歷史檔寫入失敗（${path}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
