// 這個切片要右側欄帶給它的資料來源，在這裡補進 `RightSidebarSources`（`app/App.tsx` 組出來）。

import { Activity } from 'lucide-react';

import { useControl } from '@/shared/right-sidebar/context';
import { defineSingletonTab } from '@/shared/right-sidebar/tab';

import { TraceBody } from './panel';
import type { TrajectoryPuller } from './trajectory-pull';

/** 觀測分頁：逐輪的模型呼叫與工具（#1033）。「看這一輪」的請求只有它收（#1034）。 */
export const TRACE_TAB = defineSingletonTab({
  kind: 'trace',
  title: '觀測',
  Icon: Activity,
  Body: function TraceTabBody({ visible }) {
    const { api, sources, reveal, settleReveal } = useControl();
    return (
      <TraceBody
        visible={visible}
        sources={sources}
        locate={api.locate}
        reveal={reveal}
        onRevealed={settleReveal}
      />
    );
  },
});

declare module '@/shared/right-sidebar/api' {
  interface RightSidebarSources {
    /**
     * 軌跡細節的按需拉取（#1083，觀測分頁）：快取與進行中的請求放在這裡，**身分要穩定**（`App` 以 `[client, threadId]` 建）——
     * 分頁切走再回來、面板重掛，已經拉到的不必再拉。沒給就只有推送的那幾輪細節、更早的輪只有摘要。
     */
    readonly trajectoryPull?: TrajectoryPuller | undefined;
  }
}
