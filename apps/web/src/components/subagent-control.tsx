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
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FormEvent } from 'react';
import { Send, Square } from 'lucide-react';
import type { WireClient } from '@nexus/wire';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

export interface SubagentControl {
  readonly connected: boolean;
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
}: {
  readonly client: WireClient;
  readonly threadId: string;
  readonly status: SubagentStatus;
  readonly connected: boolean;
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

  return useMemo(
    () => ({
      connected,
      stateOf: (runId) => subagentRunState(status, runId),
      echoesOf: (runId) => current.get(runId) ?? NONE,
      send,
      interrupt,
    }),
    [connected, status, current, send, interrupt],
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
    <span className="text-muted-foreground shrink-0 text-xs" data-subagent-state>
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

  const sendable = canSendToSubagent(state, control.connected);
  const placeholder = control.connected ? subagentPlaceholder(state) : '連線中…';
  const echoes = control.echoesOf(runId);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (body === '' || !sendable || sending) return;
    setSending(true);
    setError(undefined);
    void control.send(runId, body).then((outcome) => {
      if (!alive.current) return;
      setSending(false);
      if (outcome.ok) setText('');
      else setError(outcome.message);
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
      {echoes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {echoes.map((echo, index) => (
            <li
              key={index}
              data-subagent-echo
              className="flex items-baseline gap-2 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap"
            >
              <span className="text-muted-foreground shrink-0 text-xs">你：</span>
              <span className="min-w-0 flex-1">{echo}</span>
              <span className="text-muted-foreground shrink-0 text-xs">已送出</span>
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
        <p role="alert" className="text-destructive text-xs" data-subagent-error>
          {error}
        </p>
      )}
    </div>
  );
}
