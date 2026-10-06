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
 * 修剪只解決記憶體；每個步驟仍會把整段歷史序列化一次，CPU 照樣隨輪數變長。`durability: 'exit'`
 * （{@link RUN_DURABILITY}）把每輪的存檔點從約 13 份降到 1 份，才是 CPU 那一半。四格對照見 #1106。
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
 * @module
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import { MemorySaver } from '@langchain/langgraph';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

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

  /**
   * @param keep - 每個 (thread, ns) 留幾份，至少 1。
   */
  constructor(keep: number = RETAINED_CHECKPOINTS) {
    super();
    if (!Number.isInteger(keep) || keep < 1) {
      throw new RangeError(`PrunedMemorySaver 至少要留 1 份存檔點，收到 ${String(keep)}`);
    }
    this.#keep = keep;
  }

  /** @inheritdoc 存完之後修剪這條鏈。 */
  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const saved = await super.put(config, checkpoint, metadata);
    if (!hasDeltaChannel(metadata)) {
      const thread = config.configurable?.thread_id as string;
      const namespace = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
      this.#prune(thread, namespace);
    }
    return saved;
  }

  /** 這條鏈只留最新 `#keep` 份，再掃掉這條鏈上沒有存檔點可掛的 writes。 */
  #prune(thread: string, namespace: string): void {
    const chain = this.storage[thread]?.[namespace];
    if (chain === undefined) return;
    const newestFirst = Object.keys(chain).sort((a, b) => b.localeCompare(a));
    for (const id of newestFirst.slice(this.#keep)) {
      delete chain[id];
      delete this.writes[writesKey(thread, namespace, id)];
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
