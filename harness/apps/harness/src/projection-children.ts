/**
 * 子代理自己的日誌怎麼進插件投影（[#1028](https://github.com/DemianLi/nexus-agent/issues/1028)，通道見 #1026）。
 *
 * ## 形狀：一份日誌一份折疊，照 dsh
 *
 * dsh 的投影格子按 session 分（`session-projection/src/index.ts` 的 `registration.cells.get(session)`）：子會話與 root
 * 各折各的、互不相見。這裡一樣——宣告 `children: true` 的單元（`childProjectionUnits`）對每個子代理各開一份折疊，值帶
 * `session`（子代理的 `runId`）送出，落在 web 的 `subagentProjections[runId][key]`。單元的 `apply` 不必知道它在折誰，
 * 也就不存在「即時與歷史交錯順序不同」的問題：每份折疊只吃一份日誌，照 `seq` 排。
 *
 * ## 子日誌的集合只有一份：pump 的
 *
 * 即時折疊與歷史路由讀**同一個** {@link ThreadPump.projectionChildren}（活著的取記憶體裡的註冊表，上一個行程留下的取
 * 啟動時讀進來的 seed），結構上就一致，同 root 讀 `thread.pump.sessionLog.events`。歷史路由不另外讀檔。
 *
 * ## seed 從哪來
 *
 * 重啟之後 root 的 seed 在 `rootSeed` 裡，子代理的不在（註冊表只認 root 的 seed）。名單從 root 的 `subagent/catalog`
 * 來（#1023），每一顆指一份子會話，用唯讀冷讀（`readSubagentSession`，前景與背景都讀得到）讀回來。**只有註冊了需要子代理的單元
 * 才讀檔**。已知缺口：catalog 寫進去之前就死掉的子代理，名單裡沒有它，也就讀不到。
 *
 * @module
 */

import type { ProjectionUnit, SessionEvent } from '@nexus/core';
import { childProjectionUnits, createProjectionFold } from '@nexus/core';
import type { CustomFrameData } from '@nexus/wire';

import { projectionData } from './projection-wire.js';

/** 子代理的 `runId` → 它那份日誌的事件。 */
export type ProjectionChildren = ReadonlyMap<string, readonly SessionEvent[]>;

/**
 * root 日誌的 `subagent/catalog` 指到的子代理 `runId`，照出現順序、去重。
 * 子會話的 id 是 `<thread>/<runId>`（`SessionRegistry`）；前綴對不上的略過。
 */
export function catalogRunIds(threadId: string, rootEvents: readonly SessionEvent[]): string[] {
  const prefix = `${threadId}/`;
  const seen = new Set<string>();
  for (const event of rootEvents) {
    if (event.type !== 'subagent/catalog') continue;
    const { childId } = event.data;
    if (childId.startsWith(prefix) && childId.length > prefix.length) {
      seen.add(childId.slice(prefix.length));
    }
  }
  return [...seen];
}

/**
 * 把上一個行程留下的子代理日誌讀回來，給 pump 當 seed。
 *
 * 沒有單元要折子代理、沒有讀法（沒接落盤）、或沒有 catalog，一律不讀。讀不到（壞檔、版本太新）的那一份略過並講一聲：
 * 少一份只讓那個子代理從投影裡消失，不該讓整條 thread 起不來。
 *
 * @param threadId - root 會話 id。
 * @param rootSeed - root 日誌上一個行程留下的事件。
 * @param units - 這條 thread 的投影單元。
 * @param read - 唯讀冷讀一份子代理日誌（`WireHandlerOptions.readSubagentSession`）。
 * @param warn - 讀不出來時講話的地方。
 */
export async function readProjectionChildSeeds(
  threadId: string,
  rootSeed: readonly SessionEvent[] | undefined,
  units: readonly ProjectionUnit[],
  read:
    ((threadId: string, runId: string) => Promise<readonly SessionEvent[] | undefined>) | undefined,
  warn?: (message: string) => void,
): Promise<ProjectionChildren | undefined> {
  if (rootSeed === undefined || read === undefined) return undefined;
  if (childProjectionUnits(units).length === 0) return undefined;
  const seeds = new Map<string, readonly SessionEvent[]>();
  for (const runId of catalogRunIds(threadId, rootSeed)) {
    try {
      const events = await read(threadId, runId);
      if (events !== undefined) seeds.set(runId, events);
    } catch (error: unknown) {
      warn?.(
        `[投影] thread ${threadId} 的子代理 ${runId} 讀不出來，投影裡沒有它：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return seeds.size === 0 ? undefined : seeds;
}

/**
 * 歷史路由用：每個子代理 × 每個宣告了 `children` 的單元，各一顆 `projection` frame（帶 `session`）。
 * 沒有折到任何事件的也送（同 root 那邊：baseline 定了 web 有哪些 key）。折疊器與 pump 的即時折疊是同一個。
 *
 * @param units - 這條 thread 的全部投影單元（內部挑出要折子代理的那些）。
 * @param children - 子代理日誌的集合，見 {@link ThreadPump.projectionChildren}。
 */
export function childProjectionData(
  units: readonly ProjectionUnit[],
  children: ProjectionChildren,
): CustomFrameData[] {
  const selected = childProjectionUnits(units);
  if (selected.length === 0) return [];
  const fold = createProjectionFold(selected);
  const out: CustomFrameData[] = [];
  for (const [runId, events] of children) {
    for (const value of fold.fold(events)) out.push(projectionData(value, runId));
  }
  return out;
}
