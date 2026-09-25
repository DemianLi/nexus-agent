/**
 * MCP 工具結果裡的非文字塊換成文字說明——[#642](https://github.com/DemianLi/nexus-agent/issues/642)。
 *
 * `@langchain/mcp-adapters` 把 MCP 的 `image` 轉成 `image_url` 塊、`audio` 轉成 `audio` 塊、`resource_link` 轉成
 * `file` 塊（`dist/tools.js:247-283`），原樣放進 ToolMessage 的 content。模型那一側的工具訊息只收文字：NVIDIA 對
 * `role: tool` 裡的 `image_url` 回 400（實測），而那則工具結果已經進了 state，同一條 thread 之後每一輪都 400。
 *
 * 照 dsh 的 `projectContent`（`packages/mcp/mcp-client/src/tools.ts:376-505`，`477b4f4`）：收不下的圖換成
 * `[image unavailable: <mime>; <reason>]`，沒有附件儲存時 reason 是 `no attachment store is mounted`；音訊、
 * resource link、不認得的類型也各換成一段文字。文字塊原樣保留，順序不變。
 *
 * **偏離**（dsh 表達得出來、我們這裡表達不出來的三處）：
 *
 * - **拿掉 `raw … data remains available to programmatic callers` 那一句**。dsh 把原始值留給程式呼叫端；我們
 *   留的話只能放進 ToolMessage 的 `artifact`，而它會跟著訊息進會話日誌（`toLoggedMessage` 帶 `artifact`），一張圖
 *   就是幾 MB。不留，那一句就不是真的。
 * - **resource link 只講 URI**：adapter 轉成 `file` 塊時丟了 MCP 的 `name`，dsh 的 `Resource link: <name> (<uri>)`
 *   拼不出來。
 * - **不併相鄰的文字**：dsh 把連續的文字（連同音訊、resource link 的說明）用換行併成一塊，我們每塊換成各自一塊
 *   文字、其餘原樣。只有文字的結果照舊不碰。
 */

/** 沒有附件儲存時，dsh 給收不下的圖的原因。 */
export const NO_ATTACHMENT_STORE = 'no attachment store is mounted';

/** content 裡的一塊。adapter 的型別是 LangChain 的內容塊聯集，這裡只讀得到的那幾個欄位。 */
interface Block {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly image_url?: unknown;
  readonly url?: unknown;
  readonly mime_type?: unknown;
  readonly mimeType?: unknown;
}

/**
 * 有非文字塊就回換過的 content，沒有就回 `undefined`（照原樣）。
 *
 * @param content - adapter 正規化過的 content：字串，或內容塊陣列。
 * @returns 每一塊非文字都換成文字說明的新陣列，或 `undefined`。
 */
export function projectNonText<T>(content: string | readonly T[]): T[] | undefined {
  if (typeof content === 'string') return undefined;
  const blocks = content as readonly Block[];
  if (blocks.every(isText)) return undefined;
  return blocks.map((block) =>
    isText(block) ? block : { type: 'text', text: describe(block) },
  ) as T[];
}

function isText(block: Block): boolean {
  return block.type === 'text' && typeof block.text === 'string';
}

/** 一塊非文字的說明。 */
function describe(block: Block): string {
  switch (block.type) {
    case 'image':
    case 'image_url':
      return `[image unavailable: ${imageMediaType(block)}; ${NO_ATTACHMENT_STORE}]`;
    case 'audio':
      return `[audio result unsupported: ${mediaType(block)}]`;
    case 'file':
      return typeof block.url === 'string'
        ? `Resource link: ${block.url}`
        : '[embedded resource unsupported]';
    default:
      return `[unsupported MCP content type: ${String(block.type)}]`;
  }
}

function mediaType(block: Block): string {
  const value = block.mime_type ?? block.mimeType;
  return typeof value === 'string' && value !== '' ? value : 'unknown media type';
}

/** `image_url` 的 MIME 在 data URL 裡（adapter 拼成 `data:<mime>;base64,…`）。 */
function imageMediaType(block: Block): string {
  if (block.type !== 'image_url') return mediaType(block);
  const url =
    typeof block.image_url === 'string'
      ? block.image_url
      : (block.image_url as { url?: unknown } | undefined)?.url;
  const match = typeof url === 'string' ? /^data:([^;,]+)[;,]/.exec(url) : null;
  return match?.[1] ?? 'unknown media type';
}
