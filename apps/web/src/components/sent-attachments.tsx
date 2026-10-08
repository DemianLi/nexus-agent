/**
 * 已送出的那一句帶的附件（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：人的泡泡上方一排唯讀的標籤，圖示、名字、`副檔名 · 大小`。
 * 沒有移除鈕、不能點開：送出了就是這一句的一部分。**圖也是標籤**：讀圖路由還沒有，不畫縮圖也不畫壞圖（`lib/sent-attachments.ts`）。
 * 一排會折行、單張標籤截斷，所以 375 寬也不撐開頁面。
 */

import type { WireAttachmentRef } from '@nexus/wire';
import { FileText, Image as ImageIcon } from 'lucide-react';

import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment';
import { sentAttachmentViews } from '@/lib/sent-attachments';

export function SentAttachments({
  attachments,
}: {
  readonly attachments: readonly WireAttachmentRef[] | undefined;
}) {
  const views = sentAttachmentViews(attachments);
  if (views.length === 0) return null;
  return (
    <AttachmentGroup
      className="max-w-full flex-wrap justify-end"
      aria-label="這一句帶的附件"
      data-testid="sent-attachments"
    >
      {views.map((view) => (
        <Attachment
          key={view.key}
          size="sm"
          className="max-w-56 min-w-0"
          data-testid="sent-attachment"
          data-kind={view.kind}
        >
          <AttachmentMedia variant="icon">
            {view.kind === 'image' ? <ImageIcon aria-hidden /> : <FileText aria-hidden />}
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle title={view.name}>{view.name}</AttachmentTitle>
            <AttachmentDescription>{view.detail}</AttachmentDescription>
          </AttachmentContent>
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}
