/**
 * 從日誌還原記過的壓縮動作時，讀到形狀壞掉的事件：錯誤訊息帶事件種類與 `seq`。
 *
 * 讀日誌拋的錯不吞（工具結果修剪、參數截斷兩層都不吞；吞了模型所見就與日誌分家），所以壞掉的那一顆會讓這條對話每一步都失敗，
 * 一直到日誌被修。訊息帶事件種類與 `seq`，維運的人才認得出是哪份日誌的哪一種事件壞了。
 *
 * @module
 */

/**
 * 跑一段讀這顆事件內容的程式；拋了就換成帶事件種類與 `seq` 的錯，`cause` 是原錯。
 *
 * @param event - 正在讀的那一顆。
 * @param read - 讀它內容的那一段。
 * @returns `read` 的回傳。
 * @throws `read` 拋的錯，訊息變成 `<種類> 事件讀不出來（seq N）：<原訊息>`。
 */
export function readingEvent<T>(
  event: { readonly type: string; readonly seq: number },
  read: () => T,
): T {
  try {
    return read();
  } catch (cause) {
    throw new Error(
      `${event.type} 事件讀不出來（seq ${event.seq}）：${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
