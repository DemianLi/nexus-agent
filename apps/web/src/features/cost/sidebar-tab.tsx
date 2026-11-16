import { Coins } from 'lucide-react';

import { useControl } from '@/shared/right-sidebar/context';
import { defineSingletonTab } from '@/shared/right-sidebar/tab';

import { CostBody } from './panel';

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
