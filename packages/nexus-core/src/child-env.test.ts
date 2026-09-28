/**
 * 子行程環境的清洗。兩個使用者各自走真的子行程量過：git 快照在
 * `packages/nexus-plugin-workspace-changes/src/git.test.ts`，MCP 在 `packages/nexus-plugin-mcp/src/index.test.ts`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { scrubbedParentEnv } from './child-env.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('scrubbedParentEnv', () => {
  it('拿掉名字像憑證的與 `NEXUS_*`，不分大小寫；其餘照留', () => {
    expect(
      scrubbedParentEnv({
        PATH: '/bin',
        HOME: '/h',
        LANG: 'zh_TW.UTF-8',
        HTTPS_PROXY: 'http://proxy.internal:3128',
        OPENAI_API_KEY: 'k',
        GH_TOKEN: 't',
        db_password: 'p',
        MY_SECRET: 's',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        NEXUS_AGENT_HOME: '/n',
        nexus_x: 'x',
        UNDEFINED: undefined,
      }),
    ).toEqual({
      PATH: '/bin',
      HOME: '/h',
      LANG: 'zh_TW.UTF-8',
      HTTPS_PROXY: 'http://proxy.internal:3128',
    });
  });

  it('省略參數時讀呼叫當下的 `process.env`', () => {
    vi.stubEnv('KEEP_ME', 'yes');
    vi.stubEnv('FAKE_API_TOKEN', 'leak');
    const env = scrubbedParentEnv();
    expect(env['KEEP_ME']).toBe('yes');
    expect(env).not.toHaveProperty('FAKE_API_TOKEN');
  });
});
