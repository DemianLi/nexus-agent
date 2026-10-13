import { loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import {
  createEchoPlugin,
  DEFAULT_ECHO_PREFIX,
  echoPlugin,
  ECHO_TOOL_NAME,
} from './echo.fixture.js';

/**
 * 舊外殼的測試（原本在 `packages/nexus-plugin-echo`，echo 搬上樹之後那個套件不再有 `NexusPlugin` 形狀）。
 *
 * 這一組是**不經過工廠**的那條路也要走通的證明：`NexusPlugin` 的設定走條目（[#453](https://github.com/DemianLi/nexus-agent/issues/453)）、
 * 同一顆模組層級常數掛兩次組裝不串台。外殼包的是 `createEchoTool`，所以工具行為與樹上那一列是同一份。
 */
describe('echo 的 NexusPlugin 外殼', () => {
  it('註冊 echo 工具，回聲帶上前綴', async () => {
    const { registry } = await loadPlugins([createEchoPlugin({ prefix: '聽到了' })]);
    const echo = registry.tools.resolve(ECHO_TOOL_NAME);

    await expect(echo?.value.invoke({ message: '嗨' })).resolves.toBe('聽到了：嗨');
  });

  it('一格都不給就用 schema 的預設值', async () => {
    const { registry } = await loadPlugins([{ plugin: echoPlugin }]);
    const echo = registry.tools.resolve(ECHO_TOOL_NAME);

    await expect(echo?.value.invoke({ message: '嗨' })).resolves.toBe(`${DEFAULT_ECHO_PREFIX}：嗨`);
  });

  it('型別錯與未知欄位都讓載入失敗，訊息帶 `<id> (<name>)` 與欄位路徑', async () => {
    await expect(loadPlugins([{ plugin: echoPlugin, config: { prefix: 7 } }])).rejects.toThrow(
      'echo#0 (echo)',
    );
    await expect(
      loadPlugins([{ plugin: echoPlugin, config: { prefixx: '聽到了' } }]),
    ).rejects.toThrow(/prefixx/);
  });

  it('工廠只是薄薄一層：它回的就是條目，設定原樣放在 config 上', () => {
    expect(createEchoPlugin({ prefix: '聽到了' })).toEqual({
      plugin: echoPlugin,
      config: { prefix: '聽到了' },
    });
  });

  it('同一顆模組層級的 plugin 掛兩次組裝不會串台', async () => {
    const a = await loadPlugins([{ plugin: echoPlugin, config: { prefix: '甲' } }]);
    const b = await loadPlugins([{ plugin: echoPlugin, config: { prefix: '乙' } }]);

    await expect(
      a.registry.tools.resolve(ECHO_TOOL_NAME)?.value.invoke({ message: '嗨' }),
    ).resolves.toBe('甲：嗨');
    await expect(
      b.registry.tools.resolve(ECHO_TOOL_NAME)?.value.invoke({ message: '嗨' }),
    ).resolves.toBe('乙：嗨');
  });
});
