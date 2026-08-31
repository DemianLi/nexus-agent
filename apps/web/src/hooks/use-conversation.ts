/**
 * 一條對話的接線：開下行、把 frame 折進狀態、把話送上行。
 *
 * **折疊本身不在這裡**，在 `@nexus/wire` 的 `reduceConversation`——那一層才驗得到
 * 真的 agent 跑出來的 frame（見 `@nexus/harness` 的 `conversation-wire.test.ts`）。
 * 這個 hook 只負責 React 那一半：連線的生命週期與送出的時機。
 */

import type {
  ConversationState,
  SlashDescriptor,
  SlashRunOutcome,
  UplinkResult,
  WireClient,
} from '@nexus/wire';
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
  /**
   * 這條 thread 打得出哪些斜線命令。**拿來顯示，不做選單**——
   * dsh 的 `CommandDirectory`（epoch guard、single-flight、`ensureReady`）是另一張卡。
   */
  readonly slashCommands: readonly SlashDescriptor[];
  /**
   * 上一個斜線命令自己失敗的原因，或那一行不是認得的命令。
   *
   * **跟 {@link Conversation.commandError} 是兩件事**：那個是這條線拒絕發派
   * （停在核准點、正在跑），這個是發派成功之後命令自己講的話。混在一起的那一刻，
   * 「這條 thread 正在跑」就會被顯示成「這個命令壞了」。
   */
  readonly slashError?: string;
  /**
   * 上一個斜線命令成功時要說的話。**命令的結果不進 transcript**——命令是人對工具說的
   * 話，不是對模型說的話，而 transcript 折的是線上的 `Event`。CLI 那邊的對應是
   * `printer.log`。
   */
  readonly slashNotice?: string;
  /**
   * 送一行進去。**第一個字是 `/` 就走 `slash.run`**，其餘走 `run.start`。
   *
   * 認不得的命令在這裡是錯誤，不像 CLI 那樣照原樣送給模型——瀏覽器這個發派面手上
   * 就有清單，說「不認得」比把一行斜線丟給模型有用
   * （[#123](https://github.com/DemianLi/nexus-agent/issues/123)）。
   */
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
  const [slashCommands, setSlashCommands] = useState<readonly SlashDescriptor[]>([]);
  const [slashError, setSlashError] = useState<string | undefined>(undefined);
  const [slashNotice, setSlashNotice] = useState<string | undefined>(undefined);
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
        // **抓清單排在開線之後**，跟送話同一條規則：這條線沒有重播，所有的上行都等
        // 下行開好。清單本身不需要重播，但兩套順序規則比一套容易記錯。
        const listed = await client.slashList(threadId);
        if (cancelled) {
          return;
        }
        if (listed.kind === 'ok') {
          setSlashCommands(listed.commands);
        } else {
          setSlashError(listed.message);
        }
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
  const note = useCallback((result: UplinkResult) => {
    setCommandError(result.type === 'error' ? result.message : undefined);
  }, []);

  /** 斜線命令那一半。**不 `appendHumanTurn`**——命令不進模型，也就不進 transcript。 */
  const runSlash = useCallback(
    async (line: string) => {
      setSlashError(undefined);
      setSlashNotice(undefined);
      let outcome: SlashRunOutcome;
      try {
        outcome = await clientRef.current.slashRun(threadId, line);
      } catch (error) {
        setSlashError(error instanceof Error ? error.message : String(error));
        return;
      }
      if (outcome.kind === 'rejected') {
        // 這條線拒絕發派——跟 `run.start` 被拒是同一件事，所以走同一個欄位。
        setCommandError(outcome.message);
        return;
      }
      setCommandError(undefined);
      if (outcome.kind === 'unknown') {
        setSlashError(`不認得這個命令：${line}`);
        return;
      }
      if (outcome.kind === 'error') {
        setSlashError(outcome.text);
        return;
      }
      // 成功而沒話說時什麼都不顯示，跟 CLI 一樣（`result.text` 是選配的）。
      setSlashNotice(outcome.text);
    },
    [threadId],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '') {
        return;
      }
      if (trimmed.startsWith('/')) {
        await runSlash(trimmed);
        return;
      }
      setSlashError(undefined);
      setSlashNotice(undefined);
      // 線上不會回聲使用者這句話，所以送出的那一刻自己補進去。
      setState((previous) => appendHumanTurn(previous, trimmed));
      note(await clientRef.current.runStart(threadId, trimmed));
    },
    [threadId, note, runSlash],
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
    slashCommands,
    send,
    respond,
    ...(connectionError === undefined ? {} : { connectionError }),
    ...(commandError === undefined ? {} : { commandError }),
    ...(slashError === undefined ? {} : { slashError }),
    ...(slashNotice === undefined ? {} : { slashNotice }),
  };
}
