/**
 * 附件的參照與它們在訊息裡的樣子（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。
 *
 * 位元組存在會話日誌與存檔點之外（`apps/harness` 的 `attachment-store.ts`，內容定址），訊息與日誌**只留參照**。這一支只放
 * 「參照長什麼樣、訊息裡的區塊長什麼樣、檔案給模型的那一行字」：不碰檔案系統，所以 token 估算與日誌折疊都能用。
 *
 * ## 照 dsh 的部分（`packages/attachment/attachment/src/types.ts`、`packages/llm/llm/src/content.ts`，`5badb150`）
 *
 * - 參照：`{ attachmentId, name, bytes }`（檔案）、`{ attachmentId, mediaType, bytes, width, height, name? }`（圖）。
 * - 訊息裡的區塊：`{ type: 'file', attachment }`、`{ type: 'image', attachment }`。
 * - **檔案從不以位元組到達任何供應商**：組請求時每個檔案區塊換成確定性的一行（{@link fileHandleText}），模型要讀就用檔案工具
 *   讀存下來的唯讀副本。
 *
 * ## 偏離（依 AGENTS.md 登記）
 *
 * 1. **區塊型別叫 `nexus-file`／`nexus-image`，不叫 `file`／`image`。** LangChain 的訊息塊自己有標準的 `file`／`image`（欄位不同），
 *    我們的區塊裝不進去，也不能讓基座或 `@langchain/openai` 把它當成它認得的那一種。形狀照 dsh（`{ type, attachment }`），
 *    只有型別名不同。基座表達不出 dsh 的 `ImageBlock`／`FileBlock`，所以退到自己的區塊型別。
 * 2. **圖的壓縮與正規化沒做**：見 `attachment-store.ts` 檔頭。
 *
 * @module
 */

/** 模型讀附件的虛擬前綴（沒有結尾斜線）。路由由組裝點掛上，見 `apps/harness/src/agent-factory.ts`。 */
export const ATTACHMENTS_MODEL_PREFIX = '/attachments';

/**
 * 一張圖估多少 token。**量到的**：`meta/llama-3.2-11b-vision-instruct` 上，帶圖那一格的 `prompt_tokens` 減去無圖對照組 =
 * 3225 − 59 = 3166（工具結果後接圖的形狀是 3433 − 264 = 3169，兩個形狀差 0.1%）。見 `.docs/model-inventory.md`「收圖實測」。
 *
 * 這是**那顆模型**的數字，不是每顆視覺模型的：圖的 token 數由端點怎麼切塊決定，跟位元組數與像素數都不成比例。型錄之後
 * 若出現別的看圖模型，要各自量，這個值只在沒有更好的資料時用。
 */
export const IMAGE_TOKENS = 3166;

/** 一份存好的檔案的參照；日誌與訊息只留這個。 */
export interface FileAttachmentRef {
  /** `sha256:<64 位十六進位>`，內容定址。 */
  readonly attachmentId: string;
  /** 清過的葉名，也是存放路徑的最後一段。 */
  readonly name: string;
  /** 確切位元組數。 */
  readonly bytes: number;
}

/** 內嵌圖片允許的媒體類型，同 dsh 的 `ImageMediaType`。 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** 一張存好的圖的參照；日誌與訊息只留這個。 */
export interface ImageAttachmentRef {
  /** `sha256:<64 位十六進位>`，內容定址。 */
  readonly attachmentId: string;
  /** 從存下來的位元組驗出來的媒體類型。 */
  readonly mediaType: ImageMediaType;
  /** 編碼後的確切位元組數。 */
  readonly bytes: number;
  /** 圖的寬（像素）。 */
  readonly width: number;
  /** 圖的高（像素）。 */
  readonly height: number;
  /** 顯示名，不含本機路徑；不當路徑解讀。 */
  readonly name?: string;
}

/**
 * 日誌與送出佇列裡一件附件的樣子：`type` 判別。順序是使用者選的順序。
 *
 * 跟訊息區塊（{@link FileBlock}／{@link ImageBlock}）是同一份資料換個包法：佇列與 `turn/start` 存這個，組成 `HumanMessage` 時
 * 才變成區塊。
 */
export type AttachmentRef =
  | ({ readonly type: 'file' } & FileAttachmentRef)
  | ({ readonly type: 'image' } & ImageAttachmentRef);

/** 訊息內容裡的檔案區塊。 */
export interface FileBlock {
  readonly type: 'nexus-file';
  readonly attachment: FileAttachmentRef;
}

/** 訊息內容裡的圖片區塊。 */
export interface ImageBlock {
  readonly type: 'nexus-image';
  readonly attachment: ImageAttachmentRef;
}

/** 一個參照放進訊息內容時的區塊。 */
export function attachmentBlock(ref: AttachmentRef): FileBlock | ImageBlock {
  const { type: kind, ...attachment } = ref;
  return kind === 'file'
    ? { type: 'nexus-file', attachment: attachment as FileAttachmentRef }
    : { type: 'nexus-image', attachment: attachment as ImageAttachmentRef };
}

/** 這個內容區塊是不是檔案區塊。 */
export function isFileBlock(block: unknown): block is FileBlock {
  return (
    block !== null &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'nexus-file' &&
    isFileRef((block as { attachment?: unknown }).attachment)
  );
}

/** 這個內容區塊是不是圖片區塊。 */
export function isImageBlock(block: unknown): block is ImageBlock {
  return (
    block !== null &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'nexus-image' &&
    isImageRef((block as { attachment?: unknown }).attachment)
  );
}

const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/;
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 這個值是不是形狀合格的檔案參照。 */
export function isFileRef(value: unknown): value is FileAttachmentRef {
  if (value === null || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref['attachmentId'] === 'string' &&
    ATTACHMENT_ID.test(ref['attachmentId']) &&
    typeof ref['name'] === 'string' &&
    ref['name'] !== '' &&
    isCount(ref['bytes'])
  );
}

/** 這個值是不是形狀合格的圖片參照。 */
export function isImageRef(value: unknown): value is ImageAttachmentRef {
  if (value === null || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref['attachmentId'] === 'string' &&
    ATTACHMENT_ID.test(ref['attachmentId']) &&
    typeof ref['mediaType'] === 'string' &&
    IMAGE_MEDIA_TYPES.has(ref['mediaType']) &&
    isCount(ref['bytes']) &&
    isCount(ref['width']) &&
    isCount(ref['height']) &&
    (ref['name'] === undefined || typeof ref['name'] === 'string')
  );
}

/** 這個值是不是形狀合格的附件參照（含 `type`）。 */
export function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (value === null || typeof value !== 'object') return false;
  const kind = (value as { type?: unknown }).type;
  return kind === 'file' ? isFileRef(value) : kind === 'image' ? isImageRef(value) : false;
}

/** 模型讀一份檔案參照的虛擬路徑：`/attachments/<雜湊前兩碼>/<雜湊>/<檔名>`。參照不合格式回 `undefined`。 */
export function fileModelPath(ref: FileAttachmentRef): string | undefined {
  if (!isFileRef(ref)) return undefined;
  const sha256 = ref.attachmentId.slice('sha256:'.length);
  return `${ATTACHMENTS_MODEL_PREFIX}/${sha256.slice(0, 2)}/${sha256}/${ref.name}`;
}

/**
 * 一個檔案給模型的那一行。**逐字照 dsh `fileHandleText`**（`packages/llm/llm/src/content.ts`，`5badb150`）：檔名、位元組數、
 * 雜湊前八碼、存放路徑；路徑讀不到時改說「無法存取，不要聲稱讀過」。
 *
 * 路徑是**每次組請求時**才決定的（儲存裡還在不在、這個執行環境讀不讀得到），所以日誌與存檔點存的是參照、不是這一行。
 *
 * @param ref - 檔案參照。
 * @param readablePath - 這個執行環境讀得到的路徑；讀不到是 `undefined`。
 */
export function fileHandleText(ref: FileAttachmentRef, readablePath: string | undefined): string {
  const digest = ref.attachmentId.slice('sha256:'.length, 'sha256:'.length + 8);
  const identity = `File ${JSON.stringify(ref.name)} (${String(ref.bytes)} bytes, sha256:${digest})`;
  if (readablePath === undefined) {
    return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`;
  }
  return `[${identity}: verbatim read-only copy saved at ${JSON.stringify(readablePath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`;
}
