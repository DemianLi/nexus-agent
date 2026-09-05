/**
 * 下行 pump：把 N 個 run 物件接成一條長期串流。
 *
 * **這是這一層存在的全部理由。** 一場對話不是一個 run 物件——停在核准點時 run 就收掉，
 * `streamEvents(new Command({ resume }), …)` 回的是**另一個** run 物件，而且只帶
 * resume 之後的訊息。把某一個 run 直接交給瀏覽器，核准一次就斷一次線。
 *
 * 量到而且會無聲壞掉的四件事（見開發計劃第 7 節決策 6）：
 *
 * 1. **`seq` 在每個 run 上從 0 重來**，所以接起來的時候一定要重新編號；照原樣轉出去
 *    的話瀏覽器那側的排序與去重會靜靜地壞掉——seq 不會變小到看得出來，它是一段一段重來。
 * 2. **`lifecycle` 的 `{ event:'completed', graph_name:'root' }` 在中斷時照樣會發**，
 *    所以它不是關線的訊號。拿它關線的話每按一次核准就斷一次。
 * 3. **中斷時 raw iteration 乾淨結束、不拋**，所以 pump 從頭到尾不必碰 `run.output`
 *    （那個「暫停時 `await run.output` 會炸」的陷阱屬於核准 UI 那一端）。
 * 4. **失敗會先上線再拋**：最後一顆 frame 是 `lifecycle { event:'failed', … , error }`，
 *    然後 iteration 才 throw。所以這裡的 try/catch 是用來收尾的，不是用來補錯誤 frame 的。
 *
 * 第五件是 `feat/web-hitl` 動工前才量到的，理由不同（它不是接線問題，是**靜默**問題）：
 *
 * 5. **停在核准點時再送一句話，中斷會被靜靜丟掉。** 實測基座照跑新的一輪
 *    （`patchToolCallsMiddleware.before_agent` 補掉懸空的工具呼叫），那個等著核准的工具
 *    **既沒執行也沒被拒絕**，而且**不會再發第二顆 `input.requested`**——核准請求就這樣
 *    蒸發了，下行上一顆 frame 都看不出來。所以 pump 記著目前掛著的那顆中斷
 *    （{@link ThreadPump.pending}），讓上行那一側擋得下來。
 */

import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { SessionRegistry, type SessionEventMap, type SessionLog } from '@nexus/core';
import type { Event, WireChannel } from '@nexus/wire';
import { channelOfMethod, eventId } from '@nexus/wire';

import { driveGoalRound } from './goal-driver.js';
import type { GoalDriverPort, GoalRoundRequest } from './goal-driver.js';

/** 基座 v3 run 抽出來的一顆原始封包（`GraphRunStream implements AsyncIterable<ProtocolEvent>`）。 */
interface RawProtocolEvent {
  readonly type: 'event';
  readonly seq: number;
  readonly method: string;
  readonly params: {
    readonly namespace: string[];
    readonly timestamp: number;
    readonly node?: string;
    readonly data: unknown;
  };
}

/** pump 對 agent 的全部要求：給我一個可抽的 v3 run。 */
export interface PumpAgent {
  streamEvents(
    input: never,
    config: { readonly version: 'v3'; readonly configurable: { readonly thread_id: string } },
  ): Promise<AsyncIterable<RawProtocolEvent>>;
}

/**
 * 送進去的東西：一句話、一組核准決定，或**排程器排的一輪續行**。
 *
 * `goal` 那一種與 `message` 在圖上走同一條路（都是一則 `HumanMessage`），差別全在日誌
 * 上那顆 `turn/start` 的 `kind`——而那一格是授權的判別欄（`session-log.ts`）。
 */
export type PumpInput =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'resume'; readonly response: unknown }
  | ({ readonly kind: 'goal' } & GoalRoundRequest);

interface Subscriber {
  readonly channels: readonly WireChannel[];
  readonly queue: Event[];
  wake?: () => void;
  done: boolean;
}

/** 目前掛在這條 thread 上、還沒被回答的那顆中斷。 */
export interface PendingInterrupt {
  readonly interruptId: string;
  /** 這一批要回答幾筆決定——基座逐 index 配對，長度不符當場拋。 */
  readonly actionCount: number;
}

/** 基座把中斷發在 `updates` 上的那一顆的 data 形狀。 */
interface InterruptEntry {
  readonly id: string;
  readonly value: unknown;
}

function asInterruptEntries(data: unknown): readonly InterruptEntry[] {
  // `updates` 的 data 是 `{ node, values }`，中斷那一顆的 values 才是中斷清單。
  const values = (data as { values?: unknown } | null)?.values;
  if (!Array.isArray(values)) {
    return [];
  }
  return values.filter(
    (entry): entry is InterruptEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as InterruptEntry).id === 'string',
  );
}

/** 這顆中斷在問幾件事。問不出來就當 0——上行那側只在數得出來時才校驗。 */
/** 一次輸入在日誌上的那顆頭。**三種各自對應一個 `kind`**，見 `session-log.ts`。 */
function turnStartOf(input: PumpInput): SessionEventMap['turn/start'] {
  switch (input.kind) {
    case 'message':
      return { kind: 'message', text: input.text };
    case 'resume':
      return { kind: 'resume' };
    case 'goal':
      return {
        kind: 'goal',
        text: input.text,
        goalId: input.goalId,
        revision: input.revision,
        round: input.round,
      };
  }
}

function actionCountOf(value: unknown): number {
  const requests = (value as { actionRequests?: unknown } | null)?.actionRequests;
  return Array.isArray(requests) ? requests.length : 0;
}

export class ThreadPump {
  readonly #agent: PumpAgent;
  readonly #threadId: string;
  readonly #subscribers = new Set<Subscriber>();
  readonly #sessions: SessionRegistry;
  /**
   * 傳輸層的號，給瀏覽器排序去重用的。
   *
   * **跟 {@link ThreadPump.sessionLog} 的 `seq` 是兩個號、兩個工作**，而且刻意不互相
   * 讀取——[#89](https://github.com/DemianLi/nexus-agent/issues/89) 否掉方案 (A) 的理由
   * 就是「拿傳輸序號去冒充耐久序號」。這個號在伺服器重啟時歸零（pump 是 per-instance 的），
   * 那對瀏覽器無所謂，對遙測會要命。
   */
  #seq = 0;
  #pending: PendingInterrupt | undefined;
  /** 一個 thread 一次只跑一個 run；後到的 submit 排隊，不平行跑。 */
  #tail: Promise<void> = Promise.resolve();
  /**
   * 還沒抽完的 run 有幾段——**排隊的也算**。
   *
   * 這個計數存在的理由在 {@link ThreadPump.running}：上行的回應是收件回條，
   * 「已經收下但還沒開跑」與「正在跑」對發派斜線命令的那一側是同一件事。
   */
  #inFlight = 0;
  #closed = false;

  /**
   * 續行排程器那一側。**`undefined` 就是沒掛**——這條 thread 一輪都不會自己排。
   *
   * 它是建構參數而不是後來設得上去的一格：掛不掛是一次組裝的決定（`--goal-driver`），
   * 而一條跑到一半忽然開始自己排輪次的 thread 沒有人要得起。
   */
  readonly #driver: GoalDriverPort | undefined;

  constructor(agent: PumpAgent, threadId: string, driver?: GoalDriverPort) {
    this.#agent = agent;
    this.#threadId = threadId;
    this.#sessions = new SessionRegistry(threadId);
    this.#driver = driver;
  }

  get threadId(): string {
    return this.#threadId;
  }

  /**
   * 這條 thread 的會話註冊表：**root 那一份，加上 subagent 後來出生的那些**。
   *
   * 三個消費者接的是它而不是單一份日誌，理由見
   * {@link @nexus/core!SessionRegistry}。
   */
  get sessions(): SessionRegistry {
    return this.#sessions;
  }

  /** 這條 thread 的 root 會話事件日誌。**耐久序號的擁有者**，見 `@nexus/core` 的 `SessionLog`。 */
  get sessionLog(): SessionLog {
    return this.#sessions.root;
  }

  /** 掛著等人回答的那顆中斷，沒有就是 `undefined`。 */
  get pending(): PendingInterrupt | undefined {
    return this.#pending;
  }

  /**
   * 這條 thread 上有沒有 run 還沒跑完——**排隊中的也算**。
   *
   * 給上行那一側擋斜線命令用（[#123](https://github.com/DemianLi/nexus-agent/issues/123)）。
   * 與 {@link ThreadPump.pending} 各擋一種：那個是「停在核准點」，這個是「還在飛」。
   * 兩個都不擋的話，`/plan` 的 pending intent 會跟飛行中那一輪的 `beforeAgent` 賽跑。
   */
  get running(): boolean {
    return this.#inFlight > 0;
  }

  /**
   * 開一條下行。它**跨 run 存活**：核准前後是同一條線。
   *
   * 沒有重播——訂閱之前發生的事這條線上看不到，接回來的方式是重開 ＋ 重抓歷史
   * （照 dsh 的 `reconnection = reopen the stream + refetch history`）。
   */
  subscribe(
    channels: readonly WireChannel[],
    signal?: AbortSignal,
  ): AsyncGenerator<Event, void, undefined> {
    // **註冊是同步的**，抽是之後的事。這樣「線開好了」與「開始抽」才是兩件事——
    // 開好之後才發生的 frame 一顆都不會掉在中間，即使消費端還沒開始抽。
    const subscriber: Subscriber = { channels, queue: [], done: this.#closed };
    this.#subscribers.add(subscriber);
    return this.#drain(subscriber, signal);
  }

  async *#drain(
    subscriber: Subscriber,
    signal?: AbortSignal,
  ): AsyncGenerator<Event, void, undefined> {
    const onAbort = () => {
      // **中止的是這條線，不是 run。** 瀏覽器關掉分頁不該讓 agent 停下來。
      subscriber.done = true;
      subscriber.wake?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        while (subscriber.queue.length > 0) {
          yield subscriber.queue.shift() as Event;
        }
        if (subscriber.done) {
          return;
        }
        await new Promise<void>((resolve) => {
          subscriber.wake = resolve;
        });
        subscriber.wake = undefined;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#subscribers.delete(subscriber);
    }
  }

  /** 目前有幾條下行掛著。給 handler 與測試看的。 */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /**
   * 送一件事進去，排在目前那一輪後面跑。
   *
   * 回傳的 promise 在**這一段** run 抽完時 resolve（跑完或停在核准點都算）。
   * 上行的 handler 不等它——那是收件回條，不是「跑完了」。
   */
  submit(input: PumpInput): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error('這條 thread 已經收掉了'));
    }
    // **收下的那一刻就不再掛著了，不是等它排到才清。** 排隊期間還掛著的話，連按兩次
    // 核准的第二次會通過上行的校驗、送出第二次 resume，而那時已經沒有中斷可以回答。
    this.#pending = undefined;
    // **同步就加一**：上行回的是收件回條，緊接著到的 `slash.run` 必須看得到「在飛」。
    this.#inFlight += 1;
    const next = this.#tail.then(() => this.#runOnce(input));
    // 排隊用的鏈不能因為某一輪炸掉就整條斷掉；減一兩條路都要走到。
    //
    // **排程掛在這裡，而且在減一之後**：`#driveGoalRound` 靠 `#inFlight === 0` 判斷
    // 「沒有人在排隊」，減一之前問的話它永遠看得到自己。跑壞的那一條也走到這裡，
    // 但決策函式會看到日誌上那顆 `turn/failed` 而回 `turn-failed`——**續行不重試**。
    const settled = () => {
      this.#inFlight -= 1;
      this.#driveGoalRound();
    };
    this.#tail = next.then(settled, settled);
    return next;
  }

  /** 等目前排隊的都跑完。測試用。 */
  async whenIdle(): Promise<void> {
    await this.#tail;
  }

  /** 收線。掛著的下行會正常結束，不是拋錯。 */
  close(): void {
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      subscriber.done = true;
      subscriber.wake?.();
    }
  }

  /**
   * 一輪落定之後，問排程器要不要再排一輪。
   *
   * **不 await**：它自己就會把排出來的那一輪丟回 {@link ThreadPump.submit}，而那條路
   * 跑完又會回到這裡。整串續行因此是一條由 `#tail` 序列化的鏈，不是一個遞迴呼叫堆。
   */
  #driveGoalRound(): void {
    const driver = this.#driver;
    if (driver === undefined || this.#closed) return;
    // **有人在排隊就讓行**，而且送出去之前還會再問一次（下面那一句）。
    //
    // **這兩道今天量不出行為差異，而且那件事要講清楚**：`#tail` 已經把所有輸入序列化
    // 了，所以排程器排出來的那一輪一定接在人那一筆後面——它搶不了先。留著它們是因為
    // 它們擋的是**多算一次**（連 `flush()` 都省下來），而且 `#tail` 那個保證一旦鬆動，
    // 這兩句就是唯一擋得住的東西。**不要把它們讀成有測試釘住的因果。**
    if (this.#inFlight > 0) return;
    void (async () => {
      try {
        const round = await driveGoalRound(() => this.#sessions.root.events, driver);
        // 再問一次：`flush()` 期間人可能已經送了東西進來。`driveGoalRound` 自己看不到
        // 排隊——它只讀日誌，而排隊中的那一筆還沒寫下任何事件——所以這是唯一看得到的地方。
        if (round === undefined || this.#closed || this.#inFlight > 0) return;
        void this.submit({ kind: 'goal', ...round }).catch(() => {
          // 那一輪自己的失敗已經進了日誌（`turn/failed`），而 `submit` 回的 promise
          // 沒有別人在等——不接住的話它是一顆 unhandled rejection，會殺掉整個行程。
        });
      } catch (error: unknown) {
        driver.warn(`排下一輪時出事：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  async #runOnce(input: PumpInput): Promise<void> {
    // **記在這裡而不是 submit 裡**：submit 只是排隊，真正開跑才是這一輪的起點。
    // 記在排隊時的話，兩件事排在一起時日誌會出現「兩個 start 之後才有第一個 end」。
    this.#sessions.root.append('turn/start', turnStartOf(input));
    // **`text` 只讀一次的那個值就是上面寫進日誌的那個。** 兩份分開算的話，一顆日誌上
    // 逐字正確的 `turn/start` 可以配上餵給模型的任意字串，而不變量伴生只看得到日誌那
    // 一份——它結構上驗不到這種偏差。所以這兩行必須共用同一個來源。
    const payload =
      input.kind === 'resume'
        ? new Command({ resume: input.response })
        : { messages: [new HumanMessage(input.text)] };

    try {
      // **取串流這一步也在 try 裡面。** 它自己就會拋（模型建不起來、憑證不對），
      // 而擺在外面的話那種失敗會留下一顆沒有結尾的 `turn/start` ——
      // 日誌上看起來像跑到一半消失，跟真的跑到一半消失分不出來。
      const run = await this.#agent.streamEvents(payload as never, {
        version: 'v3',
        configurable: { thread_id: this.#threadId },
      });
      for await (const raw of run) {
        for (const event of this.#translate(raw)) {
          this.#broadcast(event);
        }
      }
      // 跑完與停在核准點都算收工——停在核准點時前面會有一顆 `interrupt/raised`。
      this.#sessions.root.append('turn/end', {});
    } catch (error) {
      // 失敗的原因已經以 `lifecycle failed` 上了線（實測：失敗 frame 先發、然後才拋），
      // 所以這裡不再合成一顆。下行**不關**——這條線是長期的，下一次 submit 還要用。
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#sessions.root.append('turn/failed', { message: failure.message });
      throw failure;
    }
  }

  /** 一顆原始封包 → 零到多顆線上的封包。 */
  *#translate(raw: RawProtocolEvent): Generator<Event> {
    if (raw.method === 'updates' && raw.params.node === '__interrupt__') {
      // 基座把中斷發在 `updates` 上（`node: "__interrupt__"`），不發協定裡的
      // `input.requested`。這裡補上那一顆——順帶讓 `updates` 整條留在白名單外，
      // 它每一顆都夾著完整序列化的訊息。
      for (const entry of asInterruptEntries(raw.params.data)) {
        this.#pending = { interruptId: entry.id, actionCount: actionCountOf(entry.value) };
        this.#sessions.root.append('interrupt/raised', { interruptId: entry.id });
        yield this.#seal({
          method: 'input.requested',
          params: {
            namespace: raw.params.namespace,
            timestamp: raw.params.timestamp,
            data: { interrupt_id: entry.id, payload: entry.value },
          },
        } as Event);
      }
      return;
    }

    if (channelOfMethod(raw.method) === undefined) {
      return;
    }
    yield this.#seal({
      method: raw.method,
      params: {
        namespace: raw.params.namespace,
        timestamp: raw.params.timestamp,
        ...(raw.params.node === undefined ? {} : { node: raw.params.node }),
        data: raw.params.data,
      },
    } as Event);
  }

  /** 蓋上這條 thread 自己的編號——**不是 run 的 `seq`**，那個每個 run 都從 0 重來。 */
  #seal(event: Event): Event {
    const seq = this.#seq++;
    return { ...event, type: 'event', seq, event_id: eventId(this.#threadId, seq) };
  }

  #broadcast(event: Event): void {
    const channel = channelOfMethod(event.method);
    for (const subscriber of this.#subscribers) {
      if (subscriber.done || channel === undefined || !subscriber.channels.includes(channel)) {
        continue;
      }
      subscriber.queue.push(event);
      subscriber.wake?.();
    }
  }
}
