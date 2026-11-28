import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

const LOOP_AGENT_NAMES = 'LoopAgent|PumpAgent|BackgroundAgent|RestorableAgent|NexusAgent';

export const loopAgentCastGuard = {
  files: ['src/**/*.ts'],
  ignores: ['**/*.test.ts', '**/*.fixture.ts', '**/*.test.helper.ts'],
  rules: {
    'no-restricted-syntax': [
      'error',
      ...['TSAsExpression', 'TSTypeAssertion'].map((node) => ({
        selector: `${node}[typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name=/^(${LOOP_AGENT_NAMES})$/]`,
        message:
          '不准把東西轉型成 LoopAgent 或它的別名：兩條 loop 各自 implements LoopAgent，由編譯器檢查；LangGraph 的圖用 adaptLangGraph 包。',
      })),
    ],
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      // tsdown 編出來的產物（#1502）。相對各套件目錄；`web/src/lib/` 是原始碼，不是這個。
      'lib/**',
      // web vendor 的 solid-glass 元件是上游原樣（sha256 釘在 manifest.json，#1523）：不照我們的規則改，也就不檢查。
      'web/src/vendor/solid-glass/components/**',
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
