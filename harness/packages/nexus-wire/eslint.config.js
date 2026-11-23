import base from '../../eslint.config.js';

export default [
  ...base,
  {
    rules: {
      // 照 dsh `.oxlintrc.json` 的同一條，與 `apps/web/eslint.config.js` 相同（#1548）：這個套件跑在瀏覽器裡，
      // 非安全環境（內網用 IP 開的 http:// 頁面）沒有 `crypto.randomUUID`。今天這裡 0 處，規則是擋以後新加的。
      'no-restricted-properties': [
        'error',
        {
          object: 'crypto',
          property: 'randomUUID',
          message:
            '瀏覽器在非安全環境（內網用 IP 開的 http:// 頁面）不給 crypto.randomUUID；改用 crypto.getRandomValues 自己組 UUID v4（做法見 apps/web/src/lib/uuid.ts）。',
        },
      ],
    },
  },
];
