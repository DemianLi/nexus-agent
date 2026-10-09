/**
 * 送出佇列上線的形狀（[#637](https://github.com/DemianLi/nexus-agent/issues/637)、
 * [#710](https://github.com/DemianLi/nexus-agent/issues/710)）。
 *
 * 照 dsh 的收件匣投影（key `inbox`，`packages/core/agent-loop/src/inbox.ts`，`477b4f4`）：人送出、還沒送進模型的那幾句，
 * 從會話日誌的 `inbox/spliced` 折出來，**從日誌開頭折起**——它不會在一輪開頭清空。兩條清單同 dsh：排著等開新一輪的
 * （{@link InboxPayload.items}，dsh 的 `next-turn`）與插話（{@link InboxPayload.nextStep}，dsh 的 `next-step`）。
 *
 * 載體是協定的 `custom` 事件，`data.name` 是 {@link INBOX}，`payload` 是 {@link InboxPayload}，後到的取代先到的：
 *
 * - **即時**：pump 每次佇列變動送一顆，帶整份清單。送出（閒著時也一樣）、領走開跑、改、刪各一顆。
 * - **歷史**：到 `throughSeq` 為止日誌上出現過佇列的變動，就送一顆**目前的**清單（空的也送），放在最新一頁；一顆變動
 *   都沒有就不送。
 *
 * ## 開跑那一刻：`claimed`
 *
 * 人送出的話一律先進佇列，**畫面在送出那一刻不畫人的泡泡**，等它被領走開跑才畫，而且用開跑用的那份文字（改過的就是
 * 改過的）。清單少一件分不出是開跑了還是被刪了（刪可能是別的分頁按的），所以領走那一顆多帶 {@link InboxPayload.claimed}。
 * 它一定比那一輪模型與工具的任何 frame（`messages`、`tools`、`lifecycle`）先到、走同一條下行：pump 在 `turn/start` 之後、
 * 叫模型之前就寫下領走那一顆，而寫入的當下就同步送出。**排在它前面的只有 pump 看到 `turn/start` 就合成的 `custom`**
 * （開新一輪時清空的待辦清單），同 dsh 的先後：`turn/start` 先落、投影先更新，`preStep` 才領走。
 *
 * **對 dsh 的偏離**：dsh 把「領走」與「丟掉」分成兩種通知（`agent/inbox/claimed`、`agent/inbox/discarded`），投影本身只有
 * 清單。我們沒有投影與通知兩層，只有 pump 合成的 `custom` 事件（同 #575 的待辦清單），所以把領走併進同一顆：清單少一件與
 * 人的泡泡出現是同一件事，拆成兩顆的話中間會有一瞬間兩邊對不上。丟掉的那一種不需要：換掉清單就夠了。
 *
 * ## 插話被領走那一刻：`claimedNextStep`
 *
 * 跑著的那一輪每次叫模型之前領走整條插話，同 `claimed` 的理由多帶 {@link InboxPayload.claimedNextStep}：畫面據它在
 * 那一輪裡接著畫人的泡泡。它一定比那次模型呼叫的任何 frame 先到：pump 在叫模型之前寫下領走那一顆，寫入的當下就同步送出。
 *
 * **對 dsh 的偏離**：dsh 的投影 key 就是兩條清單的名字（`'next-turn'`、`'next-step'`）。我們的 `items` 在插話之前就上線
 * 了，改名會讓舊的畫面讀不到佇列，所以 `items` 留著當 `next-turn`，插話那一條另起一格。
 *
 * @module
 */

import type { WireAttachmentRef } from './attachments.js';
import type { SubagentMention } from './subagent-list.js';

/** `custom` 事件的 `data.name`：送出佇列現在是這一份。 */
export const INBOX = 'inbox';

/**
 * `custom` 事件的 `data.name`：**歷史重播用**的「這裡有一則背景子代理結算通知」（[#851](https://github.com/DemianLi/nexus-agent/issues/851)）。
 * 即時的畫面由 {@link INBOX} 的 `claimed`／`claimedNextStep` 長同一格（`id` 是 `inbox:<件的 id>`）；歷史沒有送出佇列，
 * 由這一顆長，`id` 是 `history-<seq>`。兩邊長出的是同一種 entry、落在同一個位置（通知叫醒的那一輪的開頭，或輪中插進來的那一刻）。
 */
export const SETTLE_NOTICE = 'subagent/settle-notice';

/**
 * `custom` 事件的 `data.name`：**歷史重播用**的「背景子代理寫來一則話」（[#863](https://github.com/DemianLi/nexus-agent/issues/863)）。
 * 即時的畫面由 {@link INBOX} 的 `claimed`／`claimedNextStep`（`source.kind === 'agent-message'`）長同一格
 * （`id` 是 `inbox:<件的 id>`）；歷史沒有送出佇列，由這一顆長，`id` 是 `history-<seq>`。
 */
export const AGENT_MESSAGE = 'subagent/agent-message';

/** {@link AGENT_MESSAGE} 的 `payload`。 */
export interface AgentMessagePayload {
  /** 那一格 entry 的 `id`，也是去重的鍵。 */
  readonly id: string;
  /** 寄件的背景子代理的會話 id。 */
  readonly senderSessionId: string;
  /** 它的編號，對得上委派卡（`background-subagent` 的 `runId`）。 */
  readonly runId: string;
  /** 它寫的話，**已拿掉給模型看的 `Agent <寄件人> sent a message: ` 前綴**。 */
  readonly text: string;
}

/**
 * 一個背景子代理怎麼收的（[#884](https://github.com/DemianLi/nexus-agent/issues/884)）：結算通知的原因，五種。
 * 畫面據它配字，**不解析給模型看的英文句**。與 `@nexus/core` 的 `SubagentSettleReason` 同一組（harness 有測試釘住兩邊一致）。
 */
export const SETTLE_REASONS = ['completed', 'aborted', 'max-tokens', 'error', 'refusal'] as const;

/** {@link SETTLE_REASONS} 的一員。 */
export type WireSettleReason = (typeof SETTLE_REASONS)[number];

/** 讀到的值是不是認得的結算原因。不認得（舊的一側、壞資料）一律當作沒有，畫面退成中性的說法。 */
export function isSettleReason(value: unknown): value is WireSettleReason {
  return SETTLE_REASONS.some((reason) => reason === value);
}

/** {@link SETTLE_NOTICE} 的 `payload`。 */
export interface SettleNoticePayload {
  /** 那一格 entry 的 `id`，也是去重的鍵：同一個 `id` 第二次出現就忽略。 */
  readonly id: string;
  /** 怎麼收的（#884）。選填：格式 26 以前的日誌沒有，畫面退成中性的說法。 */
  readonly reason?: WireSettleReason;
}

/**
 * 排著的一件。結構上是 `@nexus/core` 的 `QueuedInput`，這裡另寫一份。命令與回饋的詞彙已改成 core 的別名
 * （[#683](https://github.com/DemianLi/nexus-agent/issues/683)，見 `protocol.ts` 的 `SlashDescriptor`）；這一組還沒，
 * 型別歸屬見 [#679](https://github.com/DemianLi/nexus-agent/issues/679)。
 */
export interface WireQueuedInput {
  /** 就是送出時 `run.start` 回的 `run_id`：畫面拿它對上自己送出的那一句。改過之後不變。 */
  readonly id: string;
  readonly text: string;
  /**
   * 誰送的。人、背景子代理結算的通知（#840：執行期的記帳，不是人說的話），或目標續行的預約（#638）。
   * 只放判別欄與結算通知的原因，摘要與寄件人留在日誌上。
   */
  readonly source: WireQueuedInputSource;
  /** 這一件帶的附件（[#732](https://github.com/DemianLi/nexus-agent/issues/732)），照選取順序，只放參照。沒有就不給這一格。 */
  readonly attachments?: readonly WireAttachmentRef[];
  /** 這一件點名派哪一個子代理（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）。沒有就不給這一格。 */
  readonly mention?: SubagentMention;
}

/** {@link WireQueuedInput.source}：判別欄，加結算通知的原因（#884）；摘要與寄件人留在日誌上。 */
export type WireQueuedInputSource =
  | { readonly kind: 'user' }
  | {
      readonly kind: 'subagent-settled';
      /** 怎麼收的（#884）：排隊中那一行與開跑之後的通知畫同一句。選填，舊日誌沒有。 */
      readonly reason?: WireSettleReason;
    }
  | { readonly kind: 'agent-message' }
  | {
      /**
       * 目標續行排在佇列上的預約（[#638](https://github.com/DemianLi/nexus-agent/issues/638)）：排程器放的，不是人說的話。
       * 只放判別欄，目標編號與輪數留在日誌上。**刪掉它＝暫停目標**，不是跳過這一輪；改它的文字等同刪掉
       * （預約的文字必須逐字等於目前目標的續行提示詞，改過的就不是那一輪了），見 `thread-pump.ts` 的 `updateQueue`。
       */
      readonly kind: 'goal';
    }
  | {
      /**
       * 折疊器不認得的來源種類（比如新版 harness 加了一種、這一側還沒跟上）。**照 dsh 的做法收下**：dsh 的 client 不驗佇列件的
       * 來源種類，`MessageSource` 是可合併擴充的聯集、「consumers fall through unknown kinds」（`packages/llm/llm/src/message.ts`），
       * `ui-chat` 的 inbox 節點只比對 `=== 'user'`。所以這一件**照列、當成非人的件**，不丟那一件、不丟整份。
       * 畫面用通用標籤，不給插話鈕（它不是人說的話，也不知道能不能轉成插話）。
       */
      readonly kind: 'unrecognized';
      /** 線上實際送來的那個種類。 */
      readonly original: string;
    };

/** 一句話裡 `@` 的一條會話（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）：`text` 裡對應的那段是 `@<label>`。 */
export interface WireSessionReference {
  readonly sessionId: string;
  readonly label: string;
}

/** 被領走的一件：畫面據它畫人的泡泡。 */
export interface WireClaimedInput {
  readonly id: string;
  /**
   * 人話。**`@` 了別的會話的話，引用網址已經換成 `@標題`**（伺服器在準備那一步換的）；排著的那份
   * （{@link WireQueuedInput}）仍是使用者打的原文。
   */
  readonly text: string;
  /** 這句話 `@` 的會話，照出現先後、去重。沒有引用就不給這一格（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）。 */
  readonly references?: readonly WireSessionReference[];
  /** 這句話帶的附件（#732），照選取順序，只放參照；畫面據它在人的泡泡上畫附件列。沒有就不給這一格。 */
  readonly attachments?: readonly WireAttachmentRef[];
  /** 這句話點名派哪一個子代理（#328 第 2 項）；畫面據它在人的泡泡上畫點名的標記。沒有就不給這一格。 */
  readonly mention?: SubagentMention;
  /**
   * 這一件不是人送的時才帶（#840、#849）：`subagent-settled` 是背景子代理結算的通知，`agent-message` 是背景子代理用 `send_message` 寫來的話。**沒帶就是人**，舊的一側照舊。
   * 有帶的不畫人的泡泡——那是執行期的記帳，不是使用者說的話；`subagent-settled` 長 `NoticeEntry`（#851），`agent-message`
   * 長 `AgentMessageEntry`（#863），畫成什麼樣是 web 的事。
   */
  readonly source?: WireClaimedSource;
}

/**
 * {@link WireClaimedInput.source}：不是人送的來源。`agent-message` 多帶寄件人（[#863](https://github.com/DemianLi/nexus-agent/issues/863)），
 * 畫面據它畫「某某子代理說：…」；它的 `text` 已拿掉給模型看的英文前綴。
 */
export type WireClaimedSource =
  | {
      readonly kind: 'subagent-settled';
      /** 怎麼收的（#884），同 {@link WireQueuedInputSource}。選填，舊日誌沒有。 */
      readonly reason?: WireSettleReason;
    }
  | {
      readonly kind: 'agent-message';
      readonly senderSessionId: string;
      /** 寄件的背景子代理的編號。 */
      readonly runId: string;
    }
  | {
      /**
       * 目標續行的預約開跑了（[#638](https://github.com/DemianLi/nexus-agent/issues/638)）。**畫面不為它長任何一格**
       * （reducer 跳過）：續行的提示詞是給模型的，不是人說的話；沒有這個判別欄的話，舊的一側會把「認得的來源之外的一律當成人畫」，
       * 一大段續行提示詞變成人的泡泡。
       */
      readonly kind: 'goal';
    };
// 被領走的件若是不認得的來源，折疊器同樣不畫人的泡泡（見 {@link WireQueuedInputSource} 的 `unrecognized`），所以這裡沒有對應的成員。

/** {@link INBOX} 的 `payload`。 */
export interface InboxPayload {
  /** 排著等開新一輪的整份清單（`next-turn`），照開跑的先後。 */
  readonly items: readonly WireQueuedInput[];
  /**
   * 插話的整份清單（`next-step`），照送出的先後：跑著的那一輪下一步整條送進模型。**選填只為了舊的一側**：
   * harness 每一顆都帶（空的也帶），沒帶就當空的。
   */
  readonly nextStep?: readonly WireQueuedInput[];
  /**
   * 這一顆是因為這一件被領走開跑而送的：畫面據它畫人的泡泡。**只有領走那一顆帶**，送出、改、刪都不帶；歷史也不帶
   * （人的泡泡在歷史裡由那一輪的 human 訊息畫）。
   */
  readonly claimed?: WireClaimedInput;
  /**
   * 這一顆是因為整條插話被領走、送進模型而送的：畫面據它在這一輪裡接著畫人的泡泡，照送出的先後。規則同
   * {@link claimed}：只有領走那一顆帶，歷史也不帶（歷史裡由那幾則 human 訊息畫）。
   */
  readonly claimedNextStep?: readonly WireClaimedInput[];
}

// 名字→酬載表（#685）上屬於這個檔的格子，見 `custom-frame.ts`。
declare module './custom-frame.js' {
  interface CustomFramePayloads {
    [INBOX]: InboxPayload;
    [SETTLE_NOTICE]: SettleNoticePayload;
    [AGENT_MESSAGE]: AgentMessagePayload;
  }
}
