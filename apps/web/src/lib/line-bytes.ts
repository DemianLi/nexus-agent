/**
 * 用位元組窗口讀一條超長的行（[#555](https://github.com/DemianLi/nexus-agent/issues/555)）：位元組位置、base64、
 * 跨窗口的解碼。
 *
 * 文字頁讀不動一行本身就超過頁上限的檔（按行切永遠是 413），所以那一行改走位元組窗口
 * （`deliverableBytesPath`，照 dsh 的 `readBytes`）。窗口**不解碼、不擋二進位**，而「是不是文字」的判準要跟
 * 文字頁同一套——同一個檔不該因為哪一行比較長就換一個判準。所以這裡照路由 `streamUtf8`／`cutPage` 的規則：
 *
 * - **行只按 `\n` 切**，`\r` 留在行裡。
 * - **`fatal` 解碼**，讀到不是 UTF-8 的位元組就是「不是文字」；**NUL 也是**。
 * - **先在位元組層切到 `\n`，才解碼與掃 NUL**：一個窗口可能讀過換行、帶到下一行的開頭，那一截可能停在字元
 *   中間（拿去 `fatal` 解碼會誤判），也可能含下一行的 NUL（會算到這一行頭上）。UTF-8 的多位元組序列裡不會出現
 *   `0x0A`，所以在位元組層找換行是安全的。
 * - **字元可能被切在兩個窗口之間**：解碼器跨窗口用 `stream: true` 接起來，讀到換行或檔尾才 flush。
 * - **BOM 只在檔頭吃**：路由的解碼器從檔頭開始、預設吃掉開頭的 BOM；一行從檔中間開始時，開頭的 `EF BB BF`
 *   是一個真的 U+FEFF，不能吃（`ignoreBOM`）。
 *
 * @module
 */

/**
 * 一段文字的 UTF-8 位元組數，不必真的編碼一次。
 *
 * 輸入來自 `fatal` 解碼的結果，所以不會有落單的代理；一對代理是 4 位元組。
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** base64 → 位元組。 */
export function bytesOfBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 檔頭的 UTF-8 BOM。 */
export const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/** 位元組開頭是不是 UTF-8 BOM。 */
export function startsWithBom(bytes: Uint8Array): boolean {
  return UTF8_BOM.every((byte, i) => bytes[i] === byte);
}

/** 一個窗口接進這一行之後的結果。 */
export type LineChunk =
  | {
      readonly kind: 'text';
      /** 這個窗口解出來的文字（可能是空字串：窗口只帶到半個字元）。 */
      readonly text: string;
      /** 這一行用掉了窗口裡幾個位元組，不含結尾的 `\n`。 */
      readonly consumed: number;
      /** 這一行讀完了：碰到 `\n` 或檔尾。 */
      readonly done: boolean;
    }
  | { readonly kind: 'not-text' };

/** 一條行的解碼器，跨窗口接起來。 */
export interface LineDecoder {
  /**
   * 接一個窗口。
   *
   * @param bytes - 窗口裡的位元組，從這一行還沒讀的地方開始。
   * @param eof - 這個窗口含檔案的最後一個位元組。
   */
  push(bytes: Uint8Array, eof: boolean): LineChunk;
}

/**
 * @param atFileStart - 這一行從檔案的第 0 個位元組開始；只有這時候開頭的 BOM 要吃掉，同路由。
 */
export function createLineDecoder(atFileStart: boolean): LineDecoder {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: !atFileStart });
  return {
    push(bytes, eof) {
      const newline = bytes.indexOf(0x0a);
      const line = newline === -1 ? bytes : bytes.subarray(0, newline);
      if (line.includes(0)) return { kind: 'not-text' };
      const done = newline !== -1 || eof;
      let text: string;
      try {
        text = decoder.decode(line, { stream: !done });
      } catch {
        return { kind: 'not-text' };
      }
      return { kind: 'text', text, consumed: line.length, done };
    },
  };
}
