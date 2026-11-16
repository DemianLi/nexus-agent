import type { CommandOutcome } from '@nexus/wire';
import {
  THREAD_AT_CAPACITY,
  THREAD_LOG_BUSY,
  THREAD_WRITER_HELD,
  UplinkTransportError,
} from '@nexus/wire';
import { useEffect, useRef, useState } from 'react';

/**
 * 這一次讀失敗，值不值得在下行**下一次接上**時再讀一次（[#1483](https://github.com/DemianLi/nexus-agent/issues/1483)）。
 *
 * 只認**暫時的**失敗：thread 起不來時 server 的 `threadOrError` 回的 `thread_at_capacity`、`thread_log_busy`、`thread_writer_held`、`unknown_error`，
 * 以及網路層拋的錯。**永久的「沒有」不算**——`not_supported`（這個組裝沒有）、載體層的 4xx（舊 server 不認得這個 method
 * 回 404）、`result.ok === false` 的業務回答：接回來也一樣，重讀只是每次接回多打一次。`threadOrError` 的這四種碼也是永久的：
 * `thread_is_subagent`（子代理的會話，#1544）、`thread_history_too_deep`（日誌裡有一則太深、灌不回去，#1668／#1753）、
 * `thread_log_too_large`（日誌單獨就超過額度，#2203）與 `thread_root_mismatch`（日誌記的可寫根這台接不上，#2222），
 * 同一份日誌在這台 serve 上每次都一樣。
 */
export function worthRereading(
  failure: { readonly code?: string } | { readonly thrown: unknown },
): boolean {
  if ('thrown' in failure) {
    const error = failure.thrown;
    return !(error instanceof UplinkTransportError && error.status >= 400 && error.status < 500);
  }
  return (
    failure.code === THREAD_AT_CAPACITY ||
    failure.code === THREAD_LOG_BUSY ||
    failure.code === THREAD_WRITER_HELD ||
    failure.code === 'unknown_error'
  );
}

/**
 * 打開一條會話時讀一次的東西（模型座、權限選單、`@` 子代理清單）：回讀到的 `result`，還在讀或讀不到是 `null`。
 *
 * 這幾個請求跟下行並行發，都經 server 的 `threadFor`：thread 滿了、或暫時起不來時一起失敗，以前就一直不畫，要換會話或重新整理
 * 才回來。現在**暫時的失敗**（{@link worthRereading}）記下來，下行下一次接上（`connections` 加一）時再讀一次。
 * **沒失敗過就不重讀**：下行沒斷過、或讀成功之後才斷，請求次數跟以前一樣，也不輪詢。請求還在路上時下行先接上、之後它才失敗的話，
 * 要等再下一次接上。
 *
 * @param read - 讀一次。**要穩定**（`useCallback` 綁 `client` 與 `threadId`）：換了就當成換了會話、從頭讀。
 * @param connections - 下行接上過幾次（`useConversation` 的 `connections`）。
 */
export function useOpenRead<T>(
  read: () => Promise<CommandOutcome<T>>,
  connections: number,
): T | null {
  const [value, setValue] = useState<{ readonly read: typeof read; readonly result: T } | null>(
    null,
  );
  const [tries, setTries] = useState(0);
  const failed = useRef(false);

  useEffect(() => {
    let live = true;
    failed.current = false;
    read().then(
      (outcome) => {
        if (!live) return;
        if (outcome.kind === 'ok') setValue({ read, result: outcome.result });
        else failed.current = worthRereading(outcome);
      },
      (error: unknown) => {
        if (live) failed.current = worthRereading({ thrown: error });
      },
    );
    return () => {
      live = false;
    };
  }, [read, tries]);

  // 只看「又接上了」這一刻；第一次 render 的那一次 `failed` 一定是 false（還沒讀完）。
  useEffect(() => {
    if (!failed.current) return;
    failed.current = false;
    setTries((count) => count + 1);
  }, [connections]);

  return value !== null && value.read === read ? value.result : null;
}
