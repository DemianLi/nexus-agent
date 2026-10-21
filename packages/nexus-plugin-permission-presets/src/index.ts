/**
 * `@nexus/plugin-permission-presets`——把「沙箱模式」與「核准政策」兩顆旋鈕捆成使用者看得懂的具名組合，並且是切換它們的**唯一入口**
 * `/permission`（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）。
 *
 * ## 照 dsh 的什麼
 *
 * 對應 dsh 的 `@deepseek-ai/dsh-permission-presets`（`packages/interaction/permission-presets/src/index.ts`，`5badb15`）：
 *
 * - **它只管「選哪一組」。** 切換時先記 `permission/preset`（使用者的意圖），再只寫**真的不同**的那顆旋鈕的事件；淨變化為零什麼都不寫。
 *   **狀態以日誌為準**（#1491 Q1 (a)，dsh 同）：現在的旋鈕從 root 日誌折出來，切換就是對 root 日誌 append；兩顆控制器跟著 root 日誌走
 *   （#1494），閘門與 fence 照舊逐次讀各自的控制器，不讀這一組的快照。
 * - **現在是哪一組是推導出來的**（{@link derivePreset}）：實際值對上哪一組就是哪一組，對不上是 `custom`；日誌上最後一顆 `permission/preset`
 *   只在兩組捆著同樣的值時分勝負。
 * - **`permissions` 投影只推現在的值**（`{ currentValue }`），目錄（`permission.catalog`）dsh 整台共用，我們逐條 thread 回（偏離 7）。
 * - **新會話把起始組合釘進日誌**（dsh `pinInitialPermission`）：登記一位會話參與者（`@nexus/session` 的 `join`），接上就寫。
 * - **子代理**：背景子代理核准一律釘 `never`（編背景圖時換上的閘門，`@nexus/core` 的 `createBackgroundApprovalGate`）；**前景子代理跟 root 當下的核准政策走**
 *   （[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 1 項，dsh 沒有）。組合名只在父代理是 `danger-full-access` 時帶下去（dsh `child-agent.ts:252`、`:277`），兩種子代理一樣。
 *
 * ## 偏離（登記）
 *
 * 1. **起始的兩顆值由 `--sandbox` 一個來源推。** dsh 用 `DSH_PERMISSION_MODE` 同時決定沙箱模式與核准政策（全開就是 `never`，其他是 `ask`，
 *    `packages/bundle/base/cordis.patch.yml:243-247`、`:259-262`，`687f282e`）；我們用 `--sandbox` 當這個來源（組裝點做，見 `assembly-root.ts`）。這是行為改變：以前
 *    `--sandbox danger-full-access` 只放寬檔案、核准照舊會問；現在連核准也是 `never`（2026-09-26 demian 拍板「全開＋不問」）。
 * 2. **`defaultPreset` 與 `--sandbox` 同時給而且互相矛盾：啟動時報錯。** dsh 沒有命令列旗標，沒有這個情況。不悄悄讓其中一個蓋掉另一個。
 * 3. **沒有使用者設定那一層。** dsh 的 `settings` 讓使用者另外存「新會話的預設組」；我們沒有使用者設定這一層，預設只來自 `defaultPreset` 與 `--sandbox`。
 * 4. **沒有圍堵（沒給 `--workspace`）時整顆不掛。** dsh 在沒有圍堵的 shell 上直接拋（presets 捆的是沙箱模式，掛在不圍堵的執行器上是設定錯誤）；
 *    我們的設定檔機制沒有辦法讓一列在某些 profile 才存在，所以退到「不註冊」——淨效果相同（沒有圍堵就沒有 `/permission`），但這不是 dsh 的機制，
 *    同 `@nexus/plugin-sandbox-policy` 登記過的 `/sandbox`。判準是 `@nexus/fs` 的 `hasContainment()`（行程級；#1491 Q4 (a)，#1774 起 2.0.0）。可寫根是逐條 thread 的：`/permission` 不帶引數時報**這條 thread** 的根（`forThread(sessionLog.sessionId)` 取把手、`FsService.workspaceRoot()` 讀值）。
 * 5. **沒有 `auto` 那一組與目錄變動通知。** dsh 的 `auto` 是選配、出廠沒開的一組，目錄靠 payload-free 的事件通知變動；我們出廠的目錄啟動時就定了。
 * 6. **出廠表不含 `danger-full-access`（理由 2，[#1621](https://github.com/DemianLi/nexus-agent/issues/1621)）。** dsh base 出廠三組
 *    （`packages/bundle/base/cordis.patch.yml:264-276`，`687f282e`），表裡有就人人可選；我們的 serve 多人共用一台主機，同一把 token 底下
 *    的每個人都切得到，所以出廠只留兩組。CLI 跟著少一組屬理由 1：出貨層只有一份表，表達不出「serve 少、CLI 照舊」。部署方要全開就把整張表
 *    重寫一份加回（見 `presets.ts` 的 `DEFAULT_PRESETS`）；沒加回又用 `--sandbox danger-full-access` 起，新會話在起動當下失敗。
 * 7. **（遷上樹新增，#1491）目錄是逐條 thread 的、子代理組名由參與者寫、參與者安裝失敗只記 warn、起始值在宿主的組 thread 那一步算。**
 *    這四條偏離的理由、類別與撤除條件登記在 `@nexus/permission-presets` 的檔頭第 1 至 4 條與 `docs/plugin-contract.md`；
 *    該檔頭第 5 條是下面第 8 條（`/permission` 不對模型講一聲）。
 * 8. **切換核准政策時沒有對模型講一聲。** dsh 的 `user-approval` 在政策變動時用 `agent.inject` 排一則使用者訊息給下一步模型
 *    （`packages/interaction/user-approval/src/index.ts:184-187`，`687f282e`：「The approval policy changed from … to … (changed by the user).」）；
 *    我們的 `/permission` 一直沒有這一步（相容層就沒有，這張遷移不改行為）。
 *    類別：遷移卡不改行為（暫時）。**撤除條件**：之後的權限卡決定要不要補這則訊息（補了就是行為改變，要自己一張卡）。
 * 9. **續接時，日誌記的沙箱比表裡每一組都寬就收回預設組（理由 2，[#1621](https://github.com/DemianLi/nexus-agent/issues/1621) 第 2 步）。**
 *    dsh 續接照日誌裡的值，表怎麼變都不動它；我們的 serve 多人共用一台主機，出廠拿掉全開（偏離 6）之後，升級前已經切到全開的會話若續接照舊，
 *    等於那一條 thread 永遠留著表裡不存在的全開。收的條件只有「比每一組都寬」（部署方加回全開不收；`read-only` 被刪掉後停在 `read-only` 的會話比
 *    `workspace-write` 窄，也不收）。收到 `defaultPreset`，沒設就是表裡沙箱最寬的那一組（不是第一組：第一組是 `read-only`，收太多）。
 *    收回在**會話參與者**裡做（`start` 只回 `narrowed` 描述）：沙箱與核准的參與者排在前面、每次接上都把控制器釘到日誌的值，宿主在 `start`
 *    之後切控制器會被它們蓋回去。寫事件的順序照 `/permission`（`permission/preset` → `sandbox/mode` → `approval/policy`，只寫真的變了的）；
 *    沒有新事件種類、日誌格式不動。**撤除條件**：沒有（出廠表沒有全開這件事一天不變，這條就一天要在）。
 *    **為什麼目標不照 dsh 的 `inferredDefault`**（理由 1）：dsh 的預設組是 `config.defaultPreset ?? inferredDefault`，`inferredDefault` 由行程起始的沙箱與核准推出
 *    （`packages/interaction/permission-presets/src/index.ts:222-231`，`687f282e`）；寫事件的參與者拿不到行程的 `--sandbox`，root 的 `SessionAddress` 也沒有
 *    thread 鍵可以對回 `start`，所以退到「`defaultPreset`，沒設取沙箱最寬的一組」。兩種規則只有一格結果不同：`--sandbox read-only` 起動、沒設
 *    `defaultPreset`、日誌記著全開——照 dsh 收到 `read-only`，照這裡收到 `workspace-write`（要收得更窄就設 `defaultPreset`）。
 *    dsh 的對照點：續接時保留日誌裡的值是 `:446-455`（`pinInitialPermission` 後半），續接時拒絕的前例是 `:431-436`（`auto` 在續接時拋錯）。
 * 10. **冷復活的背景子代理，讀回的委派沙箱比表裡每一組都寬就收回預設組（理由 2，[#1739](https://github.com/DemianLi/nexus-agent/issues/1739)，跟 #1621 同一個理由）。**
 *    dsh 的表也是部署方可以設定的，全開只是預設值（`packages/interaction/permission-presets/src/index.ts:158-166`、`:183-195`），所以部署方把全開拿掉之後，
 *    dsh 既有子代理的快照一樣可以比表寬；dsh 的答案是取消再重派（`.agents/notes/archived/feature/2026-07-25-subagent-policy-inheritance.md:34`：
 *    「cancel-and-respawn picks up a tightening」）——冷復活只重播子代理日誌上已持久化的委派政策事件（`packages/subagent/subagent/src/manager.ts:881-882`，`687f282e`），
 *    fence 解析取的是 session 自己的 override（`packages/sandbox/sandbox-policy/src/index.ts:164-168`）。我們的 serve 多人共用一台主機：改表的人看不到別人的會話，
 *    而部署方改表就是要對整台主機生效，沒有人能替每一個背景子代理逐一取消重派，所以**改成讀回時收**。
 *    做法：{@link PermissionPresetsService.narrowDelegated}（1.2.0，純函式，只看「表＋這一格快照」，條件與目標同偏離 9），宿主在
 *    `SandboxModeController.delegateFromLog` 讀回時過這個上限；**只收「這一輪實際用的那一格」，不寫子代理日誌**
 *    （日誌上仍記委派當時的那一格，代價是日誌與實際行為在這種子代理上不一致；多寫一顆就多一個能移動 fence 的寫入處）。子代理的核准照舊釘 `never`，
 *    不動。同步（前景）子代理拍的是 root 當下那一格，root 已經在續接時收過，不在這裡。收回的那一次在 server 日誌／CLI 標準錯誤留一行，
 *    每個子代理每個行程一次。不看父代理的即時狀態是照 dsh（上述 note 的 rejected alternatives）。
 *    **撤除條件**：`sandbox-policy` 遷上樹、fence 改讀投影的時候（那時可以改成直接往子代理日誌寫收窄後的那一格，日誌與行為就一致了）。
 *
 * ## 形狀（#1491：第十四顆搬上 Cordis 樹的插件）
 *
 * 函式插件，具名匯出 `name`／`inject`／`Config`／`manifest`／`apply`，**沒有 default**。相依只有 `@nexus/sdk`、`@nexus/fs`（工作區根）、
 * `@nexus/commands`、`@nexus/projections`、`@nexus/session`（會話參與者）、`@nexus/permission-presets`（服務的定義）與 `@nexus/wire`（詞彙）：
 * **沒有一行 import `@nexus/core`**（決議 §3-4 第 17 條；#1420 的 lint 規則擋它）。
 *
 * - **插件不碰控制器。** 以前 `apply` 從 host 服務抓兩顆控制器 `switchTo`；現在宿主組一條 thread 時呼叫 {@link PermissionPresetsService.start}
 *   （純函式）拿起始值，自己靜默切控制器。`/permission` 直接寫 root 日誌，控制器跟著日誌走。
 * - **提供一個服務、消費四個接縫。**
 * - 舊的 `NexusPlugin` 外殼（`createPermissionPresetsPlugin`）沒有搬成夾具：遷完之後全 repo 沒有任何呼叫端（`git grep -n "createPermissionPresetsPlugin"` 零筆），測試改走真的 `Loader` 與提供者，所以直接刪掉。
 *
 * @module
 */

import { commandsToken } from '@nexus/commands';
import type { Context } from '@nexus/cordis';
import { fsToken } from '@nexus/fs';
import { permissionPresetsToken, PERMISSION_COMMAND_NAME } from '@nexus/permission-presets';
import type {
  DelegationNarrowing,
  PermissionPresetsService,
  PermissionStarted,
  PermissionStartRequest,
  SandboxMode,
} from '@nexus/permission-presets';
import { projectionsToken } from '@nexus/projections';
import { ContractService, defineManifest, injectOf, need, service } from '@nexus/sdk';
import { sessionLookupToken } from '@nexus/session';
import type { SessionEvent } from '@nexus/session';

import { createPermissionsUnit, foldPermissionKnobs } from './fold.js';
import {
  ASSUMED_APPROVAL,
  ASSUMED_SANDBOX,
  CUSTOM_PRESET,
  derivePreset,
  permissionPresetsConfigSchema,
  specOf,
} from './presets.js';
import type { PermissionPresetsConfig, PresetTable } from './presets.js';
import { assertPresetConfig, narrowingOf, startPresets } from './start.js';

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
  isSandboxWider,
  permissionPresetsConfigSchema,
  specOf,
} from './presets.js';
export { assertPresetConfig, buildCatalog, narrowingOf, startPresets } from './start.js';
export type {
  PermissionKnobs,
  PermissionPresetsConfig,
  PermissionPresetsOptions,
  PresetSpec,
  PresetTable,
} from './presets.js';

/** 插件在樹上的列用的名字（`ctx.fiber.runtime.name`、必掛判斷用）。 */
export const name = 'permission-presets';

/** 要的服務：fs（行程級的「有沒有圍堵」與逐條 thread 的可寫根）、命令、投影、會話查找（參與者接縫）。範圍在這裡宣告，落進 Cordis 的 `Context.intercept`。 */
export const inject = injectOf(
  need(fsToken, '^2.0.0'),
  need(commandsToken, '^1.0.0'),
  need(projectionsToken, '^1.0.0'),
  need(sessionLookupToken, '^1.1.0'),
);

/** 設定的 schema，與 {@link manifest}.config 是同一個物件（一致性套件比對）。 */
export const Config = permissionPresetsConfigSchema;

export const manifest = defineManifest({
  id: 'permission-presets',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [{ token: permissionPresetsToken.name, version: permissionPresetsToken.version }],
  consumes: [
    { token: fsToken.name, range: '^2.0.0' },
    { token: commandsToken.name, range: '^1.0.0' },
    { token: projectionsToken.name, range: '^1.0.0' },
    { token: sessionLookupToken.name, range: '^1.1.0' },
  ],
  config: permissionPresetsConfigSchema,
  // 換程式碼要重啟行程；設定一改，下一條 thread 看到新的組合表，開著的不動（#1405、決議 §3-2 第 6 條）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

function knobsText(table: PresetTable, name: string): string {
  const spec = specOf(table, name);
  return spec === undefined ? '' : `（檔案政策 ${spec.sandbox}、核准 ${spec.approval}）`;
}

/**
 * 子代理日誌上**這一次接上時**才寫下的委派沙箱那一格。
 *
 * 往回找最後一顆 `sandbox/mode { source: 'delegation' }`，**找到 `session/end-seed` 就停**：那一顆之前的事件是上一個行程寫的（背景子代理冷復活時
 * seed 進來的舊事件，#1491 R2）。以前的程式讀 `sandbox.delegatedMode`（ALS）：復活不在委派裡，所以是 `undefined`、不寫組名；這裡照樣——
 * 這一次接上時 sandbox-policy 的參與者只在委派當下（ALS 有值）才寫那一顆，復活時不寫，所以 end-seed 之後沒有，回 `undefined`。
 */
function delegatedSandboxOf(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event === undefined || event.type === 'session/end-seed') return undefined;
    if (event.type === 'sandbox/mode' && event.data.source === 'delegation') {
      return event.data.mode;
    }
  }
  return undefined;
}

/**
 * `permissionPresets` 服務的實作：把「決定預設組」掛成一個契約服務。
 *
 * `start` 是**自己的屬性、閉包住組合表與設定**，不是原型上的方法，也不用 `#私有欄位`：宿主取到的是 traceable proxy，方法在 proxy 的 shadow
 * 上執行，私有欄位在那個 receiver 上會拋。方法體一律不碰 `this.ctx`（列卸載之後宿主手上那份快照仍能呼叫）。
 */
class PermissionPresetsServiceImpl
  extends ContractService<PermissionPresetsService>
  implements PermissionPresetsService
{
  readonly start: (request: PermissionStartRequest) => PermissionStarted;
  readonly narrowDelegated: (sandbox: SandboxMode) => DelegationNarrowing | undefined;

  constructor(ctx: Context, table: PresetTable, configured: string | undefined) {
    super(ctx, permissionPresetsToken);
    this.start = (request) => startPresets(table, configured, request);
    // 子代理的核准照舊釘在 `never`（`approval.ts`），所以這裡傳 `never`；`narrowingOf` 的結果只看沙箱，核准那一格不外送。
    this.narrowDelegated = (sandbox) => {
      const narrowing = narrowingOf(table, configured, { sandbox, approval: 'never' });
      return narrowing === undefined
        ? undefined
        : {
            preset: narrowing.preset,
            fromSandbox: narrowing.fromSandbox,
            toSandbox: narrowing.toSandbox,
          };
    };
  }
}

/**
 * 掛上 `/permission`、`permissions` 投影、會話參與者與 `permissionPresets` 服務。
 *
 * **每次掛載才有的狀態一律活在這裡**（組合表、預設組設定、可寫根）。
 *
 * @param ctx - 這一列的 Cordis context。
 * @param config - 驗過的設定。
 * @throws 組合表是空的、`custom` 當組名、`defaultPreset` 不在表裡（行程級設定錯，那一列判 `dropped`，必掛名單接住）。
 */
export function apply(ctx: Context, config: PermissionPresetsConfig): void {
  // 偏離 4：沒有圍堵（行程沒給 `--workspace`）就沒有東西可以捆。**行程級的「有沒有圍堵」**（`@nexus/fs` 2.0.0 的 `hasContainment()`）；
  // 可寫根是逐條 thread 的（#1774），不在 `apply` 當下讀，`/permission` 被叫時才依這條 thread 問。
  const fs = service(ctx, fsToken);
  if (!fs.hasContainment()) return;
  const table: PresetTable = config.presets;
  assertPresetConfig(table, config.defaultPreset);

  const configured = config.defaultPreset;
  service(ctx, projectionsToken).register(createPermissionsUnit(table));
  // 用 `new` 不用 `ctx.plugin(Class)`：不開子 fiber，歸屬就是這一列。建構子 `provide` 是 effect，列卸載時服務跟著撤。
  new PermissionPresetsServiceImpl(ctx, table, config.defaultPreset);

  service(ctx, sessionLookupToken).join((subject) => {
    if (subject.address.kind === 'root') {
      // 釘起始組合（dsh `pinInitialPermission`）：日誌上沒有 `permission/preset` 才釘，續接與空轉的重接什麼都不寫。
      // 兩顆旋鈕的值讀這份日誌：approval-gate 與 sandbox-policy 的參與者排在前面，已經把起始值釘進來了（`approval/policy` → `sandbox/mode` →
      // `permission/preset` 的順序靠這一列在清單上的位置）。
      const knobs = foldPermissionKnobs(subject.log.events);
      // 續接收回（#1621 Q2 (b)）：日誌記的沙箱模式比表裡每一組都寬，就切到預設組。**順序照 `/permission`**：先記意圖，再只寫真的不同的那顆旋鈕。
      // 排在釘起始組合之前，這一輪就不會再釘一顆（收回已經記了 `permission/preset`）。控制器靠訂閱跟著日誌走，不碰它們。
      // 此刻日誌上已經有 sandbox-policy 的參與者釘的那顆（排在前面），`knobs.sandbox` 是日誌記的原值。
      const narrowing =
        knobs.sandbox === null
          ? undefined
          : narrowingOf(table, configured, {
              sandbox: knobs.sandbox,
              approval: knobs.approval ?? ASSUMED_APPROVAL,
            });
      if (narrowing !== undefined) {
        subject.log.append('permission/preset', { preset: narrowing.preset });
        if (narrowing.toSandbox !== narrowing.fromSandbox)
          subject.log.append('sandbox/mode', { mode: narrowing.toSandbox });
        if (narrowing.toApproval !== narrowing.fromApproval)
          subject.log.append('approval/policy', { policy: narrowing.toApproval });
        return undefined;
      }
      if (knobs.preset === null) {
        const effective = derivePreset(table, { ...knobs, preset: null });
        if (effective !== CUSTOM_PRESET)
          subject.log.append('permission/preset', { preset: effective });
      }
      return undefined;
    }
    // 子代理：組合名只在父代理是全開時帶下去（dsh `captureDelegatedPolicyOverrides`）。
    // 委派那一格沙箱讀子代理自己的日誌（sandbox-policy 的參與者在委派當下寫了 `source: 'delegation'` 那一顆），父代理當下的核准讀 root 日誌。
    const delegated = delegatedSandboxOf(subject.log.events);
    if (delegated !== undefined) {
      const parent = derivePreset(table, {
        preset: null,
        sandbox: delegated,
        approval: foldPermissionKnobs(subject.rootLog.events).approval,
      });
      if (parent === 'danger-full-access')
        subject.log.append('permission/preset', { preset: parent });
    }
    return undefined;
  });

  service(ctx, commandsToken).register({
    name: PERMISSION_COMMAND_NAME,
    description: '看或切換這個會話的權限組合（檔案政策＋核准政策）',
    input: { hint: `[${Object.keys(table).join('｜')}]` },
    handler: ({ rawInput, sessionLog }) => {
      // 這條 thread 沒有圍堵（#1775，落盤關掉的新 thread：可寫根是記憶體，`--workspace` 只以唯讀共用區掛上）：行程級的 `hasContainment()` 是真的，
      // 所以這顆命令註冊了，但這條 thread 沒有 fence 可以切、也沒有檔案政策可報。照「沒給 `--workspace`」的處理：不適用，不寫任何事件。
      // 查不到這條 thread 的把手（沒登記、已撤）時照舊往下走，不在這裡猜。
      if (fs.forThread(sessionLog.sessionId)?.hasWorkspace() === false) {
        return {
          kind: 'error',
          text: `/${PERMISSION_COMMAND_NAME} 在這條對話不適用：它的檔案在虛擬檔案系統裡，沒有檔案圍堵可以切。`,
        };
      }
      const name = rawInput.trim();
      const names = Object.keys(table);
      const knobs = foldPermissionKnobs(sessionLog.events);
      const sandbox = knobs.sandbox ?? ASSUMED_SANDBOX;
      const approval = knobs.approval ?? ASSUMED_APPROVAL;
      const current = derivePreset(table, knobs);
      if (name.length === 0) {
        // 可寫根也報（舊 `/sandbox` 不帶引數時就報，使用者靠它確認圍的是哪個目錄）。**報的是這條 thread 的根**（#1774）：依 `sessionLog` 的
        // 會話 id（＝thread id）精確找回這條 thread 的 fs 把手、呼叫當下才讀；查不到（沒登記、已撤）明說查不到，不拿別條 thread 的根充數。
        const threadRoot = fs.forThread(sessionLog.sessionId)?.workspaceRoot();
        const root =
          threadRoot === undefined
            ? '\n可寫根：查不到這條 thread 的可寫根。'
            : `\n可寫根 ${JSON.stringify(threadRoot)}。`;
        return {
          kind: 'success',
          text:
            current === CUSTOM_PRESET
              ? `目前的權限組合：${CUSTOM_PRESET}（檔案政策 ${sandbox}、核准 ${approval}，對不上任何一組）。${root}\n切得過去的：${names.join('、')}。`
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
      // 先記意圖，再只寫真的不同的那顆旋鈕的事件（dsh `apply`）。兩顆控制器跟著 root 日誌走（#1494，同步），所以下一次工具呼叫
      // 讀到的 fence 與閘門已是新的那一格；淨變化為零各自什麼都不寫。
      sessionLog.append('permission/preset', { preset: name });
      if (spec.sandbox !== sandbox) sessionLog.append('sandbox/mode', { mode: spec.sandbox });
      if (spec.approval !== approval)
        sessionLog.append('approval/policy', { policy: spec.approval });
      return {
        kind: 'success',
        text: `權限組合從 ${current} 換成 ${name}${knobsText(table, name)}。`,
      };
    },
  });
}
