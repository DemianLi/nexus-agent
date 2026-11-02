import { pluginLintConfig } from '@nexus/sdk/lint';

import base from '../../eslint.config.js';

// 遷出的插件套用 SDK 的 lint 設定（#1420）：`src/**` 不准 import `@nexus/core`、不准有模組層級的可變狀態。
// 沒有排除——這顆插件沒有相容層的配套入口（#1466）。
export default [...base, ...pluginLintConfig];
