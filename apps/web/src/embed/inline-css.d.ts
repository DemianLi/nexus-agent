// embed 建置的 `?inline` CSS 多一個具名匯出（`embed-shadow-css.ts` 的外掛）：預設匯出是放進 shadow root 的那份，
// `documentCss` 是要放進宿主頁 `<head>` 的 `@font-face` 與 `@property`。
declare module '*.css?inline' {
  const shadow: string;
  export default shadow;
  export const documentCss: string;
}
