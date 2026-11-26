// 這個切片要右側欄帶給它的資料來源，在這裡補進 `RightSidebarSources`（`app/App.tsx` 組出來）。

import { Coins } from 'lucide-react';

import { useControl } from '@/shared/right-sidebar/context';
import { defineSingletonTab } from '@/shared/right-sidebar/tab';

import { CostBody } from './panel';
import type { SubagentUsageLoader } from './subagent-usage';

/** 成本分頁：用量與子代理分列（#1032）。 */
export const COST_TAB = defineSingletonTab({
  kind: 'cost',
  title: '成本',
  Icon: Coins,
  Body: function CostTabBody({ visible }) {
    const { api, sources } = useControl();
    return <CostBody visible={visible} sources={sources} locate={api.locate} />;
  },
});

declare module '@/shared/right-sidebar/api' {
  interface RightSidebarSources {
    /**
     * 讀一個背景子代理自己的總帳（#1032，成本分頁的子代理分列）。**身分要穩定**（`App` 以 `[client, threadId]` 建），理由同
     * {@link RightSidebarSources.conversation}。沒給就不畫子代理那一段。
     */
    readonly subagentUsage?: SubagentUsageLoader | undefined;
  }
}
