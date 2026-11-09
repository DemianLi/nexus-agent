/**
 * 使用者在一句話裡點名派哪一個子代理（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）。
 *
 * ## 與 dsh 的關係：dsh 沒有，為什麼做
 *
 * dsh 沒有使用者直接派工的入口——派子代理的只有模型。做它的理由是 demian 2026-10-08 的指示：Claude Code 允許使用者在對話裡
 * `@` 某個子代理。我們選的形狀是**不開新的執行路徑**：點名只是多一段給模型看的字，由模型自己去叫委派工具，
 * 派不派、怎麼派仍走原本的 `task`（與 `subagent`）工具與它們的所有規則（核准、模型選擇、深度）。理由：另開一條「使用者直接派工」的路，
 * 這些規則都得再實作一遍，而且派出去的子代理沒有父代理的上下文可以交代。
 *
 * ## 載體：內容裡的一個文字區塊
 *
 * 點名在日誌上是 `turn/start`（`kind: 'message'`）與佇列項（`QueuedInput`）的選填 `mention`；送進模型的 `HumanMessage` 由
 * `userContent` 在**使用者那句話之後**接一個文字區塊（{@link mentionHintText}）。live 與重放共用同一個造法，續接之後同一個位置的
 * 訊息逐位元組相同；提示裡的工具名也從日誌上的 `mention.tool` 讀，不看重放當下的組裝。
 *
 * 選這個載體而不是 `additional_kwargs` 加組請求時的投影：附件的投影（`attachment-projection.ts`）只在真模型那一層，
 * 腳本模型與沒帶 `--live` 的組裝看不到；而點名要的只是一段固定的字，不需要讀儲存。代價是歷史、搜尋這些讀訊息文字的地方會讀到這一段，
 * 所以 {@link isMentionHintBlock} 讓歷史與 `thread.search` 把它認出來、剝掉，歷史並從它讀回點名（插話那條路沒有 `turn/start`，只有訊息）。
 *
 * @module
 */

/** 這個檔定義的點名：目前只有子代理；判別式留著，別種點名（例如技能）是向後相容的。 */
export interface SubagentMentionRef {
  readonly kind: 'subagent';
  /** 註冊的子代理名字，就是委派工具的 `subagent_type`。 */
  readonly name: string;
  /**
   * 收下這句話時 root 手上的委派工具，提示照它組字（[#2649](https://github.com/DemianLi/nexus-agent/issues/2649)）。
   * 記在日誌上，重放才組得出同一段字；格式 56 起才有。缺席（56 以前的日誌、沒給委派工具的組裝、從 `task` 的提示字讀回）照 `task` 的字組。
   */
  readonly tool?: DelegationToolName;
}

/**
 * root 委派子代理用的工具：一次性模式是基座的 `task`；背景續行模式模型手上只有 `subagent`（`task` 被藏起來，見
 * `apps/harness` 的 `background-delegation.ts`）。兩者的 `subagent_type` 同名同義。
 */
export type DelegationToolName = 'task' | 'subagent';

const HINT_OPEN = '<system-reminder>使用者點名要你把這句話交給子代理 ';
const HINT_NAME_TAIL = '處理：';

/** 依序是 {@link mentionHintText} 會組出的每一種字；讀回時逐一比對。 */
const HINT_TOOLS: readonly (DelegationToolName | undefined)[] = [undefined, 'subagent'];

/**
 * 給模型看的那一段。**字固定，名字用 JSON 字串**（引號、斜線都跳脫），所以 {@link mentionOfHintBlock} 能原樣讀回。
 *
 * 工具名照 {@link SubagentMentionRef.tool}：`subagent` 寫 `subagent`；`task` 與缺席寫 `task`，字跟這一格出現以前逐位元組相同，
 * 所以舊日誌重放出來的仍是當初送出的那一段。
 */
export function mentionHintText(mention: SubagentMentionRef): string {
  const tool = mention.tool ?? 'task';
  return (
    `${HINT_OPEN}${JSON.stringify(mention.name)} ${HINT_NAME_TAIL}` +
    `請用委派工具（${tool} 的 subagent_type 填這個名字）把這句話派給它，並把它需要的背景一併交代。</system-reminder>`
  );
}

/** 一句話加上點名之後，接在後面的那個文字區塊。 */
export function mentionHintBlock(mention: SubagentMentionRef): {
  readonly type: 'text';
  readonly text: string;
} {
  return { type: 'text', text: mentionHintText(mention) };
}

/**
 * 這個內容區塊是不是 {@link mentionHintBlock} 造的，是的話讀回點名。**整段字都要對上**其中一種工具的字才算，使用者自己打的字不會被誤認
 * （他的字是另一個區塊，而且要逐字相同才會中——中了也只是這一則的泡泡少一段他自己打的假提醒）。
 *
 * 讀回的 `tool` 只在字分得出來時才有：`task` 與缺席組出同一段字，讀回時不帶這一格。
 */
export function mentionOfHintBlock(block: unknown): SubagentMentionRef | undefined {
  const text = (block as { type?: unknown; text?: unknown } | null)?.text;
  if ((block as { type?: unknown } | null)?.type !== 'text' || typeof text !== 'string') {
    return undefined;
  }
  if (!text.startsWith(HINT_OPEN)) return undefined;
  const match = /^"(?:[^"\\]|\\.)*"/u.exec(text.slice(HINT_OPEN.length));
  if (match === null) return undefined;
  let name: unknown;
  try {
    name = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (typeof name !== 'string') return undefined;
  for (const tool of HINT_TOOLS) {
    const mention: SubagentMentionRef = {
      kind: 'subagent',
      name,
      ...(tool !== undefined && { tool }),
    };
    if (text === mentionHintText(mention)) return mention;
  }
  return undefined;
}

/** {@link mentionOfHintBlock} 認得的區塊。 */
export function isMentionHintBlock(block: unknown): boolean {
  return mentionOfHintBlock(block) !== undefined;
}
