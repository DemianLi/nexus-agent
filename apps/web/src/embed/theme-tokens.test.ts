import { afterEach, describe, expect, it, vi } from 'vitest';

import { themeOverrides } from './theme-tokens';

const ROOT: Readonly<Record<string, string>> = {
  '--primary-foreground': '#ffffff',
  '--foreground': '#111111',
};

function reader(host: Readonly<Record<string, string>>) {
  return {
    host: (property: string) => host[property] ?? '',
    root: (property: string) => ROOT[property] ?? '',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('themeOverrides', () => {
  it('只收白名單上的四個，沒寫的不套', () => {
    expect(
      themeOverrides(
        reader({
          '--nexus-primary': '#1e3a8a',
          '--nexus-radius': '6px',
          '--nexus-font': 'serif',
          '--nexus-accent': 'red',
        }),
        'light',
      ),
    ).toEqual([
      ['--primary', '#1e3a8a'],
      ['--radius', '6px'],
      ['font-family', 'serif'],
    ]);
  });

  it('主色跟主按鈕的字對比不到 4.5 就不套，console 講是哪一個', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 淺黃底白字約 1.1。
    expect(themeOverrides(reader({ '--nexus-primary': '#fef08a' }), 'dark')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/--nexus-primary.*暗色.*--primary-foreground.*4\.5/u);
  });

  it('底色跟內文對比不到 4.5 就不套；解不出顏色也不套', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      themeOverrides(
        reader({ '--nexus-background': '#222222', '--nexus-primary': 'nope' }),
        'light',
      ),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('對比度夠的底色照套', () => {
    expect(themeOverrides(reader({ '--nexus-background': '#fafaf9' }), 'light')).toEqual([
      ['--background', '#fafaf9'],
    ]);
  });
});
