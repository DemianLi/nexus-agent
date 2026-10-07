/**
 * 對背景子代理說話、單獨停下它（[#869](https://github.com/DemianLi/nexus-agent/issues/869)，#737 卡 7 的 web 半邊 (c)(d)）。
 *
 * 子代理留在主對話裡，輸入框與停止鈕都放在**委派卡展開後**（不做進入子代理的獨立檢視）。送出走 wire 的
 * `subagentSend`，停止走 `subagentInterrupt`；兩個都**受理就回、不等那一輪跑完**，所以：
 *
 * - 送出之後沒有 frame 回來。畫面在卡內留一則「你：…」的本地回聲（#869 Q1）；重新整理後的回聲等歷史能讀
 *   子代理自己的日誌（#871）再接，這裡不另外存。
 * - 停止「不認得／沒在跑」是被接受的 no-op，回應看不出停成沒有，**狀態只看 `subagentStatus`**（#870）：按下去鈕變
 *   「停止中…」，狀態翻成閒著或收線就恢復；十秒還沒翻也恢復（停止是冪等的，沒翻代表那一下沒碰到任何一輪）。
 * - 沒有提供者（單獨畫 Transcript 的測試）就不畫這一區。
 * - **子代理自己的對話**（#861）：面板打開時用 `subagentHistory` 讀一次（只有歷史、沒有 live），折成獨立的對話畫在輸入框上方；
 *   狀態從跑著翻成閒著／收線時、送出之後各再讀一次，也可以手動重新讀。單則項目怎麼畫由外面給（`renderEntry`），這裡不 import
 *   對話列表，免得跟工具卡互相引用。
 *
 * 狀態與佔位字等文字判斷在 `lib/subagent-view.ts`。
 *
 * @module
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FormEvent } from 'react';
import { RotateCw, Send, Square } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConversationEntry, WireClient } from '@nexus/wire';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  foldSubagentHistory,
  SUBAGENT_HISTORY_MAX_MESSAGES,
  unmatchedEchoes,
} from '@/lib/subagent-conversation';
import type { SubagentConversation } from '@/lib/subagent-conversation';
import {
  canSendToSubagent,
  canStopSubagent,
  SUBAGENT_STATE_LABEL,
  subagentPlaceholder,
  subagentRunState,
  subagentSendError,
} from '@/lib/subagent-view';
import type { SubagentRunState } from '@/lib/subagent-view';

type SubagentStatus = Readonly<Record<string, 'running' | 'idle'>> | null;

/** 送話的結果：成功，或一句講給人聽的失敗。 */
export type SubagentSendOutcome =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/** 讀回子代理自己的對話：成功，或一句話講為什麼讀不回來。 */
export type SubagentHistoryOutcome =
  | { readonly ok: true; readonly conversation: SubagentConversation }
  | { readonly ok: false; readonly message: string };

export interface SubagentControl {
  readonly connected: boolean;
  /** 單則項目怎麼畫（人話、回覆、工具卡）：跟主對話同一套，由外面給。 */
  readonly renderEntry: (entry: ConversationEntry) => ReactNode;
  history(runId: string): Promise<SubagentHistoryOutcome>;
  stateOf(runId: string): SubagentRunState;
  /** 這條對話裡人對它說過的話（本地回聲，依序）。 */
  echoesOf(runId: string): readonly string[];
  send(runId: string, text: string): Promise<SubagentSendOutcome>;
  /** 回 `undefined` 是受理；失敗回一句話。 */
  interrupt(runId: string): Promise<string | undefined>;
}

export const SubagentControlContext = createContext<SubagentControl | null>(null);

/** 停止鈕「停止中…」最久撐多久；之後恢復成可按（狀態沒翻代表那一下沒碰到任何一輪）。 */
const STOPPING_MAX_MS = 10_000;

const NETWORK_FAILED = '沒送出去：連線出了問題，請再試一次。';

/**
 * 組出提供者要的東西。本地回聲放在這裡而不是卡片裡：卡片收合再展開會卸載，回聲不該跟著不見；換 thread 就清掉。
 */
export function useSubagentControl({
  client,
  threadId,
  status,
  connected,
  renderEntry,
}: {
  readonly client: WireClient;
  readonly threadId: string;
  readonly status: SubagentStatus;
  readonly connected: boolean;
  readonly renderEntry: (entry: ConversationEntry) => ReactNode;
}): SubagentControl {
  const [echoes, setEchoes] = useState<{
    readonly threadId: string;
    readonly byRun: ReadonlyMap<string, readonly string[]>;
  }>({ threadId, byRun: new Map() });
  const current = echoes.threadId === threadId ? echoes.byRun : EMPTY;

  const send = useCallback(
    async (runId: string, text: string): Promise<SubagentSendOutcome> => {
      try {
        const result = await client.subagentSend(threadId, runId, text);
        if (result.type === 'error') {
          return { ok: false, message: subagentSendError(result.error, result.message) };
        }
      } catch {
        return { ok: false, message: NETWORK_FAILED };
      }
      setEchoes((previous) => {
        const base = previous.threadId === threadId ? previous.byRun : EMPTY;
        const next = new Map(base);
        next.set(runId, [...(base.get(runId) ?? []), text]);
        return { threadId, byRun: next };
      });
      return { ok: true };
    },
    [client, threadId],
  );

  const interrupt = useCallback(
    async (runId: string): Promise<string | undefined> => {
      try {
        const result = await client.subagentInterrupt(threadId, runId);
        return result.type === 'error' ? `停止沒送出去：${result.message}` : undefined;
      } catch {
        return '停止沒送出去：連線出了問題，請再試一次。';
      }
    },
    [client, threadId],
  );

  const history = useCallback(
    async (runId: string): Promise<SubagentHistoryOutcome> => {
      try {
        const outcome = await client.subagentHistory(threadId, runId, {
          maxMessages: SUBAGENT_HISTORY_MAX_MESSAGES,
        });
        return outcome.kind === 'ok'
          ? { ok: true, conversation: foldSubagentHistory(outcome.result) }
          : { ok: false, message: outcome.message };
      } catch {
        return { ok: false, message: '連線出了問題' };
      }
    },
    [client, threadId],
  );

  return useMemo(
    () => ({
      connected,
      renderEntry,
      history,
      stateOf: (runId) => subagentRunState(status, runId),
      echoesOf: (runId) => current.get(runId) ?? NONE,
      send,
      interrupt,
    }),
    [connected, renderEntry, history, status, current, send, interrupt],
  );
}

const EMPTY: ReadonlyMap<string, readonly string[]> = new Map();
const NONE: readonly string[] = [];

/** 委派卡標頭上的小狀態字（跑著／閒著／已收線）。沒有提供者或還不知道就不畫。 */
export function SubagentStateLabel({ runId }: { readonly runId: string }) {
  const label =
    SUBAGENT_STATE_LABEL[useContext(SubagentControlContext)?.stateOf(runId) ?? 'unknown'];
  if (label === undefined) return null;
  return (
    <span className="text-muted-foreground shrink-0 text-tip" data-subagent-state>
      {label}
    </span>
  );
}

/** 委派卡展開後的輸入框、本地回聲與停止鈕。 */
export function SubagentPanel({ runId }: { readonly runId: string }) {
  const control = useContext(SubagentControlContext);
  if (control === null) return null;
  return <Panel runId={runId} control={control} />;
}

function Panel({ runId, control }: { readonly runId: string; readonly control: SubagentControl }) {
  const state = control.stateOf(runId);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 狀態翻成閒著或收線，停止就完成了；一直沒翻就在上限之後放手。
  useEffect(() => {
    if (!stopping) return;
    if (!canStopSubagent(state)) {
      setStopping(false);
      return;
    }
    const timer = setTimeout(() => setStopping(false), STOPPING_MAX_MS);
    return () => clearTimeout(timer);
  }, [stopping, state]);

  // 子代理自己的對話：打開讀一次；跑著翻成閒著或收線、送出之後各再讀一次（只有歷史，沒有 live）。
  const [tick, setTick] = useState(0);
  const history = useSubagentHistory(control.history, runId, tick);
  // 回聲只管「還沒寫進日誌」的那幾句：子代理跑完（翻成閒著或收線）時，到那一刻為止送出的都已經領走、寫進日誌了，
  // 之後讀回來的歷史自己會有。不這樣收的話，對話長到最早的幾句掉出最近 40 則，它們的回聲會永遠留在底下（#861）。
  const echoCount = control.echoesOf(runId).length;
  const [settled, setSettled] = useState(() => (canStopSubagent(state) ? 0 : echoCount));
  const previous = useRef(state);
  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (canStopSubagent(before) && !canStopSubagent(state)) {
      setTick((value) => value + 1);
      setSettled(echoCount);
    }
    // 只在狀態翻面時看一次；`echoCount` 是翻面那一刻的值。
  }, [state]);

  const sendable = canSendToSubagent(state, control.connected);
  const placeholder = control.connected ? subagentPlaceholder(state) : '連線中…';
  // 歷史已有的人話就不再畫回聲（重複）；還沒有的（送出到寫進日誌之間）留著。
  const echoes =
    history.conversation === undefined
      ? control.echoesOf(runId)
      : unmatchedEchoes(control.echoesOf(runId).slice(settled), history.conversation.entries);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (body === '' || !sendable || sending) return;
    setSending(true);
    setError(undefined);
    void control.send(runId, body).then((outcome) => {
      if (!alive.current) return;
      setSending(false);
      if (outcome.ok) {
        setText('');
        setTick((value) => value + 1);
      } else setError(outcome.message);
    });
  };

  const stop = () => {
    setStopping(true);
    setError(undefined);
    void control.interrupt(runId).then((failure) => {
      if (!alive.current || failure === undefined) return;
      setStopping(false);
      setError(failure);
    });
  };

  return (
    <div
      className="bg-stage shadow-stage flex flex-col gap-2 rounded-xl p-3"
      data-subagent-panel={runId}
    >
      <Conversation
        history={history}
        closed={state === 'closed'}
        renderEntry={control.renderEntry}
        onReload={() => setTick((value) => value + 1)}
      />
      {echoes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {echoes.map((echo, index) => (
            <li
              key={index}
              data-subagent-echo
              className="flex items-baseline gap-2 text-body [overflow-wrap:anywhere] whitespace-pre-wrap"
            >
              <span className="text-muted-foreground shrink-0 text-tip">你：</span>
              <span className="min-w-0 flex-1">{echo}</span>
              <span className="text-muted-foreground shrink-0 text-tip">已送出</span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <Input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (error !== undefined) setError(undefined);
          }}
          disabled={!sendable || sending}
          placeholder={placeholder}
          aria-label="對背景子代理說話"
          className="min-h-11 basis-full sm:min-h-9 sm:flex-1 sm:basis-0"
        />
        <Button
          type="submit"
          size="sm"
          className="ml-auto min-h-11 min-w-11 sm:ml-0 sm:min-h-9"
          disabled={!sendable || sending || text.trim() === ''}
          aria-label="送出給背景子代理"
        >
          <Send aria-hidden />
          {sending ? '送出中…' : '送出'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 min-w-11 sm:min-h-9"
          disabled={!canStopSubagent(state) || stopping}
          onClick={stop}
          aria-label="停止這一輪"
        >
          <Square aria-hidden className="fill-current" />
          {stopping ? '停止中…' : '停止這一輪'}
        </Button>
      </form>
      {error !== undefined && (
        <p role="alert" className="text-destructive text-tip" data-subagent-error>
          {error}
        </p>
      )}
    </div>
  );
}

interface HistoryView {
  /** 最近一次讀成功的；重讀失敗時還留著舊的。 */
  readonly conversation?: SubagentConversation;
  readonly loading: boolean;
  readonly error?: string;
}

/** 讀子代理的對話；`tick` 一變就重讀。後到的舊回應不覆蓋新的。 */
function useSubagentHistory(
  load: SubagentControl['history'],
  runId: string,
  tick: number,
): HistoryView {
  const [view, setView] = useState<HistoryView>({ loading: true });
  useEffect(() => {
    let live = true;
    setView((previous) => ({ ...previous, loading: true }));
    void load(runId).then((outcome) => {
      if (!live) return;
      setView((previous) =>
        outcome.ok
          ? { conversation: outcome.conversation, loading: false }
          : {
              ...(previous.conversation === undefined
                ? {}
                : { conversation: previous.conversation }),
              loading: false,
              error: outcome.message,
            },
      );
    });
    return () => {
      live = false;
    };
  }, [load, runId, tick]);
  return view;
}

const TASK_CAPTION = '派出的任務';

function Conversation({
  history,
  closed,
  renderEntry,
  onReload,
}: {
  readonly history: HistoryView;
  readonly closed: boolean;
  readonly renderEntry: SubagentControl['renderEntry'];
  readonly onReload: () => void;
}) {
  const entries = history.conversation?.entries;
  // 只有讀到最開頭才知道第一則人話是派出的任務；前面還有更早的，第一則可能只是後來對它說的話。
  const fromStart = history.conversation?.hasMore === false;
  const scroller = useRef<HTMLDivElement>(null);
  // 新讀回來的接在尾巴：捲到底，看到最新的。
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [entries]);
  return (
    <section
      aria-label="背景子代理的對話"
      className="flex flex-col gap-2"
      data-subagent-conversation
    >
      <div className="flex min-h-8 items-center gap-2">
        <span className="text-muted-foreground text-tip">子代理的對話</span>
        {history.loading && <span className="text-muted-foreground text-tip">讀取中…</span>}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto max-sm:size-11"
          aria-label="重新讀取子代理的對話"
          disabled={history.loading}
          onClick={onReload}
        >
          <RotateCw aria-hidden />
        </Button>
      </div>
      {history.error !== undefined && (
        <p
          className={closed ? 'text-muted-foreground text-tip' : 'text-destructive text-tip'}
          data-subagent-history-error
        >
          {closed ? '這個子代理的對話讀不到了。' : `子代理的對話讀不回來：${history.error}`}
        </p>
      )}
      {entries !== undefined && entries.length > 0 && (
        <div ref={scroller} className="flex max-h-96 flex-col gap-3 overflow-y-auto">
          {entries.map((entry, index) => (
            <div key={entry.id} className="flex flex-col gap-1">
              {fromStart && index === 0 && entry.kind === 'human' && (
                <p className="text-muted-foreground text-right text-tip">{TASK_CAPTION}</p>
              )}
              {renderEntry(entry)}
            </div>
          ))}
        </div>
      )}
      {history.conversation?.hasMore === true && (
        <p className="text-muted-foreground text-tip">
          只顯示最近 {SUBAGENT_HISTORY_MAX_MESSAGES} 則，更早的沒有載入。
        </p>
      )}
    </section>
  );
}
