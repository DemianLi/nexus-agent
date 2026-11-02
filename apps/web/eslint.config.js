import base from '../../eslint.config.js';

export default [
  ...base,
  {
    rules: {
      // 照 dsh `.oxlintrc.json` 的同一條（#1548）。範圍只到會跑在瀏覽器裡的程式碼（這裡與 `@nexus/wire`），不照 dsh 放全 repo：
      // harness 跑在 Node 上，`crypto.randomUUID` 一定有。測試不排除：模擬非安全環境的測試也該走同一支。
      'no-restricted-properties': [
        'error',
        {
          object: 'crypto',
          property: 'randomUUID',
          message:
            '瀏覽器在非安全環境（內網用 IP 開的 http:// 頁面）不給 crypto.randomUUID；改用 @/lib/uuid 的 randomUuid()。',
        },
      ],
    },
  },
];
