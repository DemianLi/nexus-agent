/**
 * 組合表與「現在是哪一組」的推導：純函式，不碰日誌也不碰控制器。
 *
 * 照 dsh 的 `permission-presets`（`packages/interaction/permission-presets/src/index.ts`，`5badb15`）：一組是一個名字加上
 * 一對旋鈕的值（沙箱模式、核准政策）；**實際值對得上哪一組，現在就是哪一組**，對不上任何一組是 {@link CUSTOM_PRESET}。
 * 日誌上最後一顆 `permission/preset` 只用來**分勝負**：兩組捆著同樣的一對值時，使用者選的那一組贏（dsh `derive`）。
 *
 * @module
 */

import type { ApprovalPolicyValue, SandboxMode } from '@nexus/core';
import { APPROVAL_POLICIES, SANDBOX_MODES } from '@nexus/core';
import { CUSTOM_PRESET } from '@nexus/wire';
import { z } from 'zod';

export { CUSTOM_PRESET };

/** 一組捆著的兩個值，加上畫面上的名字與說明。 */
export interface PresetSpec {
  /** 這一組寫進沙箱旋鈕的模式。 */
  readonly sandbox: SandboxMode;
  /** 這一組寫進核准旋鈕的政策。 */
  readonly approval: ApprovalPolicyValue;
  /** 畫面上的名字；省略就用表的鍵。 */
  readonly name?: string | undefined;
  /** 一句話說這一組是什麼意思；省略就沒有。 */
  readonly description?: string | undefined;
}

/** 組合表：名字 → 一組。宣告順序就是畫面順序，也是「兩組同值時誰先中」的順序。 */
export type PresetTable = Readonly<Record<string, PresetSpec>>;

/**
 * 出廠的三組，名字與值一字不差照 dsh（`packages/bundle/base/cordis.patch.yml:252-261`）。
 * 名字刻意和沙箱模式同名：web 的「全開」確認認的就是 `danger-full-access`。
 */
export const DEFAULT_PRESETS: PresetTable = {
  'read-only': {
    sandbox: 'read-only',
    approval: 'ask',
    name: 'read-only',
    description: '只能讀，不能改檔；要改動時先問你。',
  },
  'workspace-write': {
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'workspace-write',
    description: '可以寫工作區；要超出時先問你。',
  },
  'danger-full-access': {
    sandbox: 'danger-full-access',
    approval: 'never',
    name: 'danger-full-access',
    description: '檔案不設限，而且不問你：要人點頭的事一律直接回絕。',
  },
};

/** 設定檔裡一組的形狀。沙箱與核准必填，沒有預設值：一組不講清楚兩個值，就不是「捆綁」。 */
const presetSpecSchema = z.strictObject({
  sandbox: z.enum(SANDBOX_MODES),
  approval: z.enum(APPROVAL_POLICIES),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

/**
 * 這個 plugin 的設定。
 *
 * **`presets` 是整份替換，不是深層合併**（patch 的規矩，見 `apps/harness/cordis.yml` 檔頭）：部署的人要刪掉某一組，就把表
 * 重寫一份、只留要的。**`defaultPreset` 選填**：省略時由起始的沙箱模式推出（見 {@link PermissionPresetsPlugin}）。
 */
export const permissionPresetsConfigSchema = z.strictObject({
  presets: z
    .record(z.string().min(1), presetSpecSchema)
    .default(() => ({ ...DEFAULT_PRESETS }) as Record<string, PresetSpec>),
  defaultPreset: z.string().min(1).optional(),
});

export type PermissionPresetsConfig = z.infer<typeof permissionPresetsConfigSchema>;
export type PermissionPresetsOptions = z.input<typeof permissionPresetsConfigSchema>;

/** 推導用的一個旋鈕狀態。`null` 是日誌上還沒有那顆事件。 */
export interface PermissionKnobs {
  /** 日誌上最後一顆 `permission/preset` 的名字。 */
  readonly preset: string | null;
  readonly sandbox: SandboxMode | null;
  readonly approval: ApprovalPolicyValue | null;
}

/** 日誌上沒有 `sandbox/mode` 時的假設：預設要是設防的那一格，同 fence 自己的預設。 */
export const ASSUMED_SANDBOX: SandboxMode = 'workspace-write';

/** 日誌上沒有 `approval/policy` 時的假設：#437 以前的日誌，行為就是去問人。 */
export const ASSUMED_APPROVAL: ApprovalPolicyValue = 'ask';

/**
 * 表裡有沒有這個名字。用 `Object.hasOwn`：名字來自使用者與日誌，`constructor` 之類的不能落到原型上。
 * @param table - 組合表。
 * @param name - 要找的名字。
 * @returns 那一組，或 `undefined`。
 */
export function specOf(table: PresetTable, name: string): PresetSpec | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

/**
 * 現在是哪一組。
 *
 * 1. 記著的那一組還對得上目前的值：就是它（兩組同值時，使用者選的贏）。
 * 2. 否則表裡第一個對得上的。
 * 3. 都沒有：{@link CUSTOM_PRESET}。**只能顯示，不是切換目標**。
 *
 * @param table - 組合表。
 * @param knobs - 目前的旋鈕狀態；`null` 的格子用出廠假設補。
 * @returns 組名，或 `custom`。
 */
export function derivePreset(table: PresetTable, knobs: PermissionKnobs): string {
  const sandbox = knobs.sandbox ?? ASSUMED_SANDBOX;
  const approval = knobs.approval ?? ASSUMED_APPROVAL;
  const matches = (spec: PresetSpec): boolean =>
    spec.sandbox === sandbox && spec.approval === approval;
  if (knobs.preset !== null) {
    const spec = specOf(table, knobs.preset);
    if (spec !== undefined && matches(spec)) return knobs.preset;
  }
  for (const [name, spec] of Object.entries(table)) {
    if (matches(spec)) return name;
  }
  return CUSTOM_PRESET;
}
