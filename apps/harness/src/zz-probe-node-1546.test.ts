// #1546 驗收 1 的探針（不合併）：只在 Node 22 上紅，量 node-compat (22.19) 紅、gate 跟著紅。
import { expect, it } from 'vitest';

it('探針：只在 Node 22 上失敗', () => {
  expect(process.versions.node.startsWith('22.')).toBe(false);
});
