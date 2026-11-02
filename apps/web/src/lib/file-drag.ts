/**
 * 整頁拖放的判斷（#733）：拖進視窗的東西是不是檔案。
 *
 * 拖一段文字或一個連結進來也會觸發 `dragenter`，那時**不能**出提示、也不能吞掉事件（輸入框本來就收文字）。
 * 判準是 `dataTransfer.types` 含 `'Files'`——`dragenter` 與 `dragover` 階段瀏覽器不讓讀檔案內容，只讓讀 types。
 */
export function dragHasFiles(types: readonly string[] | undefined): boolean {
  return types?.includes('Files') === true;
}
