/**
 * `@nexus/plugin-permission-presets`——把「沙箱模式」與「核准政策」兩顆旋鈕捆成使用者看得懂的具名組合，並且是切換它們的**唯一入口**
 * `/permission`（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）。
 *
 * ## 照 dsh 的什麼
 *
 * 對應 dsh 的 `@deepseek-ai/dsh-permission-presets`（`packages/interaction/permission-presets/src/index.ts`，`5badb15`）：
 *
 * - **它只管「選哪一組」，執行歸兩顆旋鈕各自的服務。** 切換時先記 `permission/preset`（使用者的意圖），再只動**真的不同**的那顆旋鈕，
 *   各走自己的權威入口（沙箱 {@link SandboxModeController.switchTo}、核准 {@link ApprovalPolicyController.switchTo}）；淨變化為零什麼都不寫。
 *   閘門與 fence 照舊逐次讀各自的控制器，不讀這一組的快照。
 * - **現在是哪一組是推導出來的**（{@link derivePreset}）：實際值對上哪一組就是哪一組，對不上是 `custom`；日誌上最後一顆 `permission/preset`
 *   只在兩組捆著同樣的值時分勝負。
 * - **`permissions` 投影只推現在的值**（`{ currentValue }`），目錄（`permission.catalog`）整台共用。
 * - **新會話把起始組合釘進日誌**（dsh `pinInitialPermission`），讓一份沒人切過的日誌也答得出現在是哪一組。
 * - **子代理**：核准一律釘 `never`（`@nexus/core` 的 `approval-gate` 那一列做）；組合名只在父代理是 `danger-full-access` 時帶下去
 *   （dsh `child-agent.ts:252`、`:277`）。
 *
 * ## 偏離（登記）
 *
 * 1. **起始的兩顆值由 `--sandbox` 一個來源推。** dsh 用 `DSH_PERMISSION_MODE` 同時決定沙箱模式與核准政策（全開就是 `never`，其他是 `ask`，
 *    `packages/bundle/base/cordis.patch.yml:244-247`）；我們用 `--sandbox` 當這個來源（組裝點做，見 `assembly-root.ts`）。這是行為改變：以前
 *    `--sandbox danger-full-access` 只放寬檔案、核准照舊會問；現在連核准也是 `never`（2026-09-26 demian 拍板「全開＋不問」）。
 * 2. **`defaultPreset` 與 `--sandbox` 同時給而且互相矛盾：啟動時報錯。** dsh 沒有命令列旗標，沒有這個情況。不悄悄讓其中一個蓋掉另一個。
 * 3. **沒有使用者設定那一層。** dsh 的 `settings` 讓使用者另外存「新會話的預設組」；我們沒有使用者設定這一層，預設只來自 `defaultPreset` 與 `--sandbox`。
 * 4. **沒有圍堵（沒給 `--workspace`）時整顆不掛。** dsh 在沒有圍堵的 shell 上直接拋（presets 捆的是沙箱模式，掛在不圍堵的執行器上是設定錯誤）；
 *    我們的設定檔機制沒有辦法讓一列在某些 profile 才存在，所以退到「不註冊」——淨效果相同（沒有圍堵就沒有 `/permission`），但這不是 dsh 的機制，
 *    同 `@nexus/plugin-sandbox-policy` 登記過的 `/sandbox`。
 * 5. **沒有 `auto` 那一組與目錄變動通知。** dsh 的 `auto` 是選配、出廠沒開的一組，目錄靠 payload-free 的事件通知變動；我們出廠的目錄啟動時就定了。
 *
 * @module
 */

import type {
  ApprovalPolicyController,
  NexusPlugin,
  PluginEntry,
  PluginRegistry,
  SandboxMode,
  SessionEvent,
} from '@nexus/core';
import { APPROVAL_POLICY_SERVICE } from '@nexus/core';
import {
  FS_CONTAINMENT_SERVICE,
  SANDBOX_POLICY_SERVICE,
  type SandboxModeController,
} from '@nexus/plugin-sandbox-policy';
import type { PermissionCatalog, PresetOption } from '@nexus/wire';
import { foldPermissionKnobs, createPermissionsUnit } from './fold.js';
import { CUSTOM_PRESET, derivePreset, permissionPresetsConfigSchema, specOf } from './presets.js';
import type { PermissionPresetsConfig, PermissionPresetsOptions, PresetTable } from './presets.js';

export {
  applyPermissionEvent,
  createPermissionsUnit,
  EMPTY_KNOBS,
  foldPermissionKnobs,
} from './fold.js';
export {
  ASSUMED_APPROVAL,
  ASSUMED_SANDBOX,
  CUSTOM_PRESET,
  DEFAULT_PRESETS,
  derivePreset,
  permissionPresetsConfigSchema,
  specOf,
} from './presets.js';
export type {
  PermissionKnobs,
  PermissionPresetsConfig,
  PermissionPresetsOptions,
  PresetSpec,
  PresetTable,
} from './presets.js';

/** `/permission` 的命令名，不帶斜線。 */
export const PERMISSION_COMMAND_NAME = 'permission';

/** 這個 plugin 提供給組裝點與 wire 的服務名。 */
export const PERMISSION_PRESETS_SERVICE = 'permissionPresets';

/**
 * 組裝點交給這個 plugin 的「這一次是怎麼開始的」。
 *
 * - `fresh`：這份日誌從零開始，沒有續接任何已記下的旋鈕。**只有 fresh 才套用預設組、才在對不上任何一組時報錯**；續接保留日誌裡的值，
 *   對不上就顯示 `custom`（照 dsh：續接的會話保留日誌裡的值，不套用預設）。
 * - `sandboxExplicit`：這一次的沙箱起始值是 `--sandbox` 明確給的（不是出廠預設）。`defaultPreset` 與它矛盾時啟動報錯。
 */
export interface PermissionSeed {
  readonly fresh: boolean;
  readonly sandboxExplicit: boolean;
}

/** 這個 plugin 對外的服務：wire 的 `permission.catalog` 讀它。 */
export interface PermissionPresetsService {
  /** 整台共用的目錄。 */
  catalog(): PermissionCatalog;
}

/** 組裝點交 {@link PermissionSeed} 用的服務名。 */
export const PERMISSION_SEED_SERVICE = 'permissionSeed';

declare module '@nexus/core' {
  interface NexusServices {
    /** 這一次是怎麼開始的。見 {@link PermissionSeed}。選配：手搭的測試組裝沒有它，當作續接。 */
    permissionSeed: PermissionSeed;
    /** 權限組合的目錄。有圍堵且這一列掛上了才有。 */
    permissionPresets: PermissionPresetsService;
  }
  interface SessionEventMap {
    /**
     * 使用者選了哪一組權限組合，**只記意圖、不控制執行**（兩顆旋鈕各自的事件才控制）。
     *
     * 照 dsh 的同名事件（`packages/interaction/permission-presets/src/index.ts`）：一筆帶整個值；它存在的理由是兩組捆著同樣的一對值時，
     * 留得住使用者選的是哪一組。**不標 `ignorable`**（dsh 同）：舊 runtime 略過它不會讀錯執行，但 dsh 的規矩是新增的種類一律拒讀、
     * 由版本號管相容，我們跟（`SESSION_LOG_FORMAT_VERSION` 35）。**缺席的意思**：#437 以前的日誌沒有這一顆，續接時由目前的值推導。
     */
    'permission/preset': { readonly preset: string };
  }
}

/** 一份日誌上最後一顆 `permission/preset` 記的組名；一顆都沒有是 `null`。 */
function recordedPreset(events: readonly SessionEvent[]): string | null {
  return foldPermissionKnobs(events).preset;
}

/** 沒接上日誌時 `/permission` 的回覆多的那一句。 */
const UNRECORDED_NOTE = '（這次切換沒有完整記進會話日誌——有一顆旋鈕沒有日誌接在上面。）';

function optionOf(table: PresetTable, name: string): PresetOption {
  const spec = specOf(table, name);
  return {
    value: name,
    name: spec?.name ?? name,
    ...(spec?.description !== undefined && { description: spec.description }),
  };
}

function knobsText(table: PresetTable, name: string): string {
  const spec = specOf(table, name);
  return spec === undefined ? '' : `（檔案政策 ${spec.sandbox}、核准 ${spec.approval}）`;
}

/**
 * 組出目錄與預設組。抽出來是為了單測，不必掛整個 plugin。
 * @param table - 組合表。
 * @param defaultPreset - 沒選過的會話用的組。
 */
export function buildCatalog(table: PresetTable, defaultPreset: string): PermissionCatalog {
  const options = Object.keys(table).map((name) => optionOf(table, name));
  return { options, defaultOptions: options, defaultPreset };
}

/**
 * 決定這一次的預設組，並在 fresh 時把兩顆旋鈕設到它。**純邏輯＋對控制器的靜默切換**：呼叫的當下沒有任何日誌接在控制器上，所以不寫事件，
 * 之後各參與者接日誌時會把這個起始值釘進去。
 * @throws 設定對不上：預設組不存在、與 `--sandbox` 矛盾、或起始值對不上任何一組又沒有設定 `defaultPreset`。
 */
export function resolveDefaultPreset(options: {
  readonly table: PresetTable;
  readonly configured: string | undefined;
  readonly seed: PermissionSeed;
  readonly sandbox: SandboxModeController;
  readonly approval: ApprovalPolicyController;
}): string {
  const { table, configured, seed, sandbox, approval } = options;
  const known = Object.keys(table).join('、');
  if (configured !== undefined) {
    const spec = specOf(table, configured);
    if (spec === undefined) {
      throw new Error(
        `permission-presets：defaultPreset "${configured}" 不在組合表裡（有：${known}）`,
      );
    }
    if (seed.fresh && seed.sandboxExplicit && spec.sandbox !== sandbox.current) {
      throw new Error(
        `permission-presets：--sandbox ${sandbox.current} 與 defaultPreset "${configured}"（檔案政策 ${spec.sandbox}）互相矛盾。` +
          '兩個來源不管誰贏，另一個都會被靜靜丟掉：要嘛不給 --sandbox，要嘛把 defaultPreset 改成對得上的那一組。',
      );
    }
    if (seed.fresh) {
      sandbox.switchTo(spec.sandbox);
      approval.switchTo(spec.approval);
    }
    return configured;
  }
  const inferred = derivePreset(table, {
    preset: null,
    sandbox: sandbox.current,
    approval: approval.current,
  });
  if (inferred !== CUSTOM_PRESET) return inferred;
  if (seed.fresh) {
    throw new Error(
      `permission-presets：起始的檔案政策 ${sandbox.current}、核准 ${approval.current} 對不上組合表裡任何一組（有：${known}）。` +
        '要嘛在表裡補上那一組，要嘛設定 defaultPreset。',
    );
  }
  // 續接的會話可以是 custom（保留日誌裡的值）；目錄仍需要一個預設，拿表裡第一組。
  return Object.keys(table)[0] as string;
}

/**
 * 權限組合 plugin。
 *
 * 見檔頭。**每次掛載才有的狀態一律活在 `apply` 裡**（組合表、預設組、服務）；模組層只有這顆常數。
 */
export const permissionPresetsPlugin: NexusPlugin<PermissionPresetsConfig> = {
  name: 'permission-presets',
  Config: permissionPresetsConfigSchema,
  apply(registry: PluginRegistry, config: PermissionPresetsConfig) {
    // 偏離 4：沒有圍堵就沒有東西可以捆。
    if (registry.services.get(FS_CONTAINMENT_SERVICE) === undefined) return;
    const { controller: sandbox, rootDir } = registry.services.use(SANDBOX_POLICY_SERVICE);
    const approval = registry.services.get(APPROVAL_POLICY_SERVICE);
    if (approval === undefined) {
      throw new Error(
        `permission-presets：沒有 ${APPROVAL_POLICY_SERVICE} 服務——沒有核准旋鈕就捆不起來。組裝點要把它和 ${SANDBOX_POLICY_SERVICE} 一起提供。`,
      );
    }
    const table: PresetTable = config.presets;
    if (Object.keys(table).length === 0) {
      throw new Error(
        'permission-presets：組合表是空的——至少要留一組，否則 /permission 沒有東西可切。',
      );
    }
    if (Object.hasOwn(table, CUSTOM_PRESET)) {
      throw new Error(
        `permission-presets："${CUSTOM_PRESET}" 是保留字（沙箱與核准對不上任何一組時的顯示值），不能當組名。`,
      );
    }
    const seed = registry.services.get(PERMISSION_SEED_SERVICE) ?? {
      fresh: false,
      sandboxExplicit: false,
    };
    const defaultPreset = resolveDefaultPreset({
      table,
      configured: config.defaultPreset,
      seed,
      sandbox,
      approval,
    });
    const catalog = buildCatalog(table, defaultPreset);

    registry.projections.register(createPermissionsUnit(table));
    registry.services.provide(PERMISSION_PRESETS_SERVICE, { catalog: () => catalog });

    registry.sessions.join((subject) => {
      if (subject.address.kind === 'root') {
        // 釘起始組合（dsh `pinInitialPermission`）：日誌上沒有 `permission/preset` 才釘，續接與空轉的重接什麼都不寫。
        // 用控制器現在的值推，不讀日誌：別的參與者可能還沒把起始值釘進來，而控制器就是它們要釘的那一份。
        if (recordedPreset(subject.log.events) === null) {
          const effective = derivePreset(table, {
            preset: null,
            sandbox: sandbox.current,
            approval: approval.current,
          });
          if (effective !== CUSTOM_PRESET)
            subject.log.append('permission/preset', { preset: effective });
        }
        return undefined;
      }
      // 子代理：組合名只在父代理是全開時帶下去（dsh `captureDelegatedPolicyOverrides`）。
      const delegated: SandboxMode | undefined = sandbox.delegatedMode;
      if (delegated !== undefined) {
        const parent = derivePreset(table, {
          preset: null,
          sandbox: delegated,
          approval: approval.current,
        });
        if (parent === 'danger-full-access')
          subject.log.append('permission/preset', { preset: parent });
      }
      return undefined;
    });

    registry.commands.register({
      name: PERMISSION_COMMAND_NAME,
      description: '看或切換這個會話的權限組合（檔案政策＋核准政策）',
      input: { hint: `[${Object.keys(table).join('｜')}]` },
      handler: ({ rawInput, sessionLog }) => {
        const name = rawInput.trim();
        const names = Object.keys(table);
        const current = derivePreset(table, {
          preset: recordedPreset(sessionLog.events),
          sandbox: sandbox.current,
          approval: approval.current,
        });
        if (name.length === 0) {
          // 可寫根也報（舊 `/sandbox` 不帶引數時就報，使用者靠它確認圍的是哪個目錄）。
          const root = `\n可寫根 ${JSON.stringify(rootDir)}。`;
          return {
            kind: 'success',
            text:
              current === CUSTOM_PRESET
                ? `目前的權限組合：${CUSTOM_PRESET}（檔案政策 ${sandbox.current}、核准 ${approval.current}，對不上任何一組）。${root}\n切得過去的：${names.join('、')}。`
                : `目前的權限組合：${current}${knobsText(table, current)}。${root}\n切得過去的：${names.join('、')}。`,
          };
        }
        const spec = specOf(table, name);
        if (spec === undefined) {
          return {
            kind: 'error',
            text: `/${PERMISSION_COMMAND_NAME} 認不得 "${name}"。認得的是 ${names.join('、')}。`,
          };
        }
        if (current === name) {
          return { kind: 'success', text: `本來就是 ${name}，沒有變。` };
        }
        // 先記意圖，再只動真的不同的那顆旋鈕（dsh `apply`）；兩顆各走自己的權威入口，淨變化為零各自什麼都不寫。
        sessionLog.append('permission/preset', { preset: name });
        sandbox.switchTo(spec.sandbox);
        approval.switchTo(spec.approval);
        const unrecorded = sandbox.attachedCount === 0 || approval.attachedCount === 0;
        return {
          kind: 'success',
          text:
            `權限組合從 ${current} 換成 ${name}${knobsText(table, name)}。` +
            (unrecorded ? `\n${UNRECORDED_NOTE}` : ''),
        };
      },
    });
  },
};

export default permissionPresetsPlugin;

/**
 * 建一個條目。**薄薄一層**：設定不在這裡驗，驗在載入的時候。
 * @param options - 設定，形狀見 {@link permissionPresetsConfigSchema}；省略即出廠三組。
 * @returns 可以放進組裝點清單的條目。
 */
export function createPermissionPresetsPlugin(options: PermissionPresetsOptions = {}): PluginEntry {
  return { plugin: permissionPresetsPlugin, config: options };
}
