import { FileText } from 'lucide-react';

import { useControl } from '@/shared/right-sidebar/context';
import { defineTab, isIndex } from '@/shared/right-sidebar/tab';
import type { TabBodyProps } from '@/shared/right-sidebar/tab';

import { basename } from './present-view';
import { DeliverablePreviewTab } from './preview';
import type { LocatedFile } from './view';

/** 交付分頁的座標：一個檔一個分頁，不同輪交付的同名檔是兩個分頁。 */
export type DeliverableSidebarTab = {
  readonly kind: 'deliverable';
  readonly file: LocatedFile;
};

export function deliverableTab(file: LocatedFile): DeliverableSidebarTab {
  return { kind: 'deliverable', file };
}

function DeliverableBody({ tab }: TabBodyProps<DeliverableSidebarTab>) {
  const { deliverableFiles, deliverableDownload } = useControl().sources;
  return deliverableFiles === undefined ? null : (
    <DeliverablePreviewTab
      file={tab.file}
      store={deliverableFiles}
      downloader={deliverableDownload}
    />
  );
}

export const DELIVERABLE_TAB = defineTab<DeliverableSidebarTab>({
  kind: 'deliverable',
  key: (tab) => `deliverable:${tab.file.seq}:${tab.file.index}`,
  parse: (raw) => {
    const file = raw.file as Record<string, unknown> | null;
    if (typeof file !== 'object' || file === null) return undefined;
    const { path, description, seq, index } = file;
    if (typeof path !== 'string' || !isIndex(seq) || !isIndex(index)) return undefined;
    if (description !== undefined && typeof description !== 'string') return undefined;
    return deliverableTab({
      path,
      seq,
      index,
      ...(description === undefined ? {} : { description }),
    });
  },
  useTitle: (tab) => ({ label: basename(tab.file.path), detail: tab.file.path }),
  Icon: FileText,
  Body: DeliverableBody,
});
