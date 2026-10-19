import { pluginLintConfig } from '@nexus/sdk/lint';

import base from '../../eslint.config.js';

// 遷出的插件套用 SDK 的 lint 設定（#1420）：排在 base 後面，parser 由 base 提供。
export default [...base, ...pluginLintConfig];
