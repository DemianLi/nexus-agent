/**
 * 已送出的那一句帶的附件（[#732](https://github.com/DemianLi/nexus-agent/issues/732)、[#733](https://github.com/DemianLi/nexus-agent/issues/733)）：
 * 人的泡泡上方一排唯讀的標籤，圖示、名字、`副檔名 · 大小`。沒有移除鈕：送出了就是這一句的一部分。
 *
 * **圖盡量畫縮圖**：有 {@link AttachmentImageContext}（`App` 在一條 thread 上提供）時，圖的標籤進到畫面才去讀（`client.readAttachment`），
 * 讀回來換成縮圖，點縮圖開原圖；**讀不到（沒有提供者、沒有附件儲存、日誌沒引用、網路壞了）就留著標籤**，不畫壞圖。
 * 檔案沒有縮圖，一律是標籤（讀圖路由只給圖）。
 * 一排會折行、單張標籤截斷，所以 375 寬也不撐開頁面。
 */

import type { WireAttachmentRef } from '@nexus/wire';
import { FileText, Image as ImageIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';

import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { AttachmentImageSource } from '@/lib/attachment-image';
import { sentAttachmentViews } from '@/lib/sent-attachments';
import type { SentAttachmentView } from '@/lib/sent-attachments';

/** 沒有提供者（單獨畫 Transcript 的測試、背景子代理的對話）就一律只畫標籤。 */
export const AttachmentImageContext = createContext<AttachmentImageSource | null>(null);

/** 進到畫面才回 `true`；沒有 `IntersectionObserver`（測試環境）當成一直看得到。 */
function useVisible(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const node = ref.current;
    if (visible || node === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return [ref, visible];
}

function useThumbnail(
  source: AttachmentImageSource | null,
  ref: WireAttachmentRef,
  wanted: boolean,
): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (source === null || !wanted || ref.type !== 'image') return;
    let alive = true;
    void source.read(ref.attachmentId, ref.mediaType).then((value) => {
      if (alive) setUrl(value);
    });
    return () => {
      alive = false;
    };
  }, [source, wanted, ref]);
  return url;
}

function Chip({
  view,
  attachment,
  onOpen,
}: {
  readonly view: SentAttachmentView;
  readonly attachment: WireAttachmentRef | undefined;
  readonly onOpen: (name: string, url: string) => void;
}) {
  const source = useContext(AttachmentImageContext);
  const [rootRef, visible] = useVisible();
  const url = useThumbnail(
    source,
    attachment ?? { type: 'file', attachmentId: '', name: '', bytes: 0 },
    visible,
  );
  return (
    <div ref={rootRef} className="max-w-56 min-w-0">
      <Attachment
        size="sm"
        className="max-w-56 min-w-0"
        data-testid="sent-attachment"
        data-kind={view.kind}
        data-thumbnail={url === undefined ? 'none' : 'shown'}
      >
        <AttachmentMedia variant={url === undefined ? 'icon' : 'image'}>
          {url !== undefined ? (
            <button
              type="button"
              aria-label={`看原圖：${view.name}`}
              className="size-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => onOpen(view.name, url)}
            >
              <img src={url} alt="" className="size-full object-cover" />
            </button>
          ) : view.kind === 'image' ? (
            <ImageIcon aria-hidden />
          ) : (
            <FileText aria-hidden />
          )}
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle title={view.name}>{view.name}</AttachmentTitle>
          <AttachmentDescription>{view.detail}</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
    </div>
  );
}

export function SentAttachments({
  attachments,
}: {
  readonly attachments: readonly WireAttachmentRef[] | undefined;
}) {
  const views = sentAttachmentViews(attachments);
  const [opened, setOpened] = useState<{ readonly name: string; readonly url: string } | null>(
    null,
  );
  if (views.length === 0) return null;
  return (
    <>
      <AttachmentGroup
        className="max-w-full flex-wrap justify-end"
        aria-label="這一句帶的附件"
        data-testid="sent-attachments"
      >
        {views.map((view, index) => (
          <Chip
            key={view.key}
            view={view}
            attachment={attachments?.[index]}
            onOpen={(name, url) => setOpened({ name, url })}
          />
        ))}
      </AttachmentGroup>
      <Dialog open={opened !== null} onOpenChange={(open) => !open && setOpened(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogTitle className="truncate">{opened?.name}</DialogTitle>
          <DialogDescription className="sr-only">原圖預覽</DialogDescription>
          {opened !== null && (
            <img
              src={opened.url}
              alt={opened.name}
              className="max-h-[70dvh] w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
