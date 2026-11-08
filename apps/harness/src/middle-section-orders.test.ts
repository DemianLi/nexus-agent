/**
 * 中段的值（`@nexus/core` 的 `MIDDLE_SECTION_ORDERS`）與 `@nexus/system-prompt` 的 `SECTION_ORDERS`（頭尾兩段的值，加上遷出的插件取的
 * `PLAN_POLICY` 與 `PLUGIN_POLICY`）是兩個套件各自寫的，這裡是兩邊對得上的紅燈（[#2414](https://github.com/DemianLi/nexus-agent/issues/2414)）。放在 harness：core 的 runtime 不經
 * `@nexus/system-prompt`，兩個都看得到的是宿主。
 */

import { MIDDLE_SECTION_ORDERS } from '@nexus/core';
import { SECTION_ORDERS } from '@nexus/system-prompt';
import { describe, expect, it } from 'vitest';

describe('中段的值', () => {
  it('每一個值都釘住：值一換，段在請求裡的先後就換', () => {
    expect(MIDDLE_SECTION_ORDERS).toEqual({
      PLAN_POLICY: 500,
      BACKGROUND_DELEGATION: 510,
      FS_OBSERVATION: 1000,
      SUBAGENT_DELEGATION: 1100,
      PLUGIN_POLICY: 2000,
      APPROVAL_POLICY: 3000,
    });
  });

  it.each(Object.entries(MIDDLE_SECTION_ORDERS))(
    '%s 嚴格落在前綴與後綴之間：落在頭尾就會被 system-prompt 當成頭尾的段',
    (_name, order) => {
      expect(order).toBeGreaterThan(SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX);
      expect(order).toBeLessThan(SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX);
    },
  );

  it.each(['PLAN_POLICY', 'PLUGIN_POLICY'] as const)(
    '%s 兩邊同值：遷出的插件從 @nexus/system-prompt 取，宿主照 core 的值收',
    (name) => {
      expect(SECTION_ORDERS[name]).toBe(MIDDLE_SECTION_ORDERS[name]);
    },
  );
});
