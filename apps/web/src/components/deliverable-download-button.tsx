/**
 * 下載一個交付檔的鈕（[#452](https://github.com/DemianLi/nexus-agent/issues/452) web 第三刀）。
 *
 * **兩種長相，一份行為**：卡片那一列是跟預覽並排的圖示鈕，預覽面裡讀不到的那幾格是一顆有字的鈕
 * ——那裡下載是唯一的出路，圖示講不清楚。
 *
 * **飛行中要擋住第二次按。** 這條路一次搬整份檔（上限 `maxFileBytes`，預設 32 MiB），雙擊就是兩份。手動點不太出得來，
 * 所以它有自己的測試。
 *
 * **失敗走 toast**：卡片那一列沒有地方畫狀態（同 `CopyPathButton` 的處置）。四種結局各講各的，
 * 理由同 {@link DeliverableDownloadFailure} 的檔頭——尤其 `'too-large'` 是**終局**，
 * 跟預覽那個「太大不能預覽、但下載得下來」的 413 不是同一件事。
 */

import { Download } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import type { DeliverableDownloadFailure, DeliverableDownloader } from '@/lib/deliverable-download';
import type { LocatedFile } from '@/lib/deliverables-view';

/**
 * 每一種失敗講的那句話。
 *
 * **窮盡列舉，沒有 fallthrough**：多一種結局時這裡是型別錯誤，而不是靜靜退回一句通用的「失敗了」。
 */
function complaint(failure: DeliverableDownloadFailure): { title: string; description: string } {
  switch (failure) {
    case 'invalid':
      // 座標是程式給的，不是人打的——會走到這裡就是我們算錯了。
      return { title: '下載不了這個檔', description: '座標不對，這是程式的問題，不是這個檔的。' };
    case 'missing':
      return { title: '這個檔已經讀不到了', description: '它可能在這一輪之後被移走或刪掉了。' };
    case 'too-large':
      // **終局**：下載的 413 只有一個成因（整檔超過上限），沒有下一步可以建議。
      return { title: '檔案太大，連下載都超過上限', description: '請直接到工作區取這個檔。' };
    case 'error':
      return { title: '沒辦法下載這個檔', description: '再按一次試試。' };
  }
}

/**
 * 兩種長相共用的那一份：飛行狀態、呼叫、失敗的話講哪一句。
 *
 * **守衛讀的是 ref，不是那個 state。** `pending` 是 render 當下的值：同一拍內連按兩次時，兩次
 * 讀到的都還是 `false`，而 `disabled` 也還沒畫上去。**量過——那時真的會發出兩份整檔。**
 * ref 是唯一在同一拍內看得到自己剛寫進去的東西。`pending` 仍然留著，它的工作是畫面
 * （`disabled` 與那行字），不是防重入。
 */
function useDownload(file: LocatedFile, downloader: DeliverableDownloader) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await downloader.download(file);
      if (result !== 'ok') {
        const { title, description } = complaint(result);
        toast.error(title, { description });
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { pending, run: () => void run() };
}

/** 卡片那一列上的圖示鈕。 */
export function DownloadIconButton({
  file,
  downloader,
}: {
  file: LocatedFile;
  downloader: DeliverableDownloader;
}) {
  const { pending, run } = useDownload(file, downloader);
  const label = `下載：${file.path}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0"
      title={label}
      aria-label={label}
      disabled={pending}
      onClick={run}
    >
      <Download />
    </Button>
  );
}

/** 預覽面裡的那一顆：讀不到的時候，下載是唯一的出路。 */
export function DownloadAction({
  file,
  downloader,
}: {
  file: LocatedFile;
  downloader: DeliverableDownloader;
}) {
  const { pending, run } = useDownload(file, downloader);
  return (
    <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={run}>
      <Download />
      {pending ? '下載中…' : '下載這個檔'}
    </Button>
  );
}
