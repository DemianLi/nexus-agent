/**
 * nexus 層（#1680 PR A）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/sonner.tsx`），外觀照 SG（#1468 Q8），
 * 圓角跟著 SG 的 `--radius`、toast 帶 `cn-toast`。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」：
 *
 * - 主題由呼叫端給，不靠 `next-themes`（規格 §6，Q19 保留）：vendor 檔 import `useTheme` 拿不掉，所以改 vendor 檔
 *   （第 49 條，`patches/0010-sonner-theme-prop.patch`）。
 * - 這一層（第 50 條）：`theme` 必填（`useThemePreference` 的偏好，`system` 交給 sonner 自己跟系統）；容器名稱「通知」（§8）；
 *   沒有 `window.matchMedia` 的環境（jsdom）把 `system` 當成淺色——sonner 跟系統時直接呼叫它，沒有就拋。
 */
import type { ToasterProps } from 'sonner';

import { Toaster as VendorToaster } from '@/vendor/solid-glass/components/ui/sonner';

const Toaster = ({
  theme,
  ...props
}: ToasterProps & { theme: NonNullable<ToasterProps['theme']> }) => (
  <VendorToaster
    theme={theme === 'system' && typeof window.matchMedia !== 'function' ? 'light' : theme}
    containerAriaLabel="通知"
    {...props}
  />
);

export { Toaster };
