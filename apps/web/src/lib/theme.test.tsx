import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ThemeToggle } from '@/components/theme-toggle';
import { useThemePreference } from '@/hooks/use-theme-preference';
import { applyTheme, readThemePreference, THEME_PREFERENCE_KEY } from '@/lib/theme';

/**
 * `.docs/web-ui-spec.md` §11 第 9–11 條。套用邏輯有兩份（`index.html` 的內嵌腳本與 `lib/theme.ts`），
 * 下面每一格兩份都跑：key 對不上或判斷分岔時，畫面不會壞，只會每次開都閃一下，沒人會發現。
 */

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

/** Node 25 自帶的全域 `localStorage` 會蓋住 jsdom 的，每條測試給一份乾淨的（同 `App.test.tsx`）。 */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

/** jsdom 沒有 `matchMedia`；給一個會回報 `dark` 的，並能事後改值、發 change。 */
function stubSystem(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', (media: string) => {
    expect(media).toBe('(prefers-color-scheme: dark)');
    return query;
  });
  return (next: boolean) => {
    query.matches = next;
    listeners.forEach((listener) => listener());
  };
}

function applied() {
  const root = document.documentElement;
  return { dark: root.classList.contains('dark'), colorScheme: root.style.colorScheme };
}

const COPIES = {
  內嵌腳本: () => new Function(inlineScript)() as void,
  'lib/theme.ts': () => applyTheme(readThemePreference()),
};

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  document.documentElement.className = '';
  document.documentElement.style.colorScheme = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('亮暗三態', () => {
  test('第 9 條：內嵌腳本讀的是同一個 key', () => {
    expect(inlineScript).not.toBe('');
    const keys = [...inlineScript.matchAll(/localStorage\.getItem\((['"])(.*?)\1\)/g)].map(
      (m) => m[2],
    );
    expect(keys).toEqual([THEME_PREFERENCE_KEY]);
  });

  describe.each(Object.entries(COPIES))('%s', (_, apply) => {
    test.each([
      ['light', false, false],
      ['light', true, false],
      ['dark', false, true],
      ['dark', true, true],
      ['system', false, false],
      ['system', true, true],
    ] as const)('第 10 條：存了 %s、系統深色 %s → 深色 %s', (stored, systemDark, dark) => {
      stubSystem(systemDark);
      localStorage.setItem(THEME_PREFERENCE_KEY, stored);
      apply();
      expect(applied()).toEqual({ dark, colorScheme: dark ? 'dark' : 'light' });
    });

    test('淺色會把先前掛上的 .dark 拿掉', () => {
      document.documentElement.classList.add('dark');
      stubSystem(true);
      localStorage.setItem(THEME_PREFERENCE_KEY, 'light');
      apply();
      expect(applied()).toEqual({ dark: false, colorScheme: 'light' });
    });

    test('第 11 條：沒存過偏好時跟隨系統', () => {
      stubSystem(true);
      apply();
      expect(applied()).toEqual({ dark: true, colorScheme: 'dark' });
    });

    test('存的東西不認得時也跟隨系統', () => {
      stubSystem(true);
      localStorage.setItem(THEME_PREFERENCE_KEY, '"dark"');
      apply();
      expect(applied()).toEqual({ dark: true, colorScheme: 'dark' });
    });

    test('沒有 matchMedia、讀 localStorage 會拋時退成淺色，不拋錯', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
      expect(apply).not.toThrow();
      expect(applied()).toEqual({ dark: false, colorScheme: 'light' });
    });
  });
});

describe('切換鈕', () => {
  test('循環：跟隨系統 → 淺色 → 深色 → 跟隨系統，並存起來', () => {
    stubSystem(true);
    render(<ThemeToggle />);
    const button = screen.getByRole('button');
    screen.getByRole('button', { name: '目前：跟隨系統，按一下改成淺色' });
    expect(applied().dark).toBe(true);

    fireEvent.click(button);
    screen.getByRole('button', { name: '目前：淺色，按一下改成深色' });
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe('light');
    expect(applied()).toEqual({ dark: false, colorScheme: 'light' });

    fireEvent.click(button);
    screen.getByRole('button', { name: '目前：深色，按一下改成跟隨系統' });
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe('dark');
    expect(applied()).toEqual({ dark: true, colorScheme: 'dark' });

    fireEvent.click(button);
    screen.getByRole('button', { name: '目前：跟隨系統，按一下改成淺色' });
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe('system');
  });

  test('跟隨系統時系統偏好一變就跟著變；選定淺色後不再跟', () => {
    const setSystem = stubSystem(false);
    render(<ThemeToggle />);
    expect(applied().dark).toBe(false);

    act(() => setSystem(true));
    expect(applied()).toEqual({ dark: true, colorScheme: 'dark' });

    fireEvent.click(screen.getByRole('button'));
    act(() => setSystem(true));
    expect(applied().dark).toBe(false);
  });

  test('別的分頁改了偏好時跟著改', () => {
    stubSystem(false);
    render(<ThemeToggle />);
    localStorage.setItem(THEME_PREFERENCE_KEY, 'dark');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_PREFERENCE_KEY }));
    });
    screen.getByRole('button', { name: '目前：深色，按一下改成跟隨系統' });
    expect(applied().dark).toBe(true);
  });

  test('沒有 matchMedia 時照樣掛得起來（現有測試都不 stub 它）', () => {
    render(<ThemeToggle />);
    screen.getByRole('button', { name: '目前：跟隨系統，按一下改成淺色' });
    expect(applied().dark).toBe(false);
  });
});

describe('同一分頁的多個使用者', () => {
  function Probe() {
    const [preference] = useThemePreference();
    return <output aria-label="偏好">{preference}</output>;
  }

  test('切換鈕按下去，別的元件（例如 Toaster）讀到同一份', () => {
    stubSystem(false);
    render(
      <>
        <ThemeToggle />
        <Probe />
      </>,
    );
    expect(screen.getByLabelText('偏好').textContent).toBe('system');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByLabelText('偏好').textContent).toBe('light');
  });

  test('寫不進 localStorage 時，這次的選擇留在這個分頁', () => {
    stubSystem(false);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <>
        <ThemeToggle />
        <Probe />
      </>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByLabelText('偏好').textContent).toBe('light');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByLabelText('偏好').textContent).toBe('dark');
    expect(applied().dark).toBe(true);
    // 別的分頁改了偏好就讓位（清掉只留在這個分頁的那一份）。
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_PREFERENCE_KEY }));
    });
    expect(screen.getByLabelText('偏好').textContent).toBe('system');
  });
});
