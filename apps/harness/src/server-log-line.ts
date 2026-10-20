/**
 * serve 伺服器日誌的「一行」怎麼拆（[#1534](https://github.com/DemianLi/nexus-agent/issues/1534)）：**純函式、不依賴任何套件**，
 * 測試的 `fixtures.ts` 與樹外的驗證腳本（`scripts/release/verify-packed-install.ts`）共用這一份，不各寫一份解析器。
 *
 * @module
 */

/**
 * serve 的伺服器日誌每一行是 `[yyyy-MM-dd hh:mm:ss ][E|W|I|D] 名字 訊息本文`（#1534，照 dsh 的 `render`）。
 * 測試比的是**訊息本文**，這裡把前綴剝掉。多行訊息的續行縮排是「時間＋`[X]`＋空格」那麼長（`render` 的 `indent`，**不含名字**），一併剝掉。
 * 不是這個形狀的行原樣回傳。
 */
export function serverLogBody(line: string): string {
  const match = /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} )?\[[EWID]\] (\S+) /u.exec(line);
  if (match === null) return line;
  const indent = match[0].length - (match[1] as string).length - 1;
  return line.slice(match[0].length).replace(new RegExp(`\\n {${String(indent)}}`, 'gu'), '\n');
}

/** 一行伺服器日誌的等級字母（`E`／`W`／`I`／`D`）；不是那個形狀回 `undefined`。 */
export function serverLogLevel(line: string): string | undefined {
  return /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} )?\[([EWID])\] \S+ /u.exec(line)?.[1];
}
