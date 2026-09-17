/**
 * PROTOTYPE #375 — 切換設定、兩種 button、動效的包裝。
 *
 * 動效照「動效策略」（#378）：純 CSS、不裝 thinking-orbs／border-beam；樣式都在 tokens.css。
 */

import { cn } from 'cn';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';

import { Button as OldButton } from './old-button';

export interface Settings {
  approval: 'card' | 'takeover';
  motion: 'system' | 'full' | 'reduce';
  theme: 'light' | 'dark';
  button: 'new' | 'old';
}

export const OPTIONS = {
  approval: [
    ['takeover', '取代輸入框（#376 定案）'],
    ['card', '卡片（舊）'],
  ],
  motion: [
    ['system', '跟系統'],
    ['full', '完整'],
    ['reduce', '減少動態'],
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

const DEFAULTS: Settings = {
  approval: 'takeover',
  motion: 'system',
  theme: 'dark',
  button: 'new',
};

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
      try {
        window.history.replaceState(null, '', `?${params.toString()}`);
      } catch {
        // 沙盒 iframe 裡改不了網址：設定照樣生效，只是分享不出去
      }
      return next;
    });
  }, []);
  return [settings, update];
}

export const SettingsContext = createContext<Settings>(DEFAULTS);

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 算出這一刻要不要減少動態，並寫到 `<html data-reduce-motion>`。
 * 原型讓切換列可以模擬；實作直接寫 `@media (prefers-reduced-motion: reduce)`，不需要這個 hook。
 */
export function useReducedMotion(setting: Settings['motion']): boolean {
  const [system, setSystem] = useState(() => window.matchMedia(REDUCE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(REDUCE_QUERY);
    const onChange = () => setSystem(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const reduce = setting === 'reduce' || (setting === 'system' && system);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-reduce-motion', reduce);
  }, [reduce]);
  return reduce;
}

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

/** P0 只有 working 與 breathing（#378 Q10）：搜尋類工具併進 working，composing／connecting 等 P1。 */
export function AgentOrb({
  state,
  size,
  label,
}: {
  state: 'working' | 'breathing';
  size: 20 | 64;
  label: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      className="proto-orb"
      data-state={state}
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

/** 換內容：舊的縮到 .99 淡出（150），新的往上 8px、從 .97 長出來（250）。 */
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
    <div key={shownKey} className="motion-swap" data-phase={leaving ? 'out' : 'in'}>
      {leaving ? last.current : children}
    </div>
  );
}

/**
 * resize：內容高度變了，外框從舊高度用 300 smooth-out 走到新高度。
 * 只在變化期間裁切（`data-resizing`），平常不擋卡片的陰影與邊框光。
 * reduced-motion 下直接到位。
 */
export function AutoHeight({ children, className }: { children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const outerEl = outer.current;
    const innerEl = inner.current;
    if (outerEl === null || innerEl === null) return;
    let last = innerEl.offsetHeight;
    let fallback: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      clearTimeout(fallback);
      outerEl.style.height = '';
      outerEl.removeAttribute('data-resizing');
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === outerEl && event.propertyName === 'height') finish();
    };
    const observer = new ResizeObserver(() => {
      const next = innerEl.offsetHeight;
      const previous = outerEl.hasAttribute('data-resizing') ? outerEl.offsetHeight : last;
      last = next;
      if (previous === next) return;
      if (document.documentElement.hasAttribute('data-reduce-motion')) return finish();
      outerEl.style.height = `${previous}px`;
      outerEl.setAttribute('data-resizing', '');
      void outerEl.offsetHeight; // 先讓瀏覽器認得起點
      outerEl.style.height = `${next}px`;
      clearTimeout(fallback);
      fallback = setTimeout(finish, 400);
    });
    observer.observe(innerEl);
    outerEl.addEventListener('transitionend', onEnd);
    return () => {
      observer.disconnect();
      outerEl.removeEventListener('transitionend', onEnd);
      clearTimeout(fallback);
    };
  }, []);

  return (
    <div ref={outer} className={cn('motion-resize', className)}>
      <div ref={inner}>{children}</div>
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
