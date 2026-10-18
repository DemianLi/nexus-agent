import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      // tsdown 編出來的產物（#1502）。相對各套件目錄；`apps/web/src/lib/` 是原始碼，不是這個。
      'lib/**',
      // web vendor 的 solid-glass 元件是上游原樣（sha256 釘在 manifest.json，#1523）：不照我們的規則改，也就不檢查。
      'apps/web/src/vendor/solid-glass/components/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  eslintConfigPrettier,
);
