/**
 * 附件儲存：使用者上傳的檔案存在 harness home 底下、會話日誌之外，日誌與訊息只留參照
 * （[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。
 *
 * ## 照 dsh 的部分（`packages/attachment/attachment-local/src/{file-store,store}.ts`，`5badb150`）
 *
 * - **內容定址、逐位元組原樣存**：參照是 `sha256:<hex>`＋清過的檔名＋位元組數。同樣的內容只存一份物件
 *   （`file-objects/<前兩碼>/<hex>`），每個檔名是指向它的硬連結（`files/<前兩碼>/<hex>/<檔名>`），所以模型與使用者
 *   拿到的路徑結尾就是真的檔名。
 * - **先寫暫存檔、`link` 進正式位置**：`link` 在目標已存在時失敗（`EEXIST`），那就是去重；讀的一方永遠讀不到寫一半的物件。
 * - **物件存成唯讀**（`0400`），目錄 `0700`。「一般檔案存成唯讀」是卡上的明文；`0600` 的暫存檔只存活到 `link` 完成。
 * - **檔名清成葉名**（`fileLeafName`，逐條照 dsh）：兩種分隔符都手動剝，不信 `basename`（POSIX 把 `\` 當一般字元，
 *   Windows 客戶端的整條本機路徑會漏進參照與日誌）。
 * - 串流進來、不聚合：上傳不吃記憶體。
 * - **圖落盤前先規範化**（[#2033](https://github.com/DemianLi/nexus-agent/issues/2033)；存哪一份見 #1827）：整張解碼、轉正、轉 8-bit sRGB、總像素縮到 2048² 以內再編碼，
 *   落盤與送模型的都是這一份，附件 id 是它的 sha256，原圖不留；已經合格的原樣通過。一句話的圖整批先預備完才寫，轉碼有併發上限（`compression-limiter.ts`）。
 *   細節見 `image-normalization.ts`。
 * - **讀與去重都重算雜湊**（`ATTACHMENT_CORRUPT`，[#1338](https://github.com/DemianLi/nexus-agent/issues/1338)）：
 *   物件路徑就是雜湊，所以讀圖時重算一次、去重碰到既有物件時重算一次，對不上就拋，不把來路不明的位元組交出去、
 *   也不讓壞物件「認領」新上傳。讀圖時再重讀檔頭比媒體類型與寬高（dsh `readImageFile`，[#1566](https://github.com/DemianLi/nexus-agent/issues/1566)）。沒有行程內的「已驗過」快取（dsh 也沒有）；別名硬連結不重算內容，只比 inode：跟物件不同
 *   （物件被刪掉重建過）就原子地換掉（[#1352](https://github.com/DemianLi/nexus-agent/issues/1352)）。
 * - **回報參照之前逐層 fsync 目錄**（[#1528](https://github.com/DemianLi/nexus-agent/issues/1528)，dsh `store.ts:126-183`、
 *   `:272-302`、`:350-388`，`1517a4db`）：暫存檔內容 fsync 了還不夠，`link` 寫進父目錄的那一筆名字、這次新建的
 *   `<前兩碼>` 目錄都要落盤，不然斷電後會話日誌引用的附件不見。
 *   - 每個行程對 home 證明一次：home 往上到檔案系統根逐層 fsync（`ensureDurableHome`）。
 *   - 暫存目錄、物件與別名的父目錄，建好之後往上逐層 fsync 到 home；**不看 `mkdir` 回報哪幾層是新建的**。
 *   - `link`（或去重、或別名換掉）之後，從父目錄逐層 fsync 到附件根才回。去重那條也走。
 *   - 目錄 fsync 用 `atomic-file.ts` 的 `syncDirectory`：Windows 略過，POSIX 錯往外拋，`save`／`saveImage` 包成
 *     `ATTACHMENT_STORE_FAILED`（dsh 的 `ATTACHMENT_WRITE_FAILED`）。
 *
 * ## 偏離（依 AGENTS.md 登記）
 *
 * 1. **模型讀它走虛擬前綴 {@link ATTACHMENTS_PREFIX}，不是主機絕對路徑。** 同 `tool-result-stash.ts`：路徑是 `CompositeBackend`
 *    的一條唯讀路由（根是 `<root>/files`），圍欄看不到的主機路徑不出現在模型面前，續接之後同一個路徑照讀。dsh 的 `read_file`
 *    收到的是主機路徑（它的檔案工具不在工作區圍欄裡）；我們的 backend 有圍欄，所以走路由。基座表達不出的是「圍欄外的絕對路徑」。
 * 2. **送模型的圖沒有另做請求版本：送的就是落盤那一份。** 新收的圖落盤前已經規範化（`saveImages`，見 `image-normalization.ts`）；
 *    **規範化之前就落盤的圖**（舊 thread 的原圖）照原樣送，不依路由的預算另縮。
 *    TODO([#2033](https://github.com/DemianLi/nexus-agent/issues/2033))：依路由的預算另做請求版本並快取；做了之後一併改
 *    `@nexus/core` `attachment-projection.ts` 檔頭「寬高用參照記的」那一條。
 * 3. **儲存沒有逐會話目錄，但模型讀附件的路由按 thread 收窄**（理由 2，[#1773](https://github.com/DemianLi/nexus-agent/issues/1773)，#1675 Q3 (a)，
 *    demian 2026-10-20 拍板）。**儲存照 dsh**：附件根是全域內容定址（`attachments/v1`），不按會話分，同樣的內容只存一份。**路由不照 dsh**：
 *    dsh 是單人桌面，模型讀的是主機路徑、沒有路由；nexus 是一台主機多人共用，所有 web 使用者在同一個 OS 帳號底下，`0700` 分不開人
 *    （以前同一台 serve 的任何 thread 都能 `ls /attachments` 列出別條 thread 上傳的檔，照路徑 `read_file` 讀得到）。補的是路由多一道
 *    「這條 thread 的 root 日誌引用過」的判準，跟網頁讀圖同一條（`attachment-reference.ts`，照 dsh `session.attachment`），在呼叫當下判，
 *    `ls`／`read`／`grep`／`glob` 都過這一關，沒引用過的路徑回覆跟不存在相同。見 `attachment-route.ts`。對舊 thread 也生效：判準是日誌，
 *    自己上傳的照舊讀得到，只有別條 thread 的附件從此讀不到。**`grep` 出錯時也不照 dsh**（#1822）：dsh 的 `search-core.ts` 把 rg 的 stderr 原樣接在
 *    錯誤訊息後面，在這裡會把同一個目錄下沒引用過的別名檔名帶給模型，所以 `SEARCH_FAILED`／`SEARCH_INVALID_PATTERN` 回固定字句
 *    （原文、thread id 與錯誤碼寫進伺服器日誌）；`SEARCH_ABORTED`／`SEARCH_RAW_OUTPUT_OVERFLOW` 不帶路徑，照舊。
 * 4. **home 以上的祖先開不了就略過那一層**（理由 2，#1528 Q1 (b)，demian 2026-10-17 拍板）。dsh 的 home 證明一路 fsync
 *    到檔案系統根，任何一層開不了都是寫入失敗；多人共用的主機常把 `/home` 這類目錄收成 `0711`（進得去、列不了），照 dsh
 *    的話每一次上傳都失敗。所以只在 home **以上**、只對**開目錄時**的 `EACCES`／`EPERM`，略過那一層並在伺服器日誌講一次；
 *    fsync 本身的錯、home 與 home 以下的任何錯照 dsh 拋。這個帳號開不了的祖先不是它建的，它在父目錄裡的那一筆不是
 *    這次寫入要保證的。
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

import { ATTACHMENTS_MODEL_PREFIX } from '@nexus/core';
import type { FileAttachmentRef, ImageAttachmentRef, ImageMediaType } from '@nexus/core';

import { syncDirectory } from './atomic-file.js';
import { ThreadScopedAttachmentBackend } from './attachment-route.js';
import type { AttachmentScope } from './attachment-route.js';
import { CompressionLimiter } from './compression-limiter.js';
import { probeImageHeader } from './image-intake.js';
import { DEFAULT_NORMALIZATION_POLICY, prepareImage } from './image-normalization.js';
import type { ImageSubmission, PreparedImage } from './image-normalization.js';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './owner-only.js';
import { assertPrivateFile } from './plugin-config.js';
import type { PrivateFileRole } from './plugin-config.js';

/** 附件根在 harness home 底下的名字；`v1` 是目錄佈局的版本。 */
export const ATTACHMENTS_DIR_NAME = 'attachments';
export const ATTACHMENTS_LAYOUT_VERSION = 'v1';

/** 模型讀附件的虛擬前綴（沒有結尾斜線；路由鍵加斜線，見 `agent-factory.ts`）。 */
export const ATTACHMENTS_PREFIX = ATTACHMENTS_MODEL_PREFIX;

/** 同時規範化的圖數的出廠值。 */
export const DEFAULT_IMAGE_COMPRESSION_CONCURRENCY = 2;
/** 同時規範化的圖數可設的上限；設定的 schema 與建構子都擋。 */
export const MAX_IMAGE_COMPRESSION_CONCURRENCY = 8;

/** 物件檔的權限：只讀，只有擁有者。 */
const OBJECT_FILE_MODE = 0o400;

const ATTACHMENT_ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

const ROOT_ROLE: PrivateFileRole = {
  subject: '附件目錄',
  why: '別人換得掉這個目錄底下的檔，模型就會讀到被換過的內容。',
};

export type { FileAttachmentRef, ImageAttachmentRef };

/** 附件相關的失敗；`code` 是穩定的，呼叫端據此分類。 */
export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;
  constructor(message: string, code: AttachmentErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AttachmentError';
    this.code = code;
  }
}

export type AttachmentErrorCode =
  | 'INVALID_ATTACHMENT_REF'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_STORE_FAILED'
  /** 物件的內容對不上它的雜湊（被換過、損毀、截斷）；讀與去重都會驗。 */
  | 'ATTACHMENT_CORRUPT';

/** 附件根：`<harness home>/attachments/v1`。只解析，不建目錄。 */
export function attachmentsRootOf(home: string): string {
  return join(home, ATTACHMENTS_DIR_NAME, ATTACHMENTS_LAYOUT_VERSION);
}

function isWindowsDeviceName(name: string): boolean {
  const dot = name.indexOf('.');
  const stem = (dot < 0 ? name : name.slice(0, dot)).replace(/[. ]+$/u, '');
  return WINDOWS_DEVICE_NAME.test(stem);
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let prefix = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}

/**
 * 把呼叫端給的顯示名清成安全的葉名。逐條照 dsh `fileLeafName`：兩種分隔符手動剝、控制字元拿掉、Windows 不收的字元換 `_`、
 * 結尾的點與空白拿掉、Windows 裝置名前面墊 `_`、限 255 位元組，清完是空的就叫 `file`。
 *
 * @param value - 呼叫端宣告的名字，可能是整條客戶端路徑。
 * @returns 非空、各主機檔案系統都收的葉名。
 */
export function fileLeafName(value: string | undefined): string {
  if (value === undefined) return 'file';
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1);
  let clean = [...leaf]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '');
  if (isWindowsDeviceName(clean)) clean = `_${clean}`;
  clean = utf8Prefix(clean, 255).replace(/[. ]+$/u, '');
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean;
}

function digestOf(ref: FileAttachmentRef): string {
  const match = ATTACHMENT_ID_PATTERN.exec(ref.attachmentId);
  if (match?.[1] === undefined || ref.name !== fileLeafName(ref.name)) {
    throw new AttachmentError('附件參照不合格式', 'INVALID_ATTACHMENT_REF');
  }
  return match[1];
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

/** 這個行程已經證明過「它和它以上每一層都落盤了」的 harness home（dsh `store.ts:23`）。 */
const durableHomes = new Set<string>();
/** 開不了、已經在日誌講過的 home 以上祖先：同一層一個行程只講一次（偏離 4）。 */
const unreadableAncestors = new Set<string>();

/**
 * fsync 一層 **home 以上**的祖先。開目錄時 `EACCES`／`EPERM` 就略過那一層、講一次（偏離 4，#1528 Q1 (b)）；
 * fsync 本身的錯、其他開目錄的錯照拋。開與 fsync 要分開判，所以不能直接用 `syncDirectory`。
 */
async function syncAncestorAboveHome(
  directory: string,
  warn: (line: string) => void,
): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(directory, 'r');
  } catch (error) {
    if (!isCode(error, 'EACCES') && !isCode(error, 'EPERM')) throw error;
    if (!unreadableAncestors.has(directory)) {
      unreadableAncestors.add(directory);
      warn(
        `[附件] ${directory} 開不了（${(error as NodeJS.ErrnoException).code ?? ''}），略過這一層的目錄 fsync：` +
          '這個帳號開不了的祖先不是它建的，它在父目錄裡的那一筆不是這次寫入要保證的。home 與 home 以下照常逐層 fsync。',
      );
    }
    return;
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 每個行程對一個 home 證明一次：從 home 往上逐層 fsync 父目錄，直到檔案系統根（dsh `ensureDurableHome`，`store.ts:176-183`）。
 * 別的行程建的 home，在這個行程裡不算數。home 本身由呼叫端先建好（`#prepare`）。
 */
async function ensureDurableHome(home: string, warn: (line: string) => void): Promise<void> {
  if (durableHomes.has(home)) return;
  const stop = parse(home).root;
  for (let level = home; level !== stop;) {
    const parent = dirname(level);
    await syncAncestorAboveHome(parent, warn);
    if (parent === level) break;
    level = parent;
  }
  durableHomes.add(home);
}

/** 本機附件儲存。一個行程一份，可以並行呼叫。 */
export class AttachmentStore {
  readonly #root: string;
  /** harness home：`<home>/attachments/v1` 往上兩層，逐層 fsync 的邊界（dsh `dirname(dirname(root))`）。 */
  readonly #home: string;
  readonly #warn: (line: string) => void;
  readonly #compression: CompressionLimiter;
  #prepared: Promise<void> | undefined;

  /**
   * @param rootDir - 絕對路徑，通常是 {@link attachmentsRootOf}。
   * @param options.warn - 伺服器日誌（home 以上的祖先開不了時講一次）；省略即標準錯誤。
   * @param options.imageCompressionConcurrency - 同時規範化的圖數上限，1 到 {@link MAX_IMAGE_COMPRESSION_CONCURRENCY}
   *   的整數；省略是 {@link DEFAULT_IMAGE_COMPRESSION_CONCURRENCY}。
   * @throws {Error} 併發上限不在範圍內。
   */
  constructor(
    rootDir: string,
    options: {
      readonly warn?: (line: string) => void;
      readonly imageCompressionConcurrency?: number;
    } = {},
  ) {
    this.#root = resolve(rootDir);
    this.#home = dirname(dirname(this.#root));
    this.#warn = options.warn ?? ((line) => process.stderr.write(`${line}\n`));
    const concurrency =
      options.imageCompressionConcurrency ?? DEFAULT_IMAGE_COMPRESSION_CONCURRENCY;
    // 設定的 schema 已經擋過範圍；不經設定、直接建構的呼叫端在這裡擋。
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > MAX_IMAGE_COMPRESSION_CONCURRENCY
    ) {
      throw new Error(
        `imageCompressionConcurrency 要是 1 到 ${String(MAX_IMAGE_COMPRESSION_CONCURRENCY)} 的整數`,
      );
    }
    this.#compression = new CompressionLimiter(concurrency);
  }

  /** 圖片轉碼的限流器：起動日誌讀它的 `concurrency`，測試讀 `active` 量峰值。 */
  get compression(): CompressionLimiter {
    return this.#compression;
  }

  /** 附件根（絕對路徑）。 */
  get rootDir(): string {
    return this.#root;
  }

  /** 模型讀檔的路由根（`files` 子目錄）：物件與暫存目錄不在裡面。 */
  get filesDir(): string {
    return join(this.#root, 'files');
  }

  /**
   * 一份參照在主機上的絕對路徑（不讀檔）。
   *
   * @throws {AttachmentError} 參照的雜湊或檔名不合格式。
   */
  pathOf(ref: FileAttachmentRef): string {
    const sha256 = digestOf(ref);
    return join(this.filesDir, sha256.slice(0, 2), sha256, ref.name);
  }

  /**
   * 模型用 `read_file` 讀它的虛擬路徑：{@link ATTACHMENTS_PREFIX} 加上 `files` 底下的相對位置。
   *
   * @throws {AttachmentError} 參照的雜湊或檔名不合格式。
   */
  modelPathOf(ref: FileAttachmentRef): string {
    const sha256 = digestOf(ref);
    return `${ATTACHMENTS_PREFIX}/${sha256.slice(0, 2)}/${sha256}/${ref.name}`;
  }

  /**
   * 模型讀附件的路由目標：唯讀的圍堵 backend，根是 {@link filesDir}。路由掛在 {@link ATTACHMENTS_PREFIX} 底下。
   * 目錄還不存在（沒有人上傳過）時先建起來，不然第一次 `ls` 會說根不存在。
   *
   * **只露出 `scope` 說這條 thread 引用過的檔案**（偏離 3，#1773），見 `attachment-route.ts`。`scope` 是必傳的：沒有「整個
   * `files` 目錄都看得到」的版本，免得有人漏傳而路由悄悄變回全開。
   *
   * @param scope - 這條 thread 的 root 日誌的口，路由在每次呼叫當下才讀。
   */
  async readOnlyRoute(scope: AttachmentScope): Promise<ThreadScopedAttachmentBackend> {
    await this.#prepare();
    return new ThreadScopedAttachmentBackend({
      rootDir: this.filesDir,
      scope,
      warn: this.#warn,
    });
  }

  /**
   * 存一份檔案，位元組原樣。
   *
   * @param input.data - 檔案的位元組，依序；不聚合。
   * @param input.name - 顯示名，清成葉名。
   * @param input.signal - 取消：中止時拋、暫存檔收掉。
   * @param input.maxBytes - 選填的上限；超過就拋 `ATTACHMENT_TOO_LARGE`，暫存檔收掉。
   * @throws {AttachmentError} 超過上限、或存不下。
   */
  async save(input: {
    readonly data: AsyncIterable<Uint8Array> | Uint8Array;
    readonly name?: string | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly maxBytes?: number | undefined;
  }): Promise<FileAttachmentRef> {
    const name = fileLeafName(input.name);
    try {
      await this.#prepare();
      const staged = await this.#stage(input.data, input.signal, input.maxBytes);
      try {
        const objectPath = this.#objectPath(staged.sha256);
        await this.#publish(staged.path, objectPath, staged.sha256);
        const ref: FileAttachmentRef = {
          attachmentId: `sha256:${staged.sha256}`,
          name,
          bytes: staged.bytes,
        };
        const aliasDir = join(this.filesDir, staged.sha256.slice(0, 2), staged.sha256);
        await this.#publishAlias(objectPath, join(aliasDir, name));
        input.signal?.throwIfAborted();
        return ref;
      } finally {
        await unlink(staged.path).catch(() => {});
      }
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      // 取消不是存不下：原樣往外拋，呼叫端認得 AbortError。
      if (input.signal?.aborted === true) throw error;
      throw new AttachmentError(
        `附件存不下：${error instanceof Error ? error.message : String(error)}`,
        'ATTACHMENT_STORE_FAILED',
        { cause: error },
      );
    }
  }

  /**
   * 存一句話的圖：**整批先在限流內預備完**（整張解碼、比宣告的型別、規範化；重新編碼的輸出再解一次驗），
   * 預備時有一張不行就整批不寫；全過才照順序一張一張落盤，落盤途中失敗時已經寫進去的物件不收回。限流只包預備，不包寫盤。
   * 落盤的是規範化之後那一份，參照的寬高與附件 id 都是它的；縮過的另記 `originalDimensions`（轉向之後的原寬高）。
   *
   * 物件跟檔案共用 `file-objects/`（內容定址，同樣的位元組只有一份），**不建檔名的硬連結**：模型不經檔案路徑讀圖。
   *
   * @param inputs - 已經過檔頭那一關（`admitImages`）的圖，照順序。
   * @returns 參照，順序不變。
   * @throws {ImageIntakeError} 有一張解不開或型別不符。
   * @throws {AttachmentError} 規範化失敗或存不下。
   */
  async saveImages(inputs: readonly ImageSubmission[]): Promise<ImageAttachmentRef[]> {
    const prepared = await Promise.all(
      inputs.map((input) =>
        this.#compression.run(() => prepareImage(input, DEFAULT_NORMALIZATION_POLICY)),
      ),
    );
    const refs: ImageAttachmentRef[] = [];
    for (const image of prepared) refs.push(await this.#commitImage(image));
    return refs;
  }

  /**
   * 存一張圖，見 {@link saveImages}。**不經檔頭那一關**（`admitImages`）：位元組與像素上限不在這裡判，呼叫端只能給已知在上限內的位元組。
   *
   * @param input.data - 完整的編碼後位元組。
   * @param input.mediaType - 宣告的媒體類型；跟位元組不符就拒收。
   * @param input.name - 顯示名；清成葉名，沒給就不記。
   * @throws {ImageIntakeError} 解不開或型別不符。
   * @throws {AttachmentError} 規範化失敗或存不下。
   */
  async saveImage(input: {
    readonly data: Uint8Array;
    readonly mediaType: ImageMediaType;
    readonly name?: string | undefined;
  }): Promise<ImageAttachmentRef> {
    const [ref] = await this.saveImages([
      { bytes: input.data, mediaType: input.mediaType, name: input.name, label: '這張圖' },
    ]);
    return ref!;
  }

  async #commitImage(image: PreparedImage): Promise<ImageAttachmentRef> {
    const { normalized, source } = image;
    try {
      await this.#prepare();
      const staged = await this.#stage(normalized.data, undefined, undefined);
      try {
        await this.#publish(staged.path, this.#objectPath(staged.sha256), staged.sha256);
      } finally {
        await unlink(staged.path).catch(() => {});
      }
      const downscaled = source.width !== normalized.width || source.height !== normalized.height;
      return {
        attachmentId: `sha256:${staged.sha256}`,
        mediaType: normalized.mediaType,
        bytes: staged.bytes,
        width: normalized.width,
        height: normalized.height,
        ...(image.name === undefined ? {} : { name: fileLeafName(image.name) }),
        ...(downscaled
          ? { originalDimensions: { width: source.width, height: source.height } }
          : {}),
      };
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError(
        `圖片存不下：${error instanceof Error ? error.message : String(error)}`,
        'ATTACHMENT_STORE_FAILED',
        { cause: error },
      );
    }
  }

  /**
   * 讀一張存好的圖的位元組。大小、內容雜湊或檔頭（媒體類型、寬高）跟參照對不上（物件被換過、損毀、被截斷，
   * 或參照被改過）就拋，不把來路不明的位元組交出去。大小先比（便宜），再重算 sha256，最後重讀檔頭。
   *
   * @throws {AttachmentError} 參照不合格式、物件不在（`ATTACHMENT_STORE_FAILED`）、或內容對不上（`ATTACHMENT_CORRUPT`）。
   */
  async readImage(ref: ImageAttachmentRef): Promise<Uint8Array> {
    const sha256 = ATTACHMENT_ID_PATTERN.exec(ref.attachmentId)?.[1];
    if (sha256 === undefined) {
      throw new AttachmentError('附件參照不合格式', 'INVALID_ATTACHMENT_REF');
    }
    let data: Uint8Array;
    try {
      data = await readFile(this.#objectPath(sha256));
    } catch (error) {
      throw new AttachmentError(
        `圖片讀不到：${error instanceof Error ? error.message : String(error)}`,
        'ATTACHMENT_STORE_FAILED',
        { cause: error },
      );
    }
    if (data.byteLength !== ref.bytes) {
      throw new AttachmentError(
        `圖片的大小對不上參照（${String(data.byteLength)} ≠ ${String(ref.bytes)}）`,
        'ATTACHMENT_CORRUPT',
      );
    }
    if (createHash('sha256').update(data).digest('hex') !== sha256) {
      throw new AttachmentError('圖片的內容對不上它的雜湊', 'ATTACHMENT_CORRUPT');
    }
    // 雜湊只證明位元組是當初存的那份，不證明參照的其他欄位：日誌裡的寬高、媒體類型被改過，畫面與模型會照著錯的
    // 那份走。照 dsh `readImageFile`（`store.ts:450-458`，`687f282e`）重讀檔頭再比一次，只讀檔頭、不解碼像素。
    // **這一支刻意不套 EXIF 轉向**：規範化之前落盤的舊參照記的是檔頭裡存的軸，改成轉向之後的軸會讓它們一起變成
    // `ATTACHMENT_CORRUPT`。規範化之後的圖不帶轉向，檔頭的軸就是看起來的軸；收下時 `image-normalization.ts` 用同一支比過。
    const facts = probeImageHeader(data);
    if (
      facts === undefined ||
      facts.mediaType !== ref.mediaType ||
      facts.width !== ref.width ||
      facts.height !== ref.height
    ) {
      throw new AttachmentError('圖片的檔頭對不上參照', 'ATTACHMENT_CORRUPT');
    }
    return data;
  }

  /** 這份檔案的存放路徑現在讀不讀得到（儲存被清掉、被搬走時是 `false`）。參照不合格式也是 `false`。 */
  async hasFile(ref: FileAttachmentRef): Promise<boolean> {
    try {
      return (await stat(this.pathOf(ref))).isFile();
    } catch {
      return false;
    }
  }

  #objectPath(sha256: string): string {
    return join(this.#root, 'file-objects', sha256.slice(0, 2), sha256);
  }

  async #stage(
    data: AsyncIterable<Uint8Array> | Uint8Array,
    signal: AbortSignal | undefined,
    maxBytes: number | undefined,
  ): Promise<{ path: string; sha256: string; bytes: number }> {
    // 照 dsh `stageImmutableObject`（`store.ts:315-319`）：先證明 home 到根，再把暫存目錄到 home 逐層 fsync。
    await ensureDurableHome(this.#home, this.#warn);
    const staging = join(this.#root, 'staging');
    await this.#ensureDurableDirectory(staging, this.#home);
    const path = join(staging, randomBytes(12).toString('hex'));
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      PRIVATE_FILE_MODE,
    );
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      const chunks = data instanceof Uint8Array ? [data] : data;
      for await (const chunk of chunks) {
        signal?.throwIfAborted();
        bytes += chunk.byteLength;
        if (maxBytes !== undefined && bytes > maxBytes) {
          throw new AttachmentError(
            `附件超過上限 ${String(maxBytes)} 位元組`,
            'ATTACHMENT_TOO_LARGE',
          );
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      signal?.throwIfAborted();
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw error;
    }
    await handle.close();
    return { path, sha256: hash.digest('hex'), bytes };
  }

  /**
   * 把內容定址的物件 `link` 進正式位置；目標已存在就是去重，不算錯。照 dsh `publishStagedObject`（`store.ts:350-388`）：
   *
   * - `link` 之前父目錄到 home 逐層 fsync；
   * - 去重碰到既有物件時重算它的摘要，對不上拋 `ATTACHMENT_CORRUPT`，不讓先前寫壞或被換過的物件被新上傳「認領」；
   * - 模式收回唯讀（去重時也收：先寫的那一個如果被人 chmod 過，這裡恢復）；
   * - **回報之前**從父目錄逐層 fsync 到附件根。去重那條也走：它看到的可能是另一個寫者剛 `link`、還沒走到自己耐久點的物件。
   */
  async #publish(source: string, target: string, expectedSha256: string): Promise<void> {
    const parent = dirname(target);
    await this.#ensureDurableDirectory(parent, this.#home);
    try {
      await link(source, target);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      await this.#verifyObject(target, expectedSha256);
    }
    await chmod(target, OBJECT_FILE_MODE);
    await this.#syncUpToRoot(parent);
  }

  /**
   * 建檔名別名（物件的硬連結，[#1352](https://github.com/DemianLi/nexus-agent/issues/1352)），回報之前跟物件一樣逐層
   * fsync（dsh `publishImmutableAlias`，`store.ts:272-302`）：開頭父目錄到 home，三種結局（新建、同一個 inode、換掉）
   * 之後都從父目錄到附件根。
   */
  async #publishAlias(objectPath: string, aliasPath: string): Promise<void> {
    const parent = dirname(aliasPath);
    await this.#ensureDurableDirectory(parent, this.#home);
    await this.#linkAlias(objectPath, aliasPath);
    await this.#syncUpToRoot(parent);
  }

  /**
   * 別名已存在就比對它跟物件的 `dev`＋`ino`：同一個 inode 是去重，什麼都不做；不同（物件被刪掉重建過，別名還指著舊的）
   * 就先連到暫存名、再 `rename` 蓋過去，別名一直都在，不會有一段時間讀不到。只比 inode、不重算內容：物件剛在同一次
   * `save` 裡驗過。
   *
   * 這是偏離 1 的產物：dsh 的別名比摘要（`store.ts:283-290`），我們比 inode。
   */
  async #linkAlias(objectPath: string, aliasPath: string): Promise<void> {
    try {
      await link(objectPath, aliasPath);
      return;
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
    }
    const [object, alias] = await Promise.all([stat(objectPath), stat(aliasPath)]);
    if (object.dev === alias.dev && object.ino === alias.ino) return;
    const temp = join(this.#root, 'staging', randomBytes(12).toString('hex'));
    await link(objectPath, temp);
    try {
      await rename(temp, aliasPath);
    } finally {
      // 成功時暫存名已經不在（`unlink` 只拿到 ENOENT，吞掉）。但 `stat` 之後別的上傳搶先把別名修好、兩者已是同一個
      // inode 時，POSIX 規定 `rename` 什麼都不做、直接回成功，暫存名會留在 `staging/`，所以不論成敗都收一次。
      await unlink(temp).catch(() => {});
    }
  }

  /** 串流重算既有物件的摘要（檔案可以很大，不整份讀進記憶體）。 */
  async #verifyObject(path: string, expectedSha256: string): Promise<void> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
    if (hash.digest('hex') !== expectedSha256) {
      throw new AttachmentError(
        `既有物件的內容對不上它的雜湊（sha256:${expectedSha256}），不拿來去重`,
        'ATTACHMENT_CORRUPT',
      );
    }
  }

  /**
   * 建目錄（權限照 {@link #mkdirPrivate}），再從它往上逐層 fsync 父目錄，直到呼叫端擔保已落盤的 `boundary`
   * （dsh `ensureDurableDirectory`，`store.ts:145-169`）。**不看 `mkdir` 回報哪幾層是新建的**：別的行程剛建、還沒
   * fsync 的目錄，在這裡看來是「已存在」，「已存在」不等於「已落盤」。重複 fsync 無害，漏一層有害。
   */
  async #ensureDurableDirectory(path: string, boundary: string): Promise<void> {
    await this.#mkdirPrivate(path);
    for (let level = resolve(path); level !== boundary;) {
      const parent = dirname(level);
      await syncDirectory(parent);
      if (parent === level) return;
      level = parent;
    }
  }

  /** 從 `from` 往上逐層 fsync，到附件根為止（不含根），dsh `store.ts:377-382`。 */
  async #syncUpToRoot(from: string): Promise<void> {
    for (let level = resolve(from); level !== this.#root; level = dirname(level)) {
      await syncDirectory(level);
      if (dirname(level) === level) return;
    }
  }

  async #mkdirPrivate(dir: string): Promise<void> {
    // `recursive` 建出來的每一層都收緊成 0700（mkdir 的 mode 受 umask 影響）；已存在的不動。
    const first = await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (first === undefined) return;
    let current = dir;
    for (;;) {
      await chmod(current, PRIVATE_DIR_MODE);
      if (current === first) return;
      current = join(current, '..');
    }
  }

  /** 第一次用時建好根與三個子目錄並確認根沒有別人改得動的祖先；失敗不快取。 */
  #prepare(): Promise<void> {
    this.#prepared ??= (async () => {
      for (const sub of ['files', 'file-objects', 'staging']) {
        await this.#mkdirPrivate(join(this.#root, sub));
      }
      assertPrivateFile(this.#root, ROOT_ROLE);
    })().catch((error: unknown) => {
      this.#prepared = undefined;
      throw error;
    });
    return this.#prepared;
  }
}
