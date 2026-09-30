/**
 * 交付檔的下載（[#452](https://github.com/DemianLi/nexus-agent/issues/452) web 第三刀；[#747](https://github.com/DemianLi/nexus-agent/issues/747)
 * 起改走命令通道）。
 *
 * 讀的是 `deliverable.readBytes`，**不帶 `offset`／`length` 就是整檔**（吃 `maxFileBytes`）；位元組是多段表單裡的原生位元組
 * （`@nexus/wire` 的 `createDeliverableClient` 已經解好），不是 base64。
 *
 * ## 為什麼不是 `<a download>`
 *
 * 命令是帶 JSON body 的 `POST`，而且要帶 `content-type: application/json`——那個 header 是閘門，擋的是不發 preflight 的
 * 跨來源 simple request（見 `@nexus/wire` 的 `THREADS_PATH`）。**連結送不出 body 也設不了 header**，所以這裡 `fetch`
 * 之後拿位元組做成 blob 再存。
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
 * | 來源 | 狀態 | 可重試 |
 * | --- | --- | --- |
 * | 協定錯誤 `invalid_argument`（參數不合格），見 {@link failureOfRejected} | `'invalid'` —— **這是 bug 不是使用者狀態** | 否 |
 * | `deliverable/no-anchor`、`not-found`、`not-regular-file` | `'missing'` —— 錨不住、檔不在、不是一般檔 | 否 |
 * | `deliverable/too-large` | `'too-large'` —— 整檔超過 `maxFileBytes`。**下載的太大是終局** | 否 |
 * | 斷線、形狀不對、被載體層擋下（5xx、401）、別的協定碼 | `'error'` | 是 |
 *
 * **沒有 `'not-text'`。** `deliverable/not-text` 只會從 `deliverable.read` 來（它掃 NUL、要求 UTF-8），
 * `readBytes` 根本不看內容——不是文字的檔正是下載存在的理由。真收到就代表我們對協定的理解錯了，落在 `'error'`
 * （「再試一次看看」），不是一句講得斬釘截鐵的終局。
 *
 * **下載的 too-large 跟預覽的 too-large 不是同一件事**，這是這一刀唯一會讓人搞錯的地方：
 * 預覽的只講「這一頁超過頁的位元組上限」（預設 2 MiB；[#552](https://github.com/DemianLi/nexus-agent/issues/552)
 * 之後預覽串流分頁，整檔沒有上限），下載的講的是整檔超過 `maxFileBytes`（預設 32 MiB）。所以一個「太大
 * 不能預覽」的檔多半下載得下來，而真的撞上下載的 too-large 時就沒有下一步了。
 *
 * @module
 */

import type { DeliverableReadError } from '@nexus/wire';
import { createDeliverableClient } from '@nexus/wire';

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

/** 理由碼 → 結局。`not-text` 落在 `'error'` 是對的，不是漏掉，見檔頭。 */
function failureOf(error: DeliverableReadError): DeliverableDownloadFailure {
  switch (error.code) {
    case 'deliverable/no-anchor':
    case 'deliverable/not-found':
    case 'deliverable/not-regular-file':
      return 'missing';
    case 'deliverable/too-large':
      return 'too-large';
    case 'deliverable/not-text':
      return 'error';
  }
}

/** 「這條線收不了」：只有協定錯誤 `invalid_argument` 是 `'invalid'`，其餘可重試；理由同 `deliverable-file.ts` 的 `failureOfRejected`。 */
function failureOfRejected(rejected: { readonly code?: string }): DeliverableDownloadFailure {
  return rejected.code === 'invalid_argument' ? 'invalid' : 'error';
}

/**
 * 把位元組交給瀏覽器存檔。
 *
 * 檔名取宣告路徑的最後一段：命令通道的回應沒有 `content-disposition`，檔名只能從我們手上的路徑來。
 */
function saveBytes(bytes: Uint8Array<ArrayBuffer>, name: string): void {
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
  const client = createDeliverableClient({ baseUrl, fetch: doFetch });

  return {
    async download(file) {
      const { seq, index } = file;
      try {
        // **不帶 `offset`／`length`**：兩個都不給才是整檔下載，給任何一個就變成窗口。
        const outcome = await client.readBytes(threadId, { seq, index });
        if (outcome.kind === 'rejected') return failureOfRejected(outcome);
        if (!outcome.result.ok) return failureOf(outcome.result.error);
        // **位元組從頭到尾不碰文字解碼器**：中間只要出現一次文字解碼，二進位就壞了，而且全程
        // 沒有徵兆——`readRaw` 那支基座工具正是這樣壞的（6 位元組進、10 出，`error` 仍是
        // `undefined`）。多段表單的附件由 wire 原樣放進 `Uint8Array`。
        const { data } = outcome.result.value;
        if (!(data instanceof Uint8Array)) return 'error';
        // wire 的解碼器產出的是 `ArrayBuffer` 上的視圖；型別寫成 `ArrayBufferLike` 是因為 `Uint8Array` 的預設，不會是 `SharedArrayBuffer`。
        saveBytes(data as Uint8Array<ArrayBuffer>, basename(file.path) || 'deliverable');
        return 'ok';
      } catch {
        return 'error';
      }
    },
  };
}
