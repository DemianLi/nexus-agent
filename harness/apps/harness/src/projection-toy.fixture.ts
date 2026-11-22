/**
 * 一顆**測試用的玩具插件**：宣告一個會話投影，數 root 日誌上的 `command/run`
 * （[#1026](https://github.com/DemianLi/nexus-agent/issues/1026) 的驗收）。
 *
 * 它的價值在於**不存在於任何現有的表上**：`thread-pump.ts`、`conversation-history.ts`、`conversation.ts` 裡沒有任何
 * 以 `toy-count` 命名的分支，卻能端到端長進 web 的 `projections`——證明新增一個投影不必為它改那三處。
 * 初值刻意不平凡（`label` 一開始就有值），這樣「還沒有任何相關事件時，這個 key 已經在 baseline 裡」才量得到。
 */

import type { NexusPlugin, ProjectionUnit } from '@nexus/core';

/** 投影的 key。 */
export const TOY_PROJECTION_KEY = 'toy-count';
/** 投影的版本。 */
export const TOY_PROJECTION_VERSION = 3;

/** 狀態與 view（這顆玩具兩者同形）。 */
export interface ToyCount {
  readonly commands: number;
  readonly label: string;
}

/** 玩具單元。可以直接拿去建折疊器，不必走註冊。 */
export const toyUnit: ProjectionUnit<ToyCount, ToyCount> = {
  key: TOY_PROJECTION_KEY,
  stateVersion: TOY_PROJECTION_VERSION,
  init: () => ({ commands: 0, label: '玩具' }),
  apply: (state, event) =>
    event.type === 'command/run' ? { ...state, commands: state.commands + 1 } : state,
  view: (state) => state,
};

const plugin: NexusPlugin = {
  name: 'projection-toy',
  apply(registry) {
    registry.projections.register(toyUnit);
  },
};

export default plugin;
