/**
 * 一條對話的接線：開下行、把 frame 折進狀態、把話送上行。
 *
 * **折疊本身不在這裡**，在 `@nexus/wire` 的 `reduceConversation`——那一層才驗得到
 * 真的 agent 跑出來的 frame（見 `@nexus/harness` 的 `conversation-wire.test.ts`）。
 * 這個 hook 只負責 React 那一半：連線的生命週期與送出的時機。
 */

import type { CommandResult, ConversationState, WireClient } from '@nexus/wire';
import {
  appendDecision,
  appendHumanTurn,
  emptyConversation,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
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
  /**
   * 上一個上行指令被拒的原因。
   *
   * **這條線的上行會拒絕東西**（停在核准點時的 `run.start`、對不上的 `interrupt_id`、
   * 筆數不對的決定），而拒絕是 200 ＋ error 封包。不看回應等於把它們靜靜吞掉——
   * 那正是這一版在 server 端拒絕動作要避免的事。
   */
  readonly commandError?: string;
  send(text: string): Promise<void>;
  /**
   * 回答掛著的那個核准請求。
   *
   * 一個決定套到整批上——逐筆按在基座那側分不出來（見 `ApprovalCard`）。
   * 沒有掛著的請求時什麼都不做。
   */
  respond(decision: string): Promise<void>;
}

export function useConversation(options: UseConversationOptions = {}): Conversation {
  const client = useMemo(() => options.client ?? createAgentClient(), [options.client]);
  const threadId = useMemo(() => options.threadId ?? crypto.randomUUID(), [options.threadId]);

  const [state, setState] = useState<ConversationState>(emptyConversation);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined);
  const [commandError, setCommandError] = useState<string | undefined>(undefined);
  const clientRef = useRef(client);
  clientRef.current = client;
  // 送出的那一刻要讀的是**當下**的 pending，不是這次 render 閉包起來的那份。
  const stateRef = useRef(state);
  stateRef.current = state;

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

  /** 收下上行的回條：被拒就說出來，成功就把上一次的抱怨收掉。 */
  const note = useCallback((result: CommandResult) => {
    setCommandError(result.type === 'error' ? result.message : undefined);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '') {
        return;
      }
      // 線上不會回聲使用者這句話，所以送出的那一刻自己補進去。
      setState((previous) => appendHumanTurn(previous, trimmed));
      note(await clientRef.current.runStart(threadId, trimmed));
    },
    [threadId, note],
  );

  const respond = useCallback(
    async (decision: string) => {
      const pending = stateRef.current.pending;
      if (pending === undefined) {
        return;
      }
      // **決定在線上沒有回聲**——拒絕掉的那一批連一顆 frame 都不會有（實測），
      // 所以跟使用者那句話一樣，在送出的那一刻自己寫進去。
      setState((previous) => appendDecision(previous, decision));
      note(
        await clientRef.current.inputRespond(threadId, {
          namespace: [...pending.namespace],
          interrupt_id: pending.interruptId,
          response: uniformDecisions(pending, decision),
        }),
      );
    },
    [threadId, note],
  );

  return {
    state,
    connected,
    send,
    respond,
    ...(connectionError === undefined ? {} : { connectionError }),
    ...(commandError === undefined ? {} : { commandError }),
  };
}
