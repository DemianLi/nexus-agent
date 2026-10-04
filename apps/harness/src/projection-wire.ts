/**
 * 插件投影的 `custom` frame 怎麼從折疊結果長出來（[#1026](https://github.com/DemianLi/nexus-agent/issues/1026)）。
 *
 * 即時（`thread-pump.ts`）與歷史（`conversation-history.ts`）**都只經過這一個函式**：值從哪來是折疊器的事
 * （`@nexus/core` 的 `createProjectionFold`，兩條路共用同一個），frame 長什麼樣只在這裡寫一次。
 *
 * @module
 */

import type { ProjectionValue } from '@nexus/core';
import type { CustomFrameData } from '@nexus/wire';
import { PROJECTION } from '@nexus/wire';

/**
 * 一個投影的值 → 一顆 `projection` frame 的 `data`。
 *
 * @param value - 折疊器交出的一筆。
 */
export function projectionData(value: ProjectionValue): CustomFrameData {
  return {
    name: PROJECTION,
    payload: {
      key: value.key,
      version: value.version,
      view: value.view,
      ...(value.failed === true && { failed: true as const }),
    },
  };
}
