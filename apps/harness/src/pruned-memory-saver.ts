/**
 * 只留最新存檔點的 `MemorySaver`——[#1106](https://github.com/DemianLi/nexus-agent/issues/1106)。
 *
 * ## 問題
 *
 * LangGraph 的 `MemorySaver` 每個圖步驟存一份**含整段歷史**的序列化狀態（`messages` 是 `ReducedValue`，每個
 * 存檔點都帶完整累加值），而且從不丟舊的。實測（假端點＋真的 `serve --live`，150 輪短訊息，LangGraph 1.4.19）：
 * 1,950 個存檔點（每輪約 13 個）、`ArrayBuffer` 1,368 MB，每輪 CPU 50 → 250 ms。這是一台多人共用主機。
 *
 * ## 為什麼留最新一份就夠
 *
 * - **這顆 saver 本來就不耐久**（重啟就沒，見 `session-resume-doors.test.ts` 的門 B）：舊存檔點沒有「當機後回復」的價值。
 *   對話的真相是會話日誌，重開時從日誌推回來（`conversation-restore.ts`）。
 * - **照 dsh**：dsh 沒有逐步存檔點，一輪到下一輪的狀態是只增不減的會話日誌加上當下的記憶體狀態，沒有「狀態的歷史」
 *   （`packages/core/agent-loop`）。「只留最新的即時狀態」是我們在 LangGraph 上最接近的形狀。
 * - **LangGraph 讀舊存檔點的只有兩處**：`getStateHistory` 與 `replay.js`（帶 `checkpoint_id` 的重放／時間旅行），
 *   nexus 都沒有用。續行（`Command({ resume })`）、`updateState`、`getState` 讀的都是最新那一份與它的 pending writes。
 *
 * ## 它與 `durability: 'exit'` 是兩件事，要一起用
 *
 * 修剪只解決留存；`durability: 'exit'`（{@link RUN_DURABILITY}）把每輪的存檔點從約 13 份降到 1 份，
 * 每步才不必做 `seal` 的全串掃描與其他 channel 的序列化。四格對照見 #1106（量的是整串序列化時的數字）。
 *
 * ## 修剪的範圍與保護
 *
 * - **以 (thread, checkpoint_ns) 為單位**，各自留最新 {@link RETAINED_CHECKPOINTS} 份連同它們的 writes。最新者由
 *   id 的字典序決定——與 `MemorySaver.getTuple` 挑最新的方式相同。
 * - **writes 的鍵是 `MemorySaver` 內部的 `JSON.stringify([thread, ns, id])`**，沒有匯出，這裡照抄；
 *   `pruned-memory-saver.test.ts` 的有上限測試是它的絆索（鍵形狀一變，writes 就清不掉，測試當場紅）。
 * - **孤兒 writes 一併清**：`putWrites` 可以晚於下一個 `put` 到達（預設的 `async` 持久化），晚到的那批會在已被修剪的
 *   存檔點底下重新長出一把鍵，下一次修剪時掃掉。
 * - **碰到 `DeltaChannel` 就不修剪**：1.4.x 的 `DeltaChannel` 只存每步增量、靠回放祖先的 writes 重建，刪祖先會**安靜地
 *   弄壞歷史**。今天 deepagents 與 langchain 都沒有用它（`messages` 是完整累加），所以不會觸發；哪天升版之後有了，
 *   metadata 會帶 `counters_since_delta_snapshot`，這裡就退回不修剪（記憶體重新成長，但不損壞），
 *   `pruned-memory-saver.test.ts` 的「真的組裝沒有 delta 通道」會同時紅。
 * - **子代理的命名空間只修剪各自那一條鏈**：每一次 `task` 呼叫有自己的 `checkpoint_ns`，結束後不會再被讀，但這裡不認得
 *   「它結束了」，所以每個結束的子代理命名空間會殘留最新那一份。這是已知的殘餘，量級是「每次子代理呼叫一份小狀態」，
 *   不是歷史平方。
 *
 * ## 訊息不序列化（[#2116](https://github.com/DemianLi/nexus-agent/issues/2116)）
 *
 * 整串序列化的話，大日誌送第一句就把行程撐死，而這顆 saver 不耐久，序列化換不到什麼。
 * 所以存檔點的 `messages` 不進 `MemorySaver`，換成記號，活物件留在側表（pending writes 裡的訊息照舊序列化）：
 *
 * - **活物件要防就地改**：新進的訊息量過層數就深凍結，已凍結的跳過，全串只多一次 `isFrozen` 掃描。層數上限與寫進存檔點時
 *   相同（{@link CHECKPOINT_MESSAGE_WRAPPER_DEPTH}），日誌收得下的照樣收得下。
 * - **工具派工也帶整份 state**：`ReactAgent` 用 `Send` 派工具，`args` 是整份 state，進 `__pregel_tasks`，
 *   中斷或出錯時跟著存檔點落下來。不換的話工具步驟照樣序列化整串，大到超過 V8 字串上限。所以帶 `messages` 的
 *   `args` 也整份進側表。
 * - **讀回解不開就拋**：缺項不能變成空對話。`getTuple` 與 `list` 都換回，記號不漏進 channel。
 * - **最後一則 AI 給可寫副本**：langchain 的 hitl 中介層就地改它的 `tool_calls`（`agents/middleware/hitl.js:498`，langchain 1.5.10）。
 * - **側表跟著存檔點走**：修剪與刪 thread 一起收。寫入失敗不進側表，存檔點留在上一顆。
 *
 * `files` 等其他 channel 照舊序列化，層數檢查與讀回上限（#1658）都還在。
 *
 * @module
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import { MemorySaver } from '@langchain/langgraph';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import {
  CHECKPOINT_MAX_DEPTH,
  CHECKPOINT_PRECHECK_DEPTH,
  CheckpointDepthError,
  DepthCheckedSerializer,
  checkpointDepth,
} from './checkpoint-serde.js';

/** 存檔點裡換掉 `messages` 與工具派工 `args` 的記號鍵。 */
const LIVE_MARK = '__nexusLiveState';

/** 工具派工所在的 channel（`@langchain/langgraph` 的 `TASKS`，1.4.19，沒有匯出，這裡照抄）。 */
const TASKS = '__pregel_tasks';

/**
 * 一則訊息寫進存檔點時外面還有幾層：存檔點 → `channel_values` → `messages`。
 *
 * `seal` 量的是訊息自己，加回這幾層，邊界才跟量整份存檔點相同。
 */
export const CHECKPOINT_MESSAGE_WRAPPER_DEPTH = 3;

/** 工具派工的形狀，只看 `args`。 */
interface TaskLike {
  args?: Record<string, unknown>;
}

/** 工具派工換成記號之後的 `args`。 */
interface TaskMark {
  readonly [LIVE_MARK]: string;
  readonly task: number;
}

/** 迭代深凍結，訊息可以到幾百層。有元素的 TypedArray 凍不了，跳過，內容仍可改；accessor 不走。 */
function deepFreeze(root: unknown): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) continue;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || Object.isFrozen(value)) {
      continue;
    }
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && 'value' in descriptor) stack.push(descriptor.value);
    }
  }
}

/** 新進的訊息量層數並深凍結；已凍結的只看一眼就跳過。 */
function seal(messages: readonly unknown[]): void {
  for (const message of messages) {
    if (Object.isFrozen(message)) continue;
    const depth =
      checkpointDepth(message, CHECKPOINT_PRECHECK_DEPTH) + CHECKPOINT_MESSAGE_WRAPPER_DEPTH;
    if (depth > CHECKPOINT_MAX_DEPTH) throw new CheckpointDepthError(depth, CHECKPOINT_MAX_DEPTH);
    deepFreeze(message);
  }
  Object.freeze(messages);
}

/** 是不是這顆 saver 放的記號。 */
function isMark(value: unknown): value is Record<typeof LIVE_MARK, string> {
  return typeof value === 'object' && value !== null && LIVE_MARK in value;
}

/** 最後一則是 AI 就換成可寫的淺副本：hitl 中介層就地改它的 `tool_calls`。 */
function withWritableLastAi(messages: readonly unknown[]): readonly unknown[] {
  const last = messages.at(-1) as { getType?: () => string } | undefined;
  if (last?.getType?.() !== 'ai') return messages;
  const copy = Object.assign(Object.create(Object.getPrototypeOf(last) as object) as object, last);
  return [...messages.slice(0, -1), copy];
}

/** 每個 (thread, ns) 留幾份存檔點。1＝只留最新那一份；續行、`getState`、`updateState` 讀的都是它。 */
export const RETAINED_CHECKPOINTS = 1;

/**
 * 呼叫圖時傳的 `durability`：存檔點只在這一輪**結束（含中斷、出錯）**時存一份，不是每個步驟存一份。
 *
 * 平常 `exit` 的代價是「行程當掉時遺失跑到一半的進度」，對一顆不耐久的 saver 這個代價不存在。
 * 中斷與出錯照樣存（`loop.js` 的 `finishAndHandleError`），所以核准點與 `resume` 不受影響。
 */
export const RUN_DURABILITY = 'exit' as const;

/** 只留最新存檔點的 `MemorySaver`。見檔頭。 */
export class PrunedMemorySaver extends MemorySaver {
  readonly #keep: number;
  /** 存檔點鍵 → 活的 `messages`。 */
  readonly #liveMessages = new Map<string, readonly unknown[]>();
  /** 存檔點鍵 → 工具派工的 `args`，下標是記號裡的 `task`。 */
  readonly #liveTasks = new Map<string, readonly Record<string, unknown>[]>();

  /**
   * @param keep - 每個 (thread, ns) 留幾份，至少 1。
   */
  constructor(keep: number = RETAINED_CHECKPOINTS) {
    super();
    // 序列化包一層量過層數的（#1658）：基座預設的那顆寫入會吞錯、讀回有 50 層上限，見 `checkpoint-serde.ts`。
    // 包的是 `MemorySaver` 建構時自己掛的那一顆——基座沒有匯出那個類別，也不另外建一顆 saver 去拿。
    this.serde = new DepthCheckedSerializer(this.serde);
    if (!Number.isInteger(keep) || keep < 1) {
      throw new RangeError(`PrunedMemorySaver 至少要留 1 份存檔點，收到 ${String(keep)}`);
    }
    this.#keep = keep;
  }

  /**
   * @inheritdoc `messages` 與工具派工的 `args` 換成記號再存，存完之後修剪這條鏈。
   *
   * 傳進來的 `messages` 陣列與訊息就地深凍結；太深拋 {@link CheckpointDepthError}，這時存檔點與側表都不動。
   *
   * **寫不進去時收掉空的鏈**（#1658）：`MemorySaver.put` 先建好 (thread, ns) 那一格才序列化，序列化拋錯就留下一格空的，
   * 之後 `getTuple` 拿空的那格當「有存檔點」去拆，拋 `undefined is not iterable`，把原本那顆錯蓋掉。
   */
  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const thread = config.configurable?.thread_id as string;
    const namespace = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const key = checkpointKey(thread, namespace, checkpoint.id);
    const values = checkpoint.channel_values;
    const messages = values['messages'];
    const replaced: Record<string, unknown> = {};
    const carried: Record<string, unknown>[] = [];
    let saved: RunnableConfig;
    try {
      if (Array.isArray(messages)) {
        seal(messages);
        replaced['messages'] = { [LIVE_MARK]: key };
      }
      const tasks = values[TASKS];
      if (Array.isArray(tasks)) {
        replaced[TASKS] = (tasks as TaskLike[]).map((task) => {
          const list = task?.args?.['messages'];
          if (!Array.isArray(list)) return task;
          const owned = [...(list as unknown[])];
          seal(owned);
          const mark: TaskMark = {
            [LIVE_MARK]: key,
            task: carried.push({ ...task.args, messages: owned }) - 1,
          };
          return Object.assign(
            Object.create(Object.getPrototypeOf(task) as object) as object,
            task,
            {
              args: mark,
            },
          );
        });
      }
      const stored = { ...checkpoint, channel_values: { ...values, ...replaced } };
      saved = await super.put(config, stored, metadata);
      if ('messages' in replaced) this.#liveMessages.set(key, messages as unknown[]);
      if (carried.length > 0) this.#liveTasks.set(key, carried);
    } catch (error) {
      const chain = this.storage[thread]?.[namespace];
      if (chain !== undefined && Object.keys(chain).length === 0) {
        delete this.storage[thread]![namespace];
        if (Object.keys(this.storage[thread]!).length === 0) delete this.storage[thread];
      }
      throw error;
    }
    if (!hasDeltaChannel(metadata)) this.#prune(thread, namespace);
    return saved;
  }

  /** 側表裡有幾份存檔點的活物件。 */
  get liveCheckpoints(): number {
    return new Set([...this.#liveMessages.keys(), ...this.#liveTasks.keys()]).size;
  }

  /** @inheritdoc 記號換回活物件：訊息是深凍結的同一份，最後一則 AI 是可寫的淺副本；側表缺項就 reject。 */
  override async getTuple(config: RunnableConfig) {
    return this.#reveal(await super.getTuple(config));
  }

  /** @inheritdoc 同 {@link getTuple}。 */
  override async *list(config: RunnableConfig, options?: Parameters<MemorySaver['list']>[1]) {
    for await (const tuple of super.list(config, options)) yield this.#reveal(tuple);
  }

  /** @inheritdoc 側表一起收。 */
  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    for (const table of [this.#liveMessages, this.#liveTasks]) {
      for (const key of table.keys()) {
        if ((JSON.parse(key) as string[])[0] === threadId) table.delete(key);
      }
    }
  }

  /** 把讀回來的那一份裡的記號換回活物件。解不開就拋，不能變成空對話。 */
  #reveal<T extends { checkpoint: Checkpoint } | undefined>(tuple: T): T {
    if (tuple === undefined) return tuple;
    const values = tuple.checkpoint.channel_values;
    const tasks = values[TASKS];
    if (Array.isArray(tasks)) {
      for (const task of tasks as TaskLike[]) {
        const mark = task?.args as (TaskMark & Record<string, unknown>) | undefined;
        if (!isMark(mark)) continue;
        const args = this.#liveTasks.get(mark[LIVE_MARK])?.[mark.task];
        if (args === undefined) throw new Error(`工具派工不在側表：${mark[LIVE_MARK]}`);
        task.args = { ...args };
      }
    }
    const mark = values['messages'];
    if (!isMark(mark)) return tuple;
    const live = this.#liveMessages.get(mark[LIVE_MARK]);
    if (live === undefined) throw new Error(`存檔點的訊息不在側表：${mark[LIVE_MARK]}`);
    values['messages'] = withWritableLastAi(live);
    return tuple;
  }

  /** 這條鏈只留最新 `#keep` 份，再掃掉這條鏈上沒有存檔點可掛的 writes。 */
  #prune(thread: string, namespace: string): void {
    const chain = this.storage[thread]?.[namespace];
    if (chain === undefined) return;
    const newestFirst = Object.keys(chain).sort((a, b) => b.localeCompare(a));
    for (const id of newestFirst.slice(this.#keep)) {
      delete chain[id];
      delete this.writes[writesKey(thread, namespace, id)];
      const key = checkpointKey(thread, namespace, id);
      this.#liveMessages.delete(key);
      this.#liveTasks.delete(key);
    }
    // 孤兒：key 指向這條鏈上已經不在的存檔點。
    for (const key of Object.keys(this.writes)) {
      const [keyThread, keyNamespace, id] = JSON.parse(key) as [string, string, string];
      if (keyThread === thread && keyNamespace === namespace && chain[id] === undefined) {
        delete this.writes[key];
      }
    }
  }
}

/** 側表的鍵。 */
function checkpointKey(thread: string, namespace: string, id: string): string {
  return JSON.stringify([thread, namespace, id]);
}

/** `MemorySaver` 內部 writes 的鍵（`_generateKey`，沒有匯出）。 */
function writesKey(thread: string, namespace: string, id: string): string {
  return JSON.stringify([thread, namespace, id]);
}

/** 存檔點的 metadata 帶 delta 通道的計數器＝有通道靠祖先回放重建，不能刪祖先。 */
function hasDeltaChannel(metadata: CheckpointMetadata): boolean {
  return (
    (metadata as { counters_since_delta_snapshot?: unknown }).counters_since_delta_snapshot !==
    undefined
  );
}
