import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useThemePreference } from '@/hooks/use-theme-preference';
import { NEXT_THEME, THEME_LABEL } from '@/lib/theme';

const ICON = { system: Monitor, light: Sun, dark: Moon };

/**
 * header 右上的亮暗切換：一顆鈕循環三態，圖示顯示**目前**這一態（§6）。
 * 不做下拉選單：為三個選項多一層選單、多一套焦點管理不划算（#391）。切換不做動效。
 */
export function ThemeToggle() {
  const [preference, cycle] = useThemePreference();
  const Icon = ICON[preference];
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={`目前：${THEME_LABEL[preference]}，按一下改成${THEME_LABEL[NEXT_THEME[preference]]}`}
      onClick={cycle}
    >
      <Icon aria-hidden />
    </Button>
  );
}
