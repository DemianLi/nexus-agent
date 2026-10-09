/**
 * 已送出的那一句帶的附件（[#732](https://github.com/DemianLi/nexus-agent/issues/732)、[#733](https://github.com/DemianLi/nexus-agent/issues/733)）：
 * 人的泡泡上方一排唯讀的標籤，圖示、名字、`副檔名 · 大小`。沒有移除鈕：送出了就是這一句的一部分。
 *
 * **圖盡量畫縮圖**：有 {@link AttachmentImageContext}（`App` 在一條 thread 上提供）時，圖的標籤進到畫面才去讀（`client.readAttachment`），
 * 讀回來換成縮圖，點縮圖開原圖；**讀不到（沒有提供者、沒有附件儲存、日誌沒引用、網路壞了）就留著標籤**，不畫壞圖。
 * 檔案沒有縮圖，一律是標籤（讀圖路由只給圖）。
 * 一排會折行、單張標籤截斷，所以 375 寬也不撐開頁面。
 *
 * **模型已看不到的那幾件**（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)）：縮圖照畫、照樣點得開原圖，角落疊一個
 * 中性的小圖示，標籤底下多一行「模型已看不到」。那一行點開是 popover 說明為什麼（同 `context-meter`：手機上沒有 hover）。
 * 不用警示色：圖沒壞，只是模型那邊換成了佔位字。即時發生時不另外跳通知，標記出現就夠了。
 */

import type { WireAttachmentRef } from '@nexus/wire';
import { EyeOff, FileText, Image as ImageIcon } from 'lucide-react';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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

/** 標籤底下那一行：點開說明這一件為什麼模型看不到。 */
export const OMITTED_LABEL = '模型已看不到';
export const OMITTED_EXPLANATION =
  '為了不超過這個模型的圖片上限，這張較舊的圖已從模型的上下文移除；圖本身還在。';

function OmittedNote({ name }: { readonly name: string }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${OMITTED_LABEL}：${name}，點開看原因`}
        data-testid="sent-attachment-omitted"
        className="text-muted-foreground hover:text-foreground mt-0.5 flex min-h-6 max-w-full items-center gap-1 text-tip transition-colors duration-(--duration-quick)"
      >
        <EyeOff aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{OMITTED_LABEL}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="text-body w-64">
        {OMITTED_EXPLANATION}
      </PopoverContent>
    </Popover>
  );
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
        data-omitted={view.omitted}
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
          {view.omitted && (
            <span
              aria-hidden
              className="bg-background/80 text-muted-foreground pointer-events-none absolute right-0.5 bottom-0.5 flex size-3.5 items-center justify-center rounded-full"
            >
              <EyeOff className="size-2.5" />
            </span>
          )}
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle title={view.name}>{view.name}</AttachmentTitle>
          <AttachmentDescription>{view.detail}</AttachmentDescription>
          {view.omitted && <OmittedNote name={view.name} />}
        </AttachmentContent>
      </Attachment>
    </div>
  );
}

export function SentAttachments({
  attachments,
  omitted,
}: {
  readonly attachments: readonly WireAttachmentRef[] | undefined;
  /** `HumanEntry.omittedAttachments`（#1270）。排著、還沒被領走的那幾句還沒進過模型，不會有。 */
  readonly omitted?: readonly number[];
}) {
  const views = sentAttachmentViews(attachments, omitted);
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
