import type { CSSProperties } from 'react';

/**
 * 代理的 orb，只剩空白 hero 的 breathing（`.docs/web-ui-spec.md` §7）。狀態列執行中那顆 working 隨 #1684 換成 SG 的
 * `StatusGlyph`（`components/ui/turn-status.tsx`）；glyph 的語意是「這一輪正在跑」，放在待命畫面上會說謊，所以這顆不換。樣式與 reduced-motion 在
 * `styles/motion.css` 的 `.agent-orb`；元件照原型 tag `proto-375-design-language` 的 `kit.tsx` 重寫。
 *
 * 旁邊已經有同義的文字時設 `decorative`：不然螢幕閱讀器會唸兩次（§8）。
 */
export function AgentOrb({
  state,
  size,
  label,
  decorative = false,
}: {
  readonly state: 'breathing';
  readonly size: 64;
  readonly label?: string;
  readonly decorative?: boolean;
}) {
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      className="agent-orb"
      data-state={state}
      style={{ '--orb-size': `${size}px` } as CSSProperties}
    />
  );
}
