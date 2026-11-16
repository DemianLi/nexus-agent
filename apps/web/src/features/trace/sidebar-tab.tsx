import { Activity } from 'lucide-react';

import { useControl } from '@/shared/right-sidebar/context';
import { defineSingletonTab } from '@/shared/right-sidebar/tab';

import { TraceBody } from './panel';

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
