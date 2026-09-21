/**
 * 一個交付檔的預覽（[#452](https://github.com/DemianLi/nexus-agent/issues/452) web 第二刀）：拿卡片上那組
 * `(seq, index)` 座標去讀檔，一頁一頁看。
 *
 * 外殼跟隔壁的改動審查同一個（`Sheet`：桌面從右側滑出、手機全螢幕，#443 決議 3）。**內容只畫純文字**：
 * 路由回的 `text` 不帶行號（那是基座 `read` 的形狀，不是路由的），這裡也不加——加了就得自己算，而畫面上
 * 的行號跟檔案的行號分岔正是最難發現的那種錯。
 *
 * **讀不到的四種各自有話講**（見 {@link DeliverableFileState}）：座標不對是 bug、錨不住是正常的、太大是
 * 拒絕不是截斷、二進位要改走下載。**只有真的讀壞了才給重試**。
 *
 * **兩格有下載鈕**（第三刀補上）：`'binary'` 是它本來就該去的地方，`'too-large'` 則是因為**預覽的 413
 * 有兩個成因**——整檔超過 32 MiB，或這一頁超過 2 MiB。下載只吃前者，所以一個「行太長、單頁爆掉」的
 * 純文字檔預覽不了卻下載得下來；沒有這顆鈕的話，它在畫面上就完全拿不到了。
 *
 * **那顆鈕不保證成功**：整檔真的超過上限時它會再撞一次 413，而下載的 413 是終局。那句話由
 * {@link DownloadAction} 自己講（`複製路徑` 那種 toast），這裡不預測。
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { DownloadAction } from '@/components/deliverable-download-button';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { DeliverableDownloader } from '@/lib/deliverable-download';
import type {
  DeliverableFileFailure,
  DeliverableFileState,
  DeliverableFileStore,
} from '@/lib/deliverable-file';
import { isPage } from '@/lib/deliverable-file';
import type { LocatedFile } from '@/lib/deliverables-view';
import { basename } from '@/lib/present-view';

function Status({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <div
      className="text-muted-foreground flex items-center gap-3 px-4 py-4 text-sm"
      role={busy ? 'status' : undefined}
    >
      {children}
    </div>
  );
}

/**
 * 每一種結局講的話。分開寫是承重的：攤平成一句「讀不到」就分不出該不該重試、該不該改走下載。
 *
 * **窮盡列舉，沒有 fallthrough**：之後多一種失敗狀態時這裡是型別錯誤，而不是靜靜多一顆對著
 * 永遠不會成功的請求打的重試鈕。
 */
function Failure({
  state,
  file,
  downloader,
  onRetry,
}: {
  state: DeliverableFileFailure;
  file: LocatedFile;
  downloader: DeliverableDownloader | undefined;
  onRetry: () => void;
}) {
  const download =
    downloader === undefined ? null : <DownloadAction file={file} downloader={downloader} />;
  switch (state) {
    case 'missing':
      return <Status>這個檔已經讀不到了</Status>;
    case 'too-large':
      // 上限是拒絕不是截斷，所以不能講成「只顯示前面一段」——那會讓人以為看到的是全部。
      // 下載鈕在這裡是承重的：單頁超標的那一半下載得下來，見檔頭。
      return (
        <Status>
          檔案太大，沒辦法在這裡預覽
          {download}
        </Status>
      );
    case 'binary':
      return (
        <Status>
          二進位檔，沒辦法預覽
          {download}
        </Status>
      );
    case 'invalid':
      // 座標是程式給的，不是人打的——會走到這裡就是我們算錯了，所以講法跟其他三種不同。
      return <Status>讀不到這個檔：座標不對</Status>;
    case 'error':
      return (
        <Status>
          沒辦法讀取這個檔
          <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
            重試
          </Button>
        </Status>
      );
  }
}

/** 一頁的內容，或替代它的狀態。 */
function PageBody({
  file,
  offset,
  store,
  downloader,
  onMore,
}: {
  file: LocatedFile;
  offset: number;
  store: DeliverableFileStore;
  downloader: DeliverableDownloader | undefined;
  onMore: (next: number) => void;
}) {
  const { seq, index } = file;
  const state: DeliverableFileState | undefined = useSyncExternalStore(store.subscribe, () =>
    store.read(seq, index, offset),
  );
  // 只補還沒讀過的；讀壞的等使用者按重試（同隔壁）。
  useEffect(() => {
    if (store.read(seq, index, offset) === undefined) store.load(seq, index, offset);
  }, [store, seq, index, offset]);

  if (state === undefined || state === 'loading') return <Status busy>正在讀取檔案…</Status>;
  if (!isPage(state))
    return (
      <Failure
        state={state}
        file={file}
        downloader={downloader}
        onRetry={() => store.load(seq, index, offset)}
      />
    );

  return (
    <>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed">
        {state.text}
      </pre>
      {!state.eof && (
        <div className="px-4 pb-4">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            // **往下一頁是 `offset + lines`**，不是 `offset + 某個我們記著的每頁行數`：每頁幾行由
            // 路由決定（我們刻意不送 `limit`），只有回應講得出這一頁實際拿了幾行。
            onClick={() => onMore(state.offset + state.lines)}
          >
            讀下一段
          </Button>
        </div>
      )}
    </>
  );
}

export function DeliverablePreview({
  file,
  store,
  downloader,
  open,
  onOpenChange,
}: {
  file: LocatedFile | undefined;
  store: DeliverableFileStore;
  /** 沒給就不畫下載鈕——讀不到的那幾格仍然講得出發生了什麼事。 */
  downloader?: DeliverableDownloader;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [offset, setOffset] = useState(0);
  // 換一個檔就從頭讀起。`(seq, index)` 是座標，不是列表位置——同一輪宣告兩次同一個路徑也分得開。
  useEffect(() => {
    setOffset(0);
  }, [file?.seq, file?.index]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="truncate">
            {file === undefined ? '預覽' : basename(file.path)}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {file?.path ?? ''}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {file !== undefined && (
            <PageBody
              file={file}
              offset={offset}
              store={store}
              downloader={downloader}
              onMore={setOffset}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
