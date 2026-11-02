/**
 * 子行程環境的清洗。兩個使用者各自走真的子行程量過：git 快照在
 * `packages/nexus-plugin-workspace-changes/src/git.test.ts`，MCP 在 `packages/nexus-plugin-mcp/src/index.test.ts`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { scrubbedParentEnv } from './child-env.js';
import { installProxyFromEnvironment } from './http-proxy/install.js';

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

  describe('代理那一層（#746）', () => {
    const lookup = (values: Record<string, string>) => ({
      get: (name: string) => (name in values ? { value: values[name]! } : undefined),
    });

    it('沒裝代理：不補旗標，代理變數原樣', () => {
      vi.stubEnv('HTTPS_PROXY', 'http://proxy.internal:3128');
      vi.stubEnv('NODE_USE_ENV_PROXY', undefined);
      Reflect.deleteProperty(process.env, 'NODE_USE_ENV_PROXY');
      const env = scrubbedParentEnv();
      expect(env['HTTPS_PROXY']).toBe('http://proxy.internal:3128');
      expect(env).not.toHaveProperty('NODE_USE_ENV_PROXY');
    });

    it('裝了代理：補旗標；只設 ALL_PROXY 時子行程拿到解析後的 HTTP_PROXY', async () => {
      for (const name of [
        'HTTP_PROXY',
        'http_proxy',
        'HTTPS_PROXY',
        'https_proxy',
        'ALL_PROXY',
        'all_proxy',
      ]) {
        vi.stubEnv(name, undefined);
        Reflect.deleteProperty(process.env, name);
      }
      const dispose = await installProxyFromEnvironment(
        lookup({ ALL_PROXY: 'http://all.internal:3128' }),
        () => undefined,
      );
      try {
        const env = scrubbedParentEnv();
        expect(env['NODE_USE_ENV_PROXY']).toBe('1');
        expect(env['HTTP_PROXY']).toBe('http://all.internal:3128');
        expect(env['HTTPS_PROXY']).toBe('http://all.internal:3128');
      } finally {
        await dispose();
      }
      expect(scrubbedParentEnv()).not.toHaveProperty('NODE_USE_ENV_PROXY');
    });

    it('餵別份環境時只清洗、不疊代理層', async () => {
      const dispose = await installProxyFromEnvironment(
        lookup({ HTTP_PROXY: 'http://proxy.internal:3128' }),
        () => undefined,
      );
      try {
        expect(scrubbedParentEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin' });
      } finally {
        await dispose();
      }
    });
  });
});
