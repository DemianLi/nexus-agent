/**
 * 來源：shadcn registry `sonner`（style new-york，https://ui.shadcn.com/r/styles/new-york-v4/sonner.json），
 * shadcn CLI 4.21.0 `shadcn add … sonner --overwrite`。裝進來就是我們的原始碼，不靠重跑 `shadcn add` 更新。
 * 改過的地方：**拿掉 `next-themes`**，改收 `theme` prop（規格 §4.2 列 36、§6）；容器名稱「通知」（§8）；
 * 圓角用 `--radius-lg`（registry 寫的 `--radius` 我們沒定義）。
 */
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/** `theme` 由呼叫端給（`useThemePreference` 的偏好，`system` 交給 sonner 自己跟系統）。 */
const Toaster = ({
  theme,
  ...props
}: ToasterProps & { theme: NonNullable<ToasterProps['theme']> }) => {
  return (
    <Sonner
      // sonner 跟系統時直接呼叫 `window.matchMedia`，沒有它（jsdom）就拋；那種環境當成淺色。
      theme={theme === 'system' && typeof window.matchMedia !== 'function' ? 'light' : theme}
      containerAriaLabel="通知"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius-lg)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
