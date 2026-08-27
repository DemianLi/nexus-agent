/**
 * 一條對話的接線：開下行、把 frame 折進狀態、把話送上行。
 *
 * **折疊本身不在這裡**，在 `@nexus/wire` 的 `reduceConversation`——那一層才驗得到
 * 真的 agent 跑出來的 frame（見 `@nexus/harness` 的 `conversation-wire.test.ts`）。
 * 這個 hook 只負責 React 那一半：連線的生命週期與送出的時機。
 */

import type { ConversationState, WireClient } from '@nexus/wire';
import { appendHumanTurn, emptyConversation, reduceConversation } from '@nexus/wire';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createAgentClient } from '@/lib/agent';

export interface UseConversationOptions {
  /** 注入用；省略即連同源的 harness。 */
  readonly client?: WireClient;
  /** 省略即這一次載入自己開一條新的。 */
  readonly threadId?: string;
}

export interface Conversation {
  readonly state: ConversationState;
  /** 下行開好了沒。**開好之前不能送**——這條線沒有重播，早送的那一輪會看不到。 */
  readonly connected: boolean;
  readonly connectionError?: string;
  send(text: string): Promise<void>;
}

export function useConversation(options: UseConversationOptions = {}): Conversation {
  const client = useMemo(() => options.client ?? createAgentClient(), [options.client]);
  const threadId = useMemo(() => options.threadId ?? crypto.randomUUID(), [options.threadId]);

  const [state, setState] = useState<ConversationState>(emptyConversation);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined);
  const clientRef = useRef(client);
  clientRef.current = client;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const events = await client.openEvents(threadId, { signal: controller.signal });
        if (cancelled) {
          return;
        }
        setConnected(true);
        for await (const event of events) {
          if (cancelled) {
            return;
          }
          setState((previous) => reduceConversation(previous, event));
        }
      } catch (error) {
        if (!cancelled) {
          setConnectionError(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      // **收的是這條線，不是 agent。** server 端不會因為瀏覽器離開就停掉 run。
      cancelled = true;
      controller.abort();
      setConnected(false);
    };
  }, [client, threadId]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '') {
        return;
      }
      // 線上不會回聲使用者這句話，所以送出的那一刻自己補進去。
      setState((previous) => appendHumanTurn(previous, trimmed));
      await clientRef.current.runStart(threadId, trimmed);
    },
    [threadId],
  );

  return { state, connected, send, ...(connectionError === undefined ? {} : { connectionError }) };
}
