/**
 * PROTOTYPE #375 — 切換設定、兩種 button、兩種動效的包裝。
 */

import { BorderBeam } from 'border-beam';
import { cn } from 'cn';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { ThinkingOrb } from 'thinking-orbs';

import { Button } from '@/components/ui/button';

import { Button as OldButton } from './old-button';

export interface Settings {
  approval: 'card' | 'takeover';
  motion: 'pkg' | 'css';
  theme: 'light' | 'dark';
  button: 'new' | 'old';
}

export const OPTIONS = {
  approval: [
    ['card', '卡片（現況）'],
    ['takeover', '取代輸入框（dsh）'],
  ],
  motion: [
    ['pkg', '套件 orbs＋beam'],
    ['css', '純 CSS 仿'],
  ],
  theme: [
    ['dark', '暗'],
    ['light', '亮'],
  ],
  button: [
    ['new', 'registry 新版'],
    ['old', '覆寫前舊版'],
  ],
} as const satisfies Record<keyof Settings, readonly (readonly [string, string])[]>;

const DEFAULTS: Settings = { approval: 'card', motion: 'pkg', theme: 'dark', button: 'new' };

function readSettings(): Settings {
  const params = new URLSearchParams(window.location.search);
  const pick = <K extends keyof Settings>(key: K): Settings[K] => {
    const value = params.get(key);
    return (
      OPTIONS[key].some(([option]) => option === value) ? value : DEFAULTS[key]
    ) as Settings[K];
  };
  return {
    approval: pick('approval'),
    motion: pick('motion'),
    theme: pick('theme'),
    button: pick('button'),
  };
}

/** 設定寫進網址：分享得出去、重新整理還在。 */
export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState(readSettings);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      const params = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(next)) params.set(key, value);
      window.history.replaceState(null, '', `?${params.toString()}`);
      return next;
    });
  }, []);
  return [settings, update];
}

export const SettingsContext = createContext<Settings>(DEFAULTS);

/** 依切換列選的版本畫新版或舊版 button。registry 元件自己 import 的 button 不受影響。 */
export function PButton({ size, ...props }: ComponentProps<typeof Button>) {
  const { button } = useContext(SettingsContext);
  if (button === 'new') return <Button size={size} {...props} />;
  const oldSize =
    size === 'icon-xs' || size === 'icon-sm' || size === 'icon-lg'
      ? 'icon'
      : size === 'xs'
        ? 'sm'
        : size;
  return <OldButton size={oldSize} {...props} />;
}

export function AgentOrb({
  state,
  size,
  label,
}: {
  state: 'working' | 'searching' | 'composing' | 'breathing';
  size: 20 | 64;
  label: string;
}) {
  const { motion } = useContext(SettingsContext);
  if (motion === 'pkg') return <ThinkingOrb state={state} size={size} aria-label={label} />;
  return (
    <span
      role="img"
      aria-label={label}
      className="proto-orb"
      data-state={state === 'searching' ? 'working' : state}
      style={{ '--orb-size': `${size}px` } as CSSProperties}
    />
  );
}

export function Beam({
  kind,
  active,
  radius,
  className,
  children,
}: {
  kind: 'run' | 'pending';
  active: boolean;
  radius: number;
  className?: string;
  children: ReactNode;
}) {
  const { motion, theme } = useContext(SettingsContext);
  if (motion === 'pkg') {
    return (
      <BorderBeam
        size={kind === 'run' ? 'md' : 'pulse-inner'}
        colorVariant={kind === 'run' ? 'colorful' : 'ocean'}
        theme={theme}
        active={active}
        borderRadius={radius}
        className={className}
      >
        {children}
      </BorderBeam>
    );
  }
  return (
    <div
      className={cn('proto-beam', className)}
      data-kind={kind}
      data-active={active}
      style={{ borderRadius: radius }}
    >
      {children}
    </div>
  );
}

/** 換內容時舊的先縮一點淡出（150ms），新的再長出來（250ms）。 */
export function Swap({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  const [shownKey, setShownKey] = useState(swapKey);
  const last = useRef(children);
  const leaving = swapKey !== shownKey;
  if (!leaving) last.current = children;

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setShownKey(swapKey), 150);
    return () => clearTimeout(timer);
  }, [leaving, swapKey]);

  return (
    <div key={shownKey} className="proto-swap" data-phase={leaving ? 'out' : 'in'}>
      {leaving ? last.current : children}
    </div>
  );
}

export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}
