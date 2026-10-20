/**
 * nexus 層（#1638 PR B）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/message-scroller.tsx`），外觀照 SG（#1468 Q8）。
 * 這個檔是一行轉出，沒有本地修改。捲到最新的按鈕原本有一條（第 41 條，動效照 nexus 的 §7），④ 收尾換全域動效時撤掉，
 * 改回 vendor 原樣（#1687）：藏著時 `translate-y-full`、`scale-95`。浮鈕的避讓（`hooks/use-scroll-button-clearance.ts`）
 * 因此在過渡跑完、或 `data-active` 一換時各重量一次，見那個檔的檔頭。
 *
 * 跟它有關的本地修改都不在這個檔：
 * - 報讀字串「捲到最新的訊息」「捲到最早的訊息」是改 vendor 檔（第 44 條，`patches/0009-message-scroller-scroll-label.patch`）。
 * - item 的 `[content-visibility:auto]` 由覆寫檔壓成 `visible`（第 42 條，`styles/solid-glass.overrides.css`）：paint containment
 *   會把卡片陰影與光暈切成直角（Q6、§9）。
 * - viewport 的底部淡出（`scroll-fade-b`）在不支援 scroll-driven 動畫的瀏覽器歸 0、不常駐（第 43 條，同一個覆寫檔）。
 *
 * 自動捲動時 vendor 只把捲軸換成透明（`scrollbar-thumb-transparent`／`scrollbar-track-transparent` 只設 `scrollbar-color`），不改捲軸寬，
 * 所以 #1363 不用本地修改；`registry-edits.test.ts` 釘 vendor 原文，`scripts/check-built-css.mjs` 掃產物。
 * 依賴 `@shadcn/react` 的 primitive：viewport 預設 `role="region"`、content 預設 `role="log"`。
 */
export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from '@/vendor/solid-glass/components/ui/message-scroller';
