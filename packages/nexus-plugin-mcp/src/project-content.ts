/**
 * MCP 工具結果裡的非文字塊換成文字說明——[#642](https://github.com/DemianLi/nexus-agent/issues/642)。
 *
 * `@langchain/mcp-adapters` 把 MCP 的 `image` 轉成 `image` 塊（1.x 是 `image_url`，2.0.0 起帶 `data`／`mimeType`）、`audio` 轉成 `audio` 塊、
 * `resource_link` 轉成 `file` 塊（`dist/content.js` 的 `convertCallToolResult`），原樣放進 ToolMessage 的 content。模型那一側的工具訊息只收文字：NVIDIA 對
 * `role: tool` 裡的 `image_url` 回 400（實測），而那則工具結果已經進了 state，同一條 thread 之後每一輪都 400。
 *
 * 照 dsh 的 `projectContent`（`packages/mcp/mcp-client/src/tools.ts:376-505`，`477b4f4`）：收不下的圖換成
 * `[image unavailable: <mime>; <reason>]`，沒有附件儲存時 reason 是 `no attachment store is mounted`；音訊、
 * resource link、不認得的類型也各換成一段文字。文字塊原樣保留，順序不變。
 *
 * **resource link 照 dsh 寫成 `Resource link: <name> (<uri>)`**（[#1319](https://github.com/DemianLi/nexus-agent/issues/1319)）。
 * `@langchain/mcp-adapters` 2.0.0 轉成 `file` 塊時，`metadata` 帶著 `{uri, name, title?}`（`dist/content.js` 的
 * `resource_link` 分支），所以 #642 當時登記的「adapter 丟了 name」已經不成立，名稱補回來了。缺名稱或 URI 時的退路與
 * dsh 同一句：`[resource link unavailable: the MCP block is missing its name or URI]`。
 *
 * **偏離**（dsh 表達得出來、我們這裡表達不出來的兩處；加上下面一條超出 dsh 的）：
 *
 * - **拿掉 `raw … data remains available to programmatic callers` 那一句**。dsh 把原始值留給程式呼叫端；我們
 *   留的話只能放進 ToolMessage 的 `artifact`，而它會跟著訊息進會話日誌（`toLoggedMessage` 帶 `artifact`）。
 *   **實測（#1320）修正了先前的說法**：圖片根本不在 adapter 的 `artifact` 裡（換成文字說明之後日誌只有幾百位元組），
 *   會整份進日誌的是**內嵌資源與 `structuredContent`**——3 MB 的資源就是 3 MB 的 `tool/result`。所以原始值今天仍然
 *   不留給程式呼叫端，那一句仍然不是真的；artifact 的上限處理見 `artifact-bound.ts`（{@link boundArtifacts}），實測表也在那裡。
 * - **不併相鄰的文字**：dsh 把連續的文字（連同音訊、resource link 的說明）用換行併成一塊，我們每塊換成各自一塊
 *   文字、其餘原樣。只有文字的結果照舊不碰。
 * - **超出 dsh：結果含 resource link 時，結尾多一塊引用提示**（{@link CITE_RESOURCE_LINKS}）。dsh 只對
 *   `web_search`／`web_fetch` 要求引用（`packages/web/tool-web/src/search.ts:92` 的結果結尾
 *   `Cite the relevant URLs above as markdown links in your answer.`），MCP 沒有。我們的 web 搜尋判過不做（T-10），
 *   內部資料全走 MCP，而產品定位（[#949](https://github.com/DemianLi/nexus-agent/issues/949)）需要讓使用者知道答案出自
 *   哪裡，所以把 dsh 的同一個做法移到 MCP：觸發條件與措辭比照 `search.ts`，差別有兩個——只有**真的帶了連結**的結果才加
 *   （沒有連結的呼叫不加，免得每次 MCP 呼叫都多一句雜訊）；措辭是「resource links」而不是「URLs」，因為 MCP 的 URI 不一定是
 *   http。系統提示詞那一半在 `hub.ts` 的 {@link hubPromptText}。
 */

/**
 * 結果含 resource link 時接在結尾的一句，比照 dsh `search.ts:92`（`Cite the relevant URLs above as markdown links in your
 * answer.`），措辭改成 resource links——MCP 的 URI 不一定是 URL。
 */
export const CITE_RESOURCE_LINKS =
  'Cite the relevant resource links above as markdown links in your answer.';

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
  /** adapter 2.0.0 的 `resource_link` 帶 `{uri, name, title?}`；內嵌的二進位資源只帶 `{uri}`。 */
  readonly metadata?: unknown;
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
  const projected: unknown[] = blocks.map((block) =>
    isText(block) ? block : { type: 'text', text: describe(block) },
  );
  // 只有真的拼得出 `Resource link: …` 的才算有連結；缺名稱或 URI 的那句說明不是可以引用的東西。
  if (blocks.some((block) => resourceLink(block) !== undefined)) {
    projected.push({ type: 'text', text: CITE_RESOURCE_LINKS });
  }
  return projected as T[];
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
    case 'file': {
      if (!isResourceLink(block)) return '[embedded resource unsupported]';
      const link = resourceLink(block);
      return link === undefined
        ? '[resource link unavailable: the MCP block is missing its name or URI]'
        : `Resource link: ${link.name} (${link.uri})`;
    }
    default:
      return `[unsupported MCP content type: ${String(block.type)}]`;
  }
}

/**
 * 是不是 MCP 的 `resource_link` 轉出來的 `file` 塊。adapter 的 `resource_link` 分支一定帶 `url`，且 `metadata` 一定有 `name`
 * 這個鍵（值可能是 `undefined`）；內嵌的二進位資源是 `data` 加 `metadata: {uri}`，沒有這兩樣。
 */
function isResourceLink(block: Block): boolean {
  return typeof block.url === 'string' || (isRecord(block.metadata) && 'name' in block.metadata);
}

/** 名稱與 URI 都拿得到才回；URI 先看 `url`，再看 `metadata.uri`。 */
function resourceLink(block: Block): { name: string; uri: string } | undefined {
  if (block.type !== 'file' || !isResourceLink(block)) return undefined;
  const metadata = isRecord(block.metadata) ? block.metadata : {};
  const uri = typeof block.url === 'string' ? block.url : metadata['uri'];
  const name = metadata['name'];
  return typeof name === 'string' && typeof uri === 'string' ? { name, uri } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
