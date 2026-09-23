/**
 * 交付檔的下載（[#452](https://github.com/DemianLi/nexus-agent/issues/452) web 第三刀）。
 *
 * ## 為什麼不是 `<a download>`
 *
 * 下載那條路由跟這條線上每一條 `GET` 一樣要帶 `content-type: application/json`——那個 header 是閘門，
 * 擋的是不發 preflight 的跨來源 simple request（見 `@nexus/wire` 的 `deliverableDownloadPath`，
 * 理由與後果逐字寫在那裡）。**連結設不了 header**，所以這裡 `fetch` 成 blob 再存。
 *
 * 拿掉那道閘門就能用 `<a download>`，而那等於把閘門本身挖掉——這是契約的一部分，不是實作偏好。
 *
 * ## 為什麼不進 store
 *
 * 下載是一次性的副作用，不是一份可以讀第二次的狀態。放進 {@link DeliverableFileStore} 那種快取的話，
 * 一個 32 MiB 的檔會在頁面活著的期間一直佔著記憶體，而且沒有人會再讀它。
 *
 * ## 失敗只有四種，不是五種
 *
 * | 碼 | 狀態 | 可重試 |
 * | --- | --- | --- |
 * | 400 | `'invalid'` —— 座標不對，**這是 bug 不是使用者狀態** | 否 |
 * | 404 | `'missing'` —— 錨不住、檔不在、不是一般檔 | 否 |
 * | 413 | `'too-large'` —— 整檔超過 `maxFileBytes`。**下載的 413 是終局** | 否 |
 * | 其他／斷線 | `'error'` | 是 |
 *
 * **沒有 `'not-text'`。** 422 只住在預覽那條路裡（`readDeliverablePage` 掃 NUL、要求 UTF-8），
 * 下載那條根本不看內容——不是文字的檔正是它存在的理由。把預覽的五態原封不動抄過來的話，會多一個
 * 永遠不會發生的分支，而那讀起來像「下載也可能被內容擋住」。
 *
 * **下載的 413 跟預覽的 413 不是同一件事**，這是這一刀唯一會讓人搞錯的地方：
 * 預覽的 413 只講「這一頁超過頁的位元組上限」（預設 2 MiB；[#552](https://github.com/DemianLi/nexus-agent/issues/552)
 * 之後預覽串流分頁，整檔沒有上限），下載的 413 講的是整檔超過 `maxFileBytes`（預設 32 MiB）。所以一個「太大
 * 不能預覽」的檔多半下載得下來，而真的撞上下載 413 時就沒有下一步了。
 *
 * @module
 */

import { deliverableDownloadPath } from '@nexus/wire';

import type { LocatedFile } from '@/lib/deliverables-view';
import { basename } from '@/lib/present-view';

/** 下載不成的幾種結局；只有 `'error'` 值得再按一次。 */
export type DeliverableDownloadFailure = 'invalid' | 'missing' | 'too-large' | 'error';

/** 下載的結果。`'ok'` ＝位元組已經交給瀏覽器了。 */
export type DeliverableDownloadResult = 'ok' | DeliverableDownloadFailure;

export interface DeliverableDownloader {
  /** 下載一個宣告過的交付檔。同一顆鈕在飛行中不要按第二次——那是兩份整檔。 */
  download(file: LocatedFile): Promise<DeliverableDownloadResult>;
}

/**
 * 狀態碼 → 結局。
 *
 * **422 落在 `'error'` 是對的，不是漏掉。** 下載那條路由不會回它；真的收到就代表我們對協定的理解
 * 錯了，而那一類該當成「再試一次看看」，不該當成一句講得斬釘截鐵的終局。
 */
function failureOf(status: number): DeliverableDownloadFailure {
  if (status === 400) return 'invalid';
  if (status === 404) return 'missing';
  if (status === 413) return 'too-large';
  return 'error';
}

/**
 * 把位元組交給瀏覽器存檔。
 *
 * `download=` 會蓋掉回應的 `content-disposition`（同來源的 blob URL），所以檔名取宣告路徑的最後一段，
 * 不解析那個 header——RFC 5987 的兩種寫法用正則拆是典型的貪婪陷阱，而我們手上本來就有路徑。
 * **代價講明**：server 的 `attachmentHeader` 在這條路上因此沒有消費者，它仍然承重（直接打那條 URL 的
 * 人看得到），但別指望改它會改變這裡的行為。
 */
function saveBytes(bytes: BlobPart, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // **延一拍才收回。** 規範上 revoke 不會中斷已經開始的下載，但同步收回在幾家瀏覽器上出過事，
  // 而我們只有 jsdom、驗不到真瀏覽器——分不出來的時候取保守的那一側。不收回則是整份檔留在記憶體裡。
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function createDeliverableDownloader({
  threadId,
  baseUrl,
  fetch: doFetch = globalThis.fetch.bind(globalThis),
}: {
  readonly threadId: string;
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}): DeliverableDownloader {
  const base = baseUrl.replace(/\/+$/, '');

  return {
    async download(file) {
      const { seq, index } = file;
      let response: Response;
      try {
        response = await doFetch(
          `${base}${deliverableDownloadPath(threadId)}?seq=${seq}&index=${index}`,
          // content-type 是那條線上每一條 GET 的閘門，不是禮貌。見檔頭。
          { method: 'GET', headers: { 'content-type': 'application/json' } },
        );
      } catch {
        return 'error';
      }
      if (!response.ok) return failureOf(response.status);
      let bytes: ArrayBuffer;
      try {
        // **`arrayBuffer()`，不是 `text()`。** 中間只要出現一次文字解碼，二進位就壞了，而且全程
        // 沒有徵兆——`readRaw` 那支基座工具正是這樣壞的（6 位元組進、10 出，`error` 仍是
        // `undefined`）。這條路從路由到磁碟不碰任何解碼器。
        bytes = await response.arrayBuffer();
      } catch {
        return 'error';
      }
      saveBytes(bytes, basename(file.path) || 'deliverable');
      return 'ok';
    },
  };
}
