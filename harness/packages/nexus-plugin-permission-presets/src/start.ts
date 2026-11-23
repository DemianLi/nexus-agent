/**
 * 預設組怎麼決定、目錄長什麼樣：`start` 的純邏輯，不碰日誌也不碰控制器。
 *
 * 搬自舊的 `resolveDefaultPreset`（#1491 Q3 (a)）：以前它在 `apply` 裡直接對兩顆控制器 `switchTo`；現在收旋鈕的**值**、回應該有的**值**，
 * 由宿主在組 thread 時自己靜默切控制器。錯誤訊息逐字不變。
 *
 * @module
 */

import type {
  ApprovalPolicyValue,
  PermissionCatalog,
  PermissionNarrowing,
  PermissionStarted,
  PermissionStartRequest,
  SandboxMode,
} from '@nexus/permission-presets';
import type { PresetOption } from '@nexus/wire';

import { CUSTOM_PRESET, derivePreset, isSandboxWider, specOf } from './presets.js';
import type { PresetTable } from './presets.js';

function optionOf(table: PresetTable, name: string): PresetOption {
  const spec = specOf(table, name);
  return {
    value: name,
    name: spec?.name ?? name,
    ...(spec?.description !== undefined && { description: spec.description }),
  };
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
 * 驗組合表與 `defaultPreset`：**行程級的設定錯**，在 `apply` 當下拋，那一列判 `dropped`，必掛名單接住。
 * @throws 組合表是空的、`custom` 當組名、`defaultPreset` 不在表裡。
 */
export function assertPresetConfig(table: PresetTable, configured: string | undefined): void {
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
  if (configured !== undefined && specOf(table, configured) === undefined) {
    const known = Object.keys(table).join('、');
    throw new Error(
      `permission-presets：defaultPreset "${configured}" 不在組合表裡（有：${known}）`,
    );
  }
}

/**
 * 續接時要不要收回，收到哪一組（[#1621](https://github.com/DemianLi/nexus-agent/issues/1621) Q2 (b)）。**純函式**。
 *
 * 收的條件只有一個：**日誌記的沙箱模式比組合表裡每一組的沙箱都寬**。不比「對不上任何一組」：部署方把 `read-only` 從表裡刪掉，停在 `read-only` 的
 * 會話也對不上、顯示 `custom`，但它比 `workspace-write` 窄，收成 `workspace-write` 就是放寬。部署方用 patch 加回全開之後，全開不比表裡最寬的寬，不收。
 *
 * 收到哪一組：`defaultPreset` 有設就是它，否則表裡**沙箱最寬的那一組**（同寬取先宣告的）。出廠表就是 `workspace-write`。選最寬而不是表裡第一組：
 * 第一組是 `read-only`，把一條全開的會話一路收到唯讀，比部署方要的多；`--sandbox` 是行程的啟動旗標，這時候不在手上，無從得知「新會話會從哪一組開始」。
 *
 * @param table - 組合表。
 * @param configured - 設定的預設組（`defaultPreset`），可省略。
 * @param current - 日誌記的兩顆旋鈕現在的值。
 * @returns 要收回的描述；不用收是 `undefined`。
 */
export function narrowingOf(
  table: PresetTable,
  configured: string | undefined,
  current: { readonly sandbox: SandboxMode; readonly approval: ApprovalPolicyValue },
): PermissionNarrowing | undefined {
  const entries = Object.entries(table);
  if (entries.length === 0) return undefined;
  if (!entries.every(([, spec]) => isSandboxWider(current.sandbox, spec.sandbox))) return undefined;
  const target =
    configured !== undefined && specOf(table, configured) !== undefined
      ? ([configured, specOf(table, configured)] as const)
      : entries.reduce((widest, entry) =>
          isSandboxWider(entry[1].sandbox, widest[1].sandbox) ? entry : widest,
        );
  const [preset, spec] = target;
  if (spec === undefined) return undefined;
  return {
    preset,
    fromSandbox: current.sandbox,
    fromApproval: current.approval,
    toSandbox: spec.sandbox,
    toApproval: spec.approval,
  };
}

/**
 * 決定這一次的預設組，並算出兩顆旋鈕接日誌之前該有的值。**純函式**。
 * @throws 跟 `--sandbox` 矛盾、或新會話的起始值對不上任何一組又沒有設定 `defaultPreset`（逐條 thread 的錯）。
 */
export function startPresets(
  table: PresetTable,
  configured: string | undefined,
  request: PermissionStartRequest,
): PermissionStarted {
  const { seed, sandbox, approval } = request;
  const known = Object.keys(table).join('、');
  if (configured !== undefined) {
    const spec = specOf(table, configured);
    if (spec === undefined) {
      throw new Error(
        `permission-presets：defaultPreset "${configured}" 不在組合表裡（有：${known}）`,
      );
    }
    if (seed.fresh && seed.sandboxExplicit && spec.sandbox !== sandbox) {
      throw new Error(
        `permission-presets：--sandbox ${sandbox} 與 defaultPreset "${configured}"（檔案政策 ${spec.sandbox}）互相矛盾。` +
          '兩個來源不管誰贏，另一個都會被靜靜丟掉：要嘛不給 --sandbox，要嘛把 defaultPreset 改成對得上的那一組。',
      );
    }
    return seed.fresh
      ? {
          sandbox: spec.sandbox,
          approval: spec.approval,
          catalog: buildCatalog(table, configured),
        }
      : {
          sandbox,
          approval,
          catalog: buildCatalog(table, configured),
          ...narrowedField(table, configured, sandbox, approval),
        };
  }
  const inferred = derivePreset(table, { preset: null, sandbox, approval });
  if (inferred !== CUSTOM_PRESET) {
    return { sandbox, approval, catalog: buildCatalog(table, inferred) };
  }
  if (seed.fresh) {
    throw new Error(
      `permission-presets：起始的檔案政策 ${sandbox}、核准 ${approval} 對不上組合表裡任何一組（有：${known}）。` +
        '要嘛在表裡補上那一組，要嘛設定 defaultPreset。',
    );
  }
  // 續接的會話可以是 custom（保留日誌裡的值，除非比表裡每一組都寬，見 {@link narrowingOf}）；目錄仍需要一個預設：
  // 要收回的話就是收到的那一組，否則拿表裡第一組。
  const narrowed = narrowingOf(table, configured, { sandbox, approval });
  return {
    sandbox,
    approval,
    catalog: buildCatalog(table, narrowed?.preset ?? (Object.keys(table)[0] as string)),
    ...(narrowed !== undefined && { narrowed }),
  };
}

/** `start` 回傳裡 `narrowed` 那一格：要收回才有，沒有就整個不放這個 key。 */
function narrowedField(
  table: PresetTable,
  configured: string | undefined,
  sandbox: SandboxMode,
  approval: ApprovalPolicyValue,
): { readonly narrowed?: PermissionNarrowing } {
  const narrowed = narrowingOf(table, configured, { sandbox, approval });
  return narrowed === undefined ? {} : { narrowed };
}
