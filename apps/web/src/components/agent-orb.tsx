import type { CSSProperties } from 'react';

/**
 * 代理的 orb（`.docs/web-ui-spec.md` §7：P0 只做 working 與 breathing）。樣式與 reduced-motion 在
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
  readonly state: 'working' | 'breathing';
  readonly size: 20 | 64;
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
