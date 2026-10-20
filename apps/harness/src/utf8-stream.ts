/**
 * 把位元組串流解碼成 UTF-8 文字，**碰到不是 UTF-8 的位元組就停**，照 dsh 的 `streamText`（「decodes and rejects non-UTF-8 as
 * it goes」，`packages/fs/fs-local/src/fsio.ts` 的 `streamWholeText`）。
 *
 * 兩個呼叫端共用這一份（[#1530](https://github.com/DemianLi/nexus-agent/issues/1530)）：網頁預覽的 `deliverable-files.ts`，
 * 與讀檔工具走的 `contained-backend.ts`。差別只有 `ignoreBOM`——預覽沿用 `TextDecoder` 預設（吃掉開頭的 BOM），讀檔要保留它
 * （`read_file` 的版本 token 是從基座 `readRaw` 的字串算的，那個字串保留 U+FEFF，兩邊要對得上；理由見 `contained-backend.ts`）。
 *
 * 用 `TextDecoder` 而不是 `createReadStream` 的 `encoding`：後者把壞位元組換成 U+FFFD、不會拒。多位元組字元切在兩片之間由
 * `stream: true` 接住。
 *
 * @module
 */

/** 讀到不是 UTF-8 的位元組時丟出來；呼叫端各自翻成自己的拒絕。 */
export class NotUtf8 extends Error {
  constructor() {
    super('invalid UTF-8 text');
    this.name = 'NotUtf8';
  }
}

/** {@link streamUtf8} 的選項。 */
export interface Utf8StreamOptions {
  /** `true`：開頭的 BOM（U+FEFF）留在輸出裡，不吃掉。預設 `false`，同 `TextDecoder`。 */
  readonly ignoreBOM?: boolean;
}

/**
 * 把位元組片段逐片解碼成文字。
 *
 * 呼叫端提早收手時（`for await` 的 `return`），來源串流跟著關掉，其餘部分不讀。
 *
 * @param source - 位元組片段，例如 `createReadStream` 或 `FileHandle.createReadStream` 的結果。
 * @param options - 見 {@link Utf8StreamOptions}。
 * @throws {NotUtf8} 讀到的位元組不是 UTF-8。
 */
export async function* streamUtf8(
  source: AsyncIterable<Uint8Array>,
  options: Utf8StreamOptions = {},
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: options.ignoreBOM === true });
  const decode = (chunk?: Uint8Array): string => {
    try {
      return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
    } catch {
      throw new NotUtf8();
    }
  };
  for await (const chunk of source) yield decode(chunk);
  const tail = decode();
  if (tail.length > 0) yield tail;
}
