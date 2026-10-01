/**
 * 交付事件上線的形狀（[#441](https://github.com/DemianLi/nexus-agent/issues/441)）。
 *
 * 載體是協定的 `custom` 事件：`method: 'custom'`，`data: { name, payload }`（`@langchain/protocol`
 * 的 `CustomEvent`）。`name` 是 {@link DELIVERABLES_PRESENTED}，`payload` 是 {@link DeliverablesPresentedPayload}。
 * 即時由 pump 從 root 那一份日誌的 `deliverables/presented` 合成，重新整理由歷史路由從同一顆事件合成，
 * 兩條路產出同一種 frame。**只有 root 那一份**：子代理宣告的交付留在子代理的日誌裡，兩條路都不送。
 *
 * 這裡只放形狀——`@nexus/wire` 不相依 `@nexus/core`，所以 `PresentedFile` 在這裡另寫一份，兩份的
 * 欄位要一樣（core 那份是 `SessionEventMap['deliverables/presented']`）。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：一次成功的 `present` 宣告交付了這幾個檔案。 */
export const DELIVERABLES_PRESENTED = 'deliverables/presented';

/** 一個宣告交付的檔案，模型給的原樣。 */
export interface WirePresentedFile {
  /** 相對路徑以工作區根為準。前端不解析它。 */
  readonly path: string;
  /** 給使用者的一句說明。沒給就沒有這個 key。 */
  readonly description?: string;
}

/**
 * `custom` 事件 `data.payload` 的形狀。
 *
 * **沒有輪的編號**：這一顆屬於它在串流裡落在的那一輪（即時與歷史的順序一樣），見 core 的
 * `SessionEventMap['deliverables/presented']`。
 */
export interface DeliverablesPresentedPayload {
  /** 那次 `present` 呼叫的 `tool_call_id`，對得上同一輪那張 `present` 工具卡。 */
  readonly callId: string;
  /**
   * 那顆 `deliverables/presented` 在 root 日誌裡的 `seq`（[#452](https://github.com/DemianLi/nexus-agent/issues/452)）。
   *
   * **它是座標，不是編號**：`(seq, index)` 一起指名「那一次交付宣告的第 index 個檔」，`index` 是它在
   * {@link DeliverablesPresentedPayload.files} 裡的位置。[#452](https://github.com/DemianLi/nexus-agent/issues/452) 的範圍決定：只開放宣告過的檔、用座標定位，
   * 所以路徑遍歷在形狀上就不可能發生。座標的形狀借自 dsh 的 `handlePresentOpen`（它也只收座標），但那條路由是在
   * 主機桌面上開檔、不讀內容。
   *
   * `callId` 取代不了它：`callId` 認得出是哪一次呼叫，但日誌那側要的是「哪一顆事件」。
   */
  readonly seq: number;
  /** 通過檢查的檔案，順序照模型給的。 */
  readonly files: readonly WirePresentedFile[];
}

/**
 * 一個交付檔在 server 上的身分，照 dsh 的 `statOf`
 * （`packages/api/workspace-files/src/index.ts:448-454`，`ddefc45`）。
 *
 * **不回 `absolutePath`，這是一條偏離。** dsh 那一格是給它的「在 Host 上開啟」用的——瀏覽器拿著
 * 主機絕對路徑去叫 `present.open`。我們不做那個動作（#452 的背景：多人共用的遠端主機，在那裡開檔
 * 使用者看不到），所以那一格在我們這裡沒有消費者，而它會把工作區的佈局講給瀏覽器聽。改回
 * {@link DeliverableFileStat.path}：模型宣告時給的原字串，前端本來就拿它當標籤。
 */
export interface DeliverableFileStat {
  /** 模型宣告當下給的那個字串，原樣。前端不解析它（同 {@link WirePresentedFile.path}）。 */
  readonly path: string;
  /** 這一次 stat 拍到的新鮮度標記，**不解析**，同 dsh 的 `version`。同值即同一份內容。 */
  readonly version: string;
  /** 完整檔案的位元組數。 */
  readonly bytes: number;
}

/**
 * `deliverable.read` 的結果：從一份文字檔切出來的一頁。
 *
 * **頁的上限是拒絕，不是截斷**（dsh `Config.maxBytes` 的理由逐字：「a silently cut page reads as the
 * whole page」）。所以超標時這個結果不會出現，出現的是 `too-large` 拒絕。**檔案本身沒有大小上限**——呼叫端翻頁，
 * 同 dsh。
 */
export interface DeliverableFilePage extends DeliverableFileStat {
  /** 這一頁從第幾行起，0 起算。 */
  readonly offset: number;
  /** 這一頁的內容，**不帶行號**（dsh 的 `read` 也不帶；行號是基座 `read` 的形狀，不是路由的）。 */
  readonly text: string;
  /** `text` 裡的行數；整頁都在最後一行之後時是 0。 */
  readonly lines: number;
  /** 這一頁碰到檔尾了。 */
  readonly eof: boolean;
}

/**
 * ## 命令通道上的交付檔讀取（[#747](https://github.com/DemianLi/nexus-agent/issues/747)）
 *
 * 照 dsh：讀工作區檔案走命令通道（`packages/api/workspace-files/src/index.ts:232-275`，`477b4f4`），不另開讀檔用的專用網址。
 * dsh 的設計筆記把「讀檔另開專用網址」列為考慮過並否決的做法（`.agents/notes/implemented/architecture/2026-09-17-workspace-file-binary-transfer.md:20`）。
 * 原本的三條專用網址（`GET /threads/:id/deliverables/{file,download,bytes}`）已在 #747 收尾時拿掉。
 *
 * **只換傳送方式。** 用 `(seq, index)` 定位、只讀宣告過的檔，是 #452 的範圍決定，這裡不動。
 *
 * ### 兩支方法，照 dsh 的 `read` 與 `readBytes`
 *
 * - {@link DELIVERABLE_READ_METHOD}：讀一頁文字，對 dsh 的 `read`。
 * - {@link DELIVERABLE_READ_BYTES_METHOD}：讀位元組，對 dsh 的 `readBytes`——**給 `offset`／`length` 就讀一個窗口，都不給就是整檔**
 *   （整檔下載，吃 `maxFileBytes`）。dsh 的筆記否決了把整檔讀與範圍讀拆成不同方法（`:19`）。
 *
 * ### 拒絕怎麼上線
 *
 * - **業務上的拒絕**放在回應結果裡：`{ ok: false, error: { code, message, … } }`，同回饋那幾支命令（{@link FeedbackPutResult}），
 *   碼是 {@link DeliverableRefusalCode}，形狀照 dsh 的 `<命名空間>/<理由>`（dsh 的讀檔服務是 `workspace-file/…`）。
 *   `too-large` 照 dsh 帶上限數字。**沒有狀態碼這一層**，也就沒有「理由→數字→理由」的兩份對照表。
 * - **參數本身不合格**（座標、翻頁、窗口）不是讀檔服務的碼：dsh 回閘道層共用的 `gateway/bad-request`
 *   （`packages/api/workspace-files/src/index.ts:360`、`:370`），這裡對應協定錯誤 `invalid_argument`。
 *
 * ### 位元組怎麼上線：多段表單，不是 base64
 *
 * 照 dsh `packages/client/connection/src/rpc-host.ts:296-311` 與 `client/rpc.ts:61-64`：成功的結果裡有位元組時，回應是
 * `multipart/form-data`——`metadata` 一段放 JSON 外殼（{@link BinaryAttachmentRef} 指出每份位元組在結果裡的位置），
 * 每份位元組各一段 `bytes-<n>`。其餘（錯誤、不帶位元組的結果）照舊回 JSON。**結果裡的位元組是 `Uint8Array`**，
 * 不是 base64 字串（dsh `types.ts:84-91`）；所以下載與窗口都不再多三分之一，也不需要解碼那一層。
 * 編碼（{@link encodeBinaryResult}）與解碼（{@link decodeBinaryResult}）都放在這裡，兩端才不會各拼一份。
 */
export const DELIVERABLE_READ_METHOD = 'deliverable.read';

/** 讀位元組：給 `offset`／`length` 是窗口，都不給是整檔。見 {@link DELIVERABLE_READ_METHOD} 那段。 */
export const DELIVERABLE_READ_BYTES_METHOD = 'deliverable.readBytes';

export const DELIVERABLE_METHODS = [
  DELIVERABLE_READ_METHOD,
  DELIVERABLE_READ_BYTES_METHOD,
] as const;

export type DeliverableMethod = (typeof DELIVERABLE_METHODS)[number];

export function isDeliverableMethod(value: unknown): value is DeliverableMethod {
  return typeof value === 'string' && (DELIVERABLE_METHODS as readonly string[]).includes(value);
}

/**
 * 交付檔讀取的拒絕碼。**每一個都對應到前端一個不同的動作**（`not-text` 改給下載、`too-large` 講太大、
 * `no-anchor`／`not-found`／`not-regular-file` 是這張卡讀不到），所以不壓成同一種。
 *
 * 參數不合格不在這裡：那是協定錯誤 `invalid_argument`（見 {@link DELIVERABLE_READ_METHOD} 的說明）。
 * harness 那側把「內部的理由」對到這些碼的表以這個型別為值域，寫一個不在這裡的字串當場編不過。
 */
export type DeliverableRefusalCode =
  | 'deliverable/no-anchor'
  | 'deliverable/not-found'
  | 'deliverable/not-regular-file'
  | 'deliverable/too-large'
  | 'deliverable/not-text';

/** 讀交付檔失敗時 `error` 的形狀；`too-large` 帶上限，照 dsh。 */
export type DeliverableReadError =
  | {
      readonly code: Exclude<DeliverableRefusalCode, 'deliverable/too-large'>;
      readonly message: string;
    }
  | {
      readonly code: 'deliverable/too-large';
      readonly message: string;
      /** 被超過的那個上限（位元組）：頁的上限，或整檔的上限。 */
      readonly maxBytes: number;
    };

/** `deliverable.read` 的參數。`offset` 預設 0、`limit` 預設是這台 server 的頁行數上限。 */
export interface DeliverableReadParams {
  readonly seq: number;
  readonly index: number;
  readonly offset?: number;
  readonly limit?: number;
}

/** `deliverable.readBytes` 的參數。`offset` 與 `length` 要嘛都不給（整檔），要嘛給了就是一個窗口（`length` 預設是頁的位元組上限）。 */
export interface DeliverableReadBytesParams {
  readonly seq: number;
  readonly index: number;
  readonly offset?: number;
  readonly length?: number;
}

export interface DeliverableReadCommand {
  readonly id: number;
  readonly method: typeof DELIVERABLE_READ_METHOD;
  readonly params: DeliverableReadParams;
}

export interface DeliverableReadBytesCommand {
  readonly id: number;
  readonly method: typeof DELIVERABLE_READ_BYTES_METHOD;
  readonly params: DeliverableReadBytesParams;
}

export type DeliverableCommand = DeliverableReadCommand | DeliverableReadBytesCommand;

/**
 * 讀位元組的結果：照 dsh 的 `WorkspaceFileBytes`（`packages/api/workspace-files/src/types.ts:84-91`），**`data` 是位元組**。
 *
 * 窗口的上限是拒絕，不是截斷：要的 `length` 超過頁的位元組上限就是 `too-large`，同 dsh。**不解碼、不擋二進位**（dsh：「raw bytes,
 * no text decoding and no binary rejection」）；窗口切在哪個位元組由呼叫端決定，所以 UTF-8 字元可能被切在兩個窗口之間，
 * 接起來解碼（`TextDecoder` 的 `stream: true`）是呼叫端的事。
 *
 * 整檔讀時 `offset` 是 0、`eof` 是 `true`。
 */
export interface DeliverableBytes extends DeliverableFileStat {
  readonly offset: number;
  readonly data: Uint8Array;
  readonly eof: boolean;
}

export type DeliverableReadResult =
  | { readonly ok: true; readonly value: DeliverableFilePage }
  | { readonly ok: false; readonly error: DeliverableReadError };

export type DeliverableReadBytesResult =
  | { readonly ok: true; readonly value: DeliverableBytes }
  | { readonly ok: false; readonly error: DeliverableReadError };

/**
 * 外殼裡的一筆附件說明，照 dsh：位元組住在結果的 `path` 那個位置（`['value', 'data']`），內容在表單的 `part` 那一段。
 * `codec` 目前只有 `'bytes'`。
 */
export interface BinaryAttachmentRef {
  readonly path: readonly string[];
  readonly codec: 'bytes';
  readonly part: string;
}

const METADATA_PART = 'metadata';

/**
 * 把一個帶位元組的成功結果編成多段表單回應。
 *
 * @param id - 回給哪一顆上行封包。
 * @param value - `result.value`；位元組在 `data`。
 * @returns 回應：`metadata` 一段是 `{ type: 'success', id, result: { ok: true, value: <去掉 data> }, attachments }`，
 *   位元組在 `bytes-0`。不快取。
 */
export function encodeBinaryResult(id: number, value: DeliverableBytes): Response {
  const { data, ...rest } = value;
  const form = new FormData();
  // 位元組可能是 SharedArrayBuffer 撐的，`BlobPart` 不收；複製成普通的 `Uint8Array`（dsh 同樣這樣做）。
  form.set('bytes-0', new Blob([new Uint8Array(data)]));
  const attachments: readonly BinaryAttachmentRef[] = [
    { path: ['value', 'data'], codec: 'bytes', part: 'bytes-0' },
  ];
  form.set(
    METADATA_PART,
    JSON.stringify({ type: 'success', id, result: { ok: true, value: rest }, attachments }),
  );
  const response = new Response(form);
  response.headers.set('cache-control', 'no-store');
  return response;
}

/** 回應是不是多段表單。 */
export function isBinaryResponse(response: Response): boolean {
  return (
    response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
    'multipart/form-data'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解一個多段表單回應，把每份位元組放回外殼裡它的位置。照 dsh 的 `parseBinaryResponse`（`client/rpc.ts`）：
 * 欄位重複、少了 `metadata`、附件說明不合格、附件指到不是位元組的段，都是壞回應，拋 `TypeError`。
 *
 * @param response - `content-type` 是 `multipart/form-data` 的回應。
 * @returns 外殼（`type`、`id`）與放回位元組之後的 `result`。
 */
export async function decodeBinaryResult(
  response: Response,
): Promise<{ readonly id: number; readonly result: Record<string, unknown> }> {
  const form = await response.formData();
  const fields = new Map<string, string | Blob>();
  for (const [name, value] of form) {
    if (fields.has(name)) throw new TypeError('交付檔的二進位回應：欄位重複');
    fields.set(name, value);
  }
  const metadata = fields.get(METADATA_PART);
  fields.delete(METADATA_PART);
  if (typeof metadata !== 'string') throw new TypeError('交付檔的二進位回應：缺 metadata');
  const envelope: unknown = JSON.parse(metadata);
  if (
    !isRecord(envelope) ||
    envelope.type !== 'success' ||
    typeof envelope.id !== 'number' ||
    !isRecord(envelope.result) ||
    !Array.isArray(envelope.attachments) ||
    envelope.attachments.length === 0
  ) {
    throw new TypeError('交付檔的二進位回應：外殼不合格');
  }
  const result = envelope.result;
  for (const attachment of envelope.attachments as readonly unknown[]) {
    if (
      !isRecord(attachment) ||
      attachment.codec !== 'bytes' ||
      typeof attachment.part !== 'string' ||
      !Array.isArray(attachment.path) ||
      attachment.path.length === 0 ||
      !attachment.path.every((segment): segment is string => typeof segment === 'string')
    ) {
      throw new TypeError('交付檔的二進位回應：附件說明不合格');
    }
    const blob = fields.get(attachment.part);
    fields.delete(attachment.part);
    if (!(blob instanceof Blob)) throw new TypeError('交付檔的二進位回應：附件不是位元組');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // 走到路徑的父層再放：路徑中間任何一格不是物件就是壞回應，不替它建。
    let parent: Record<string, unknown> = result;
    for (const segment of attachment.path.slice(0, -1)) {
      const next = parent[segment];
      if (!isRecord(next)) throw new TypeError('交付檔的二進位回應：附件的位置不存在');
      parent = next;
    }
    parent[attachment.path[attachment.path.length - 1]!] = bytes;
  }
  if (fields.size > 0) throw new TypeError('交付檔的二進位回應：多出沒人指到的段');
  return { id: envelope.id, result };
}

// 名字→酬載表（#685）上屬於這個檔的格子，見 `custom-frame.ts`。
declare module './custom-frame.js' {
  interface CustomFramePayloads {
    [DELIVERABLES_PRESENTED]: DeliverablesPresentedPayload;
  }
}
