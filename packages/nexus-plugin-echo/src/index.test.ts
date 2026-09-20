import { loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import {
  createEchoPlugin,
  DEFAULT_ECHO_PREFIX,
  ECHO_CAPABILITY,
  echoPlugin,
  ECHO_TOOL_NAME,
} from './index.js';

/**
 * 薄測試，只斷言「`apply` 真的往那兩個註冊點放了東西」。
 *
 * 這個套件的真正驗收在組裝點（`apps/harness` 的正面路徑測試：一份清單 fold 出的
 * agent 真的呼叫得到這個工具）。這裡不重跑那條——重點是不要讓一個沒有測試的
 * package 通過 gate（[#32](https://github.com/DemianLi/nexus-agent/issues/32)：
 * `pnpm -r run test` 找不到測試檔就是紅燈）。
 */
describe('createEchoPlugin', () => {
  it('註冊 echo 工具並宣告 echo 能力', async () => {
    const { registry } = await loadPlugins([createEchoPlugin()]);

    expect(registry.capabilities.has(ECHO_CAPABILITY)).toBe(true);
    expect(registry.tools.resolve(ECHO_TOOL_NAME)?.value.name).toBe(ECHO_TOOL_NAME);
  });

  it('回聲帶上組裝點給的前綴', async () => {
    const { registry } = await loadPlugins([createEchoPlugin({ prefix: '聽到了' })]);
    const echo = registry.tools.resolve(ECHO_TOOL_NAME);

    await expect(echo?.value.invoke({ message: '嗨' })).resolves.toBe('聽到了：嗨');
  });
});

/**
 * 設定走條目那條路（[#453](https://github.com/DemianLi/nexus-agent/issues/453)）。
 *
 * 這一組是**不經過工廠**的那條路——#454 從 YAML 載入時就是這樣：`plugin` 是 import
 * 出來的那顆模組層級常數，`config` 是設定檔裡的一塊資料。工廠不再做任何檢查，所以
 * 這條路上看得到的錯誤就是使用者會看到的錯誤。
 */
describe('echo 的 Config（#453）', () => {
  it('合法的覆寫會生效——只經過條目，不經過工廠', async () => {
    const { registry } = await loadPlugins([{ plugin: echoPlugin, config: { prefix: '聽到了' } }]);
    const echo = registry.tools.resolve(ECHO_TOOL_NAME);

    await expect(echo?.value.invoke({ message: '嗨' })).resolves.toBe('聽到了：嗨');
  });

  it('一格都不給就用 schema 的預設值', async () => {
    const { registry } = await loadPlugins([{ plugin: echoPlugin }]);
    const echo = registry.tools.resolve(ECHO_TOOL_NAME);

    await expect(echo?.value.invoke({ message: '嗨' })).resolves.toBe(`${DEFAULT_ECHO_PREFIX}：嗨`);
  });

  it('型別錯就載入失敗，訊息帶 `<id> (<name>)` 與欄位路徑', async () => {
    const bad = [{ plugin: echoPlugin, config: { prefix: 7 } }];
    await expect(loadPlugins(bad)).rejects.toThrow('echo#0 (echo)');
    await expect(loadPlugins(bad)).rejects.toThrow('prefix');
  });

  it('未知欄位讓載入失敗（登記的偏離：dsh 放行）', async () => {
    // YAML 上一個拼錯的欄位名在 dsh 那邊會靜靜沒有作用，在共用主機上沒有人會發現。
    const typo = [{ plugin: echoPlugin, config: { prefixx: '聽到了' } }];
    await expect(loadPlugins(typo)).rejects.toThrow('echo#0 (echo)');
    await expect(loadPlugins(typo)).rejects.toThrow(/prefixx/);
  });

  it('工廠只是薄薄一層：它回的就是條目，設定原樣放在 config 上', () => {
    expect(createEchoPlugin({ prefix: '聽到了' })).toEqual({
      plugin: echoPlugin,
      config: { prefix: '聽到了' },
    });
  });

  it('**同一顆模組層級的 plugin 掛兩次組裝不會串台**——每次掛載的設定各自獨立', async () => {
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
