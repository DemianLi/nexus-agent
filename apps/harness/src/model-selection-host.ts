/**
 * 每會話模型選擇的**組裝端**（[#723](https://github.com/DemianLi/nexus-agent/issues/723)）：從型錄建控制器、
 * 把控制器接上 root 的日誌、把選擇的現況投影給 web。機制本身（快照、換模型、通知）在 `@nexus/core` 的 `model-selection.ts`。
 *
 * 照 dsh 的分工：型錄與推理等級的宣告歸 adapter（`llm-pi-ai`），選擇歸 `session-controller`，換模型歸 agent。我們的 adapter 是
 * `createLiveModel`，型錄是 `live-model` 那一列的 `models`（#729）。
 *
 * ## 與 dsh 的差異（登記）
 *
 * - **推理強度只認 `off` 與 `default`。** dsh 的等級由 adapter 驗證、線上怎麼帶也是 adapter 的事；我們的型錄雖然可以宣告任意名字，但只有
 *   `off` 量過線上寫法（`thinkingOffBody`）。與 {@link ./subagent-model-selection.ts} 同一條界線：宣告了別的名字也先不放進可選清單，
 *   `model.select` 帶了就拒。**`default` 一律可選**（只要模型宣告了任何等級）——它是「不加任何設定」，沒有它使用者選了 `off` 就回不去。
 * - **沒有 provider。** 見 `model-route.ts`。
 * - **選擇存在會話日誌，不存成使用者的個人預設。** PM 2026-10-08 決策：dsh 的背景存檔要有設定編輯器才存得住，我們沒有由程式代管的個人
 *   設定檔，照 dsh 沒掛設定編輯器時的已知限制（`agent-default-model/README.md:117`）處理。
 *
 * @module
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ModelSelectionController, modelNameOf, normalizeRoute, sameRoute } from '@nexus/core';
import type {
  ModelContextLimits,
  ModelRoute,
  NexusPlugin,
  PluginEntry,
  ProjectionUnit,
  SessionEvent,
} from '@nexus/core';
import { MODEL_SELECTION_PROJECTION_KEY } from '@nexus/wire';
import type {
  ModelCatalog,
  ModelCatalogModel,
  ModelSelectResult,
  ModelSelection,
  ModelSelectionState,
  ModelUnavailable,
} from '@nexus/wire';

import type { CredentialService } from './credentials.js';
import { createLiveModel } from './live-model.js';
import { findModelEntry } from './model-catalog.js';
import type { ModelEntry } from './model-catalog.js';
import type { LiveModelConfig } from './settings/live-model.js';

/** 今天能送到線上的推理等級（同 `subagent-model-selection.ts` 的 `SUPPORTED_EFFORTS`，那一份是它自己的清單）。 */
const SELECTABLE_EFFORTS = ['off'] as const;

/** 一筆型錄條目對外可選的推理等級：宣告過、而且今天實作的。 */
export function selectableEfforts(entry: ModelEntry): readonly string[] {
  const declared = entry.reasoningEfforts;
  if (declared === undefined || declared === false) return [];
  return SELECTABLE_EFFORTS.filter((name) => Object.hasOwn(declared, name));
}

/** 控制器要的兩樣東西以外，組裝端自己記的：型錄與連線值。 */
export interface ModelSelectionHost {
  readonly controller: ModelSelectionController;
  /** 一顆模型自己的窗口與輸出上限（摘要門檻逐步算用）；型錄沒有它就 `undefined`。 */
  limitsOf(model: unknown): ModelContextLimits | undefined;
  /** 型錄（`model.catalog` 用）。 */
  catalog(): ModelCatalog;
  /**
   * 驗一個選擇（`model.select` 用）：型錄有那顆、強度是它可選的等級（`default` 一律可）。通過回正規化後的路由。
   * 照 dsh `selectModel`：不在型錄、或模型沒有推理資訊卻帶強度、或帶了沒宣告的等級，都在打供應商之前拒（`model_unavailable`）。
   */
  validate(selection: ModelSelection): ModelRoute | ModelUnavailable;
  /**
   * 這條 thread 目前的選擇（`model.catalog` 回應的 `selection`，與即時推送的 `model-selection` 投影是同一個函式折出來的）。
   * 讀日誌上的現況，所以續接之後的第一次讀就是上一個行程留下的。
   */
  state(): ModelSelectionState;
  /**
   * 選一顆（`model.select` 用）：驗過型錄與強度才記進日誌，下一步起生效。選不上回 `model_unavailable`，選擇不變。
   *
   * @throws 控制器還沒接上這條 thread 的日誌（組裝期之後不該發生）。
   */
  select(selection: ModelSelection): ModelSelectResult;
}

/**
 * 建這條會話的模型選擇。
 *
 * @param options.liveModel - `live-model` 那一列（連線值與型錄）。
 * @param options.credentials - 憑證服務，建別顆實例用。
 */
export function createModelSelectionHost(options: {
  readonly liveModel: LiveModelConfig;
  readonly credentials: CredentialService | undefined;
}): ModelSelectionHost {
  const { liveModel, credentials } = options;
  const defaultRoute: ModelRoute = { model: liveModel.modelId };
  const instances = new Map<string, BaseChatModel>();

  const controller = new ModelSelectionController({
    defaultRoute,
    instanceFor: (route) => {
      // 預設那顆在組裝時建好、貼好標籤了，不為它另建（沒選過的會話逐欄與今天一致）。
      if (sameRoute(route, defaultRoute)) return undefined;
      const key = `${route.model}\u0000${route.effort ?? ''}`;
      let instance = instances.get(key);
      if (instance === undefined) {
        // 型錄沒有這個 id（例如續接的會話選過、後來被從型錄拿掉的）會在這裡拋，訊息指名它與型錄；
        // 使用者改選一顆型錄上有的就恢復。
        instance = createLiveModel({ ...liveModel, modelId: route.model }, undefined, credentials, {
          ...(route.effort === 'off' && { thinkingOff: true }),
        });
        instances.set(key, instance);
      }
      return instance;
    },
  });

  return {
    controller,
    limitsOf(model) {
      const id = modelNameOf(model);
      if (id === undefined) return undefined;
      const entry = findModelEntry(liveModel.models, id);
      return entry === undefined
        ? undefined
        : { contextWindow: entry.contextWindow, maxOutputTokens: entry.maxTokens };
    },
    catalog() {
      return {
        default: { modelId: liveModel.modelId },
        models: liveModel.models.map(catalogModelOf),
      };
    },
    state() {
      const { lastUsed, selected } = controller.state();
      return modelSelectionView({ lastUsed: lastUsed ?? null, selected: selected ?? null });
    },
    select(selection) {
      const route = this.validate(selection);
      if ('code' in route) return { ok: false, error: route };
      controller.select(route);
      return { ok: true, value: { selected: selection } };
    },
    validate(selection) {
      const entry = findModelEntry(liveModel.models, selection.modelId);
      if (entry === undefined) return unavailable(selection);
      const effort = selection.reasoningEffort;
      if (effort !== undefined) {
        const allowed = selectableEfforts(entry);
        if (allowed.length === 0) return unavailable(selection);
        if (effort !== 'default' && !allowed.includes(effort)) return unavailable(selection);
      }
      return normalizeRoute({
        model: selection.modelId,
        ...(effort !== undefined && { effort }),
      });
    },
  };
}

function unavailable(selection: ModelSelection): ModelUnavailable {
  return { code: 'model_unavailable', modelId: selection.modelId };
}

/**
 * 型錄條目→線上的一筆。`name` 沒有對應欄位（型錄條目只有 id），用 id；推理資訊只放可選的等級（`default` 在前，
 * 它是「不加任何設定」，也是 `defaultEffort`），沒有可選等級的模型不帶這一格，web 就不顯示強度列。
 */
export function catalogModelOf(entry: ModelEntry): ModelCatalogModel {
  const efforts = selectableEfforts(entry);
  return {
    id: entry.id,
    name: entry.id,
    ...(efforts.length > 0 && {
      reasoning: {
        efforts: [{ id: 'default', name: 'default' }, ...efforts.map((id) => ({ id, name: id }))],
        defaultEffort: 'default',
      },
    }),
  };
}

// ── 投影 ─────────────────────────────────────────────────────────────────────────────

/** 投影的折疊狀態：最近一次請求走的路由、使用者最後選的。 */
export interface ModelSelectionFold {
  readonly lastUsed: ModelRoute | null;
  readonly selected: ModelRoute | null;
}

const EMPTY: ModelSelectionFold = { lastUsed: null, selected: null };

function selectionOf(route: ModelRoute | null): ModelSelection | null {
  return route === null
    ? null
    : {
        modelId: route.model,
        ...(route.effort !== undefined && { reasoningEffort: route.effort }),
      };
}

/**
 * 折疊狀態→給 web 的 {@link ModelSelectionState}：`next` 是使用者最後選的、沒選過就等於 `lastUsed`（dsh `modelSelection` 投影）。
 * **`model.catalog` 的 `selection` 也走這一個函式**，兩處不會各算各的。
 */
export function modelSelectionView(state: ModelSelectionFold): ModelSelectionState {
  return {
    lastUsed: selectionOf(state.lastUsed),
    next: selectionOf(state.selected ?? state.lastUsed),
  };
}

/** 折一顆事件。不相干的回同一個參照。 */
export function applyModelSelectionEvent(
  state: ModelSelectionFold,
  event: SessionEvent,
): ModelSelectionFold {
  if (event.type === 'model/start') {
    const route = event.data.route;
    if (route === undefined) return state;
    const next = normalizeRoute(route);
    return state.lastUsed !== null && sameRoute(state.lastUsed, next)
      ? state
      : { ...state, lastUsed: next };
  }
  if (event.type === 'model/selection') {
    const next = normalizeRoute({
      model: event.data.modelId,
      ...(event.data.reasoningEffort !== undefined && { effort: event.data.reasoningEffort }),
    });
    return state.selected !== null && sameRoute(state.selected, next)
      ? state
      : { ...state, selected: next };
  }
  return state;
}

/** `model-selection` 投影單元。 */
export const modelSelectionUnit: ProjectionUnit<ModelSelectionFold, ModelSelectionState> = {
  key: MODEL_SELECTION_PROJECTION_KEY,
  // 1：`{ lastUsed, next }`，next 是選的 → 走的。
  stateVersion: 1,
  init: () => EMPTY,
  apply: applyModelSelectionEvent,
  view: modelSelectionView,
};

/** 把一份日誌現有的事件折成狀態（`model.catalog` 的 `selection` 用）。 */
export function foldModelSelection(events: readonly SessionEvent[]): ModelSelectionFold {
  return events.reduce(applyModelSelectionEvent, EMPTY);
}

/**
 * 掛上模型選擇的 plugin：把控制器接上 root 的日誌、登記投影。**子代理的日誌不接**（模型選擇只管 root）。
 *
 * @param host - {@link createModelSelectionHost} 的產物。
 */
export function createModelSelectionPlugin(host: ModelSelectionHost): PluginEntry {
  const plugin: NexusPlugin = {
    name: 'model-selection',
    apply(registry) {
      registry.projections.register(modelSelectionUnit);
      registry.sessions.join((subject) => {
        if (subject.address.kind === 'root') host.controller.attach(subject.log);
        return undefined;
      });
    },
  };
  return { plugin };
}
