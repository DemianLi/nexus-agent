/**
 * nexus 層（#1591）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/composer.tsx`），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」；這個檔沒有本地修改。改 vendor 檔的有三條：
 *
 * - 第 28 條 `patches/0004-composer-textarea-props.patch`：回補上游 `c60cb14f` 的 `textareaProps`（輸入框的名稱與描述）。
 * - 第 29 條 `patches/0005-composer-combobox.patch`：`textareaProps` 再收 `aria-controls`／`aria-activedescendant`（`/`、`@`
 *   選單的 combobox 語意），加上 `textareaRef`（從外面把焦點放回輸入框）。
 * - 第 32 條 `patches/0006-composer-width-resize.patch`：回補上游 `e867a7a9`，寬度變了（打開右側欄）高度跟著重算。
 *
 * 產品的輸入框（按鍵、選單、附件、主按鈕的轉接）在 `components/composer.tsx`，不在這一層。
 */
export {
  Composer,
  ComposerFooter,
  ComposerFooterEnd,
  ComposerPick,
} from '@/vendor/solid-glass/components/ui/composer';
