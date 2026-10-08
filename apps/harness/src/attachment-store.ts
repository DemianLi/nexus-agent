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
 *
 * ## 偏離（依 AGENTS.md 登記）
 *
 * 1. **模型讀它走虛擬前綴 {@link ATTACHMENTS_PREFIX}，不是主機絕對路徑。** 同 `tool-result-stash.ts`：路徑是 `CompositeBackend`
 *    的一條唯讀路由（根是 `<root>/files`），圍欄看不到的主機路徑不出現在模型面前，續接之後同一個路徑照讀。dsh 的 `read_file`
 *    收到的是主機路徑（它的檔案工具不在工作區圍欄裡）；我們的 backend 有圍欄，所以走路由。基座表達不出的是「圍欄外的絕對路徑」。
 * 2. **這一刀沒有圖片的正規化／縮圖。** dsh 在收下時把圖轉成 8-bit sRGB 並縮小（`normalization.ts`）；那是圖片那一刀的事。
 * 3. **沒有逐會話目錄**：dsh 的附件根也是全域內容定址（`attachments/v1`），不按會話分。同一個使用者的不同會話讀得到彼此的
 *    附件（要知道內容雜湊才能點到單一檔，但 `ls` 列得出來）；多人共用主機的隔離靠 `0700`，不靠會話。
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { ContainedFilesystemBackend } from './contained-backend.js';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './owner-only.js';
import { assertPrivateFile } from './plugin-config.js';
import type { PrivateFileRole } from './plugin-config.js';

/** 附件根在 harness home 底下的名字；`v1` 是目錄佈局的版本。 */
export const ATTACHMENTS_DIR_NAME = 'attachments';
export const ATTACHMENTS_LAYOUT_VERSION = 'v1';

/** 模型讀附件的虛擬前綴（沒有結尾斜線；路由鍵加斜線，見 `agent-factory.ts`）。 */
export const ATTACHMENTS_PREFIX = '/attachments';

/** 物件檔的權限：只讀，只有擁有者。 */
const OBJECT_FILE_MODE = 0o400;

const ATTACHMENT_ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

const ROOT_ROLE: PrivateFileRole = {
  subject: '附件目錄',
  why: '別人換得掉這個目錄底下的檔，模型就會讀到被換過的內容。',
};

/** 一份存好的檔案的參照；日誌與訊息只留這個。 */
export interface FileAttachmentRef {
  /** `sha256:<64 位十六進位>`，內容定址。 */
  readonly attachmentId: string;
  /** 清過的葉名。 */
  readonly name: string;
  /** 確切位元組數。 */
  readonly bytes: number;
}

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
  'INVALID_ATTACHMENT_REF' | 'ATTACHMENT_TOO_LARGE' | 'ATTACHMENT_STORE_FAILED';

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

/** 本機附件儲存。一個行程一份，可以並行呼叫。 */
export class AttachmentStore {
  readonly #root: string;
  #prepared: Promise<void> | undefined;

  /** @param rootDir - 絕對路徑，通常是 {@link attachmentsRootOf}。 */
  constructor(rootDir: string) {
    this.#root = rootDir;
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
   */
  async readOnlyRoute(): Promise<ContainedFilesystemBackend> {
    await this.#prepare();
    return new ContainedFilesystemBackend({ rootDir: this.filesDir, mode: 'read-only' });
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
        const objectPath = join(
          this.#root,
          'file-objects',
          staged.sha256.slice(0, 2),
          staged.sha256,
        );
        await this.#publish(staged.path, objectPath);
        // 去重走到這裡也要把模式收回唯讀：先寫的那一個如果被人 chmod 過，這裡恢復。
        await chmod(objectPath, OBJECT_FILE_MODE);
        const ref: FileAttachmentRef = {
          attachmentId: `sha256:${staged.sha256}`,
          name,
          bytes: staged.bytes,
        };
        const aliasDir = join(this.filesDir, staged.sha256.slice(0, 2), staged.sha256);
        await this.#mkdirPrivate(aliasDir);
        await this.#publish(objectPath, join(aliasDir, name));
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

  async #stage(
    data: AsyncIterable<Uint8Array> | Uint8Array,
    signal: AbortSignal | undefined,
    maxBytes: number | undefined,
  ): Promise<{ path: string; sha256: string; bytes: number }> {
    const path = join(this.#root, 'staging', randomBytes(12).toString('hex'));
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

  /** `link` 進正式位置；目標已存在就是去重，不算錯。 */
  async #publish(source: string, target: string): Promise<void> {
    await this.#mkdirPrivate(join(target, '..'));
    try {
      await link(source, target);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
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
