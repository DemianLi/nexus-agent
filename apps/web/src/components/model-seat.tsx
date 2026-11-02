import type { ModelSelection } from '@nexus/wire';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ComposerPick } from '@/components/ui/composer';
import type { ModelSeat as ModelSeatData } from '@/hooks/use-model-seat';
import { effortOf, findModel, reasoningOf, selectionForModel } from '@/lib/model-selection';

/** 選擇失敗時 toast 的標題；原因放在說明裡。 */
export const MODEL_SELECT_FAILED = '沒換成這顆模型';

/**
 * 輸入框底列右邊的模型與推理強度（[#723](https://github.com/DemianLi/nexus-agent/issues/723)；#1591 拆成兩個 SG 的
 * `ComposerPick`，照 SG demo）。**從下一步生效，跑著的那步不換**——兩個的報讀名稱都說，免得人以為這一步會跟著換。
 *
 * - **推理強度只在模型宣告了 efforts 時才出現**（`reasoningOf`）。
 * - **模型那個是受控的**（`open`／`onOpenChange`，patch `0007`）：`/model` 光打就打開它。
 * - 報讀名稱帶現在的值（`triggerLabel`，WCAG 2.5.3）。選完焦點回 Trigger（Base UI 的預設，#1591 PM 決定第 3 題）。
 * - 換不成（`model_unavailable` 之類）跳 toast，座位不變。
 * - **窄的時候只有模型那顆縮**（名稱截短，375 寬不撐出底列）：模型那層 `flex min-w-0`，Trigger 的 `min-width` 在覆寫檔
 *   歸零（README 本地修改第 40 條）。其餘幾顆的 `min-width: auto` 就是內容寬，本來就縮不下去。
 * - `hidden`（輸入框被面板換掉）時不畫，理由同權限座。
 *
 * 資料與「有沒有這個座位」由 `useModelSeat` 決定；這裡拿到的一定是有型錄的。
 */
export function ModelSeat({
  seat,
  open,
  onOpenChange,
  hidden = false,
}: {
  readonly seat: ModelSeatData;
  /** 模型那個 Pick 開著沒有。 */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 輸入框現在被換掉了。 */
  readonly hidden?: boolean;
}) {
  const [effortOpen, setEffortOpen] = useState(false);
  if (hidden && effortOpen) setEffortOpen(false);
  // 模型那個的 `open` 在呼叫端：收起要等這一輪畫完再叫，不能在畫的時候改別人的 state。
  useEffect(() => {
    if (hidden && open) onOpenChange(false);
  }, [hidden, open, onOpenChange]);
  if (hidden) return null;

  const { catalog, selection } = seat;
  const current = findModel(catalog, selection.modelId);
  const modelName = current?.name ?? selection.modelId;
  const effort = current === undefined ? undefined : effortOf(current, selection);
  const efforts = current === undefined ? undefined : reasoningOf(current);
  const effortName = efforts?.efforts.find((item) => item.id === effort)?.name;

  const select = (next: ModelSelection) => {
    void seat.select(next).then((failure) => {
      if (failure !== undefined) toast.error(MODEL_SELECT_FAILED, { description: failure });
    });
  };

  return (
    <>
      <span data-slot="model-pick" data-testid="model-seat" className="flex min-w-0">
        <ComposerPick
          label="模型"
          value={selection.modelId}
          shown={modelName}
          options={catalog.models.map((model) => ({
            value: model.id,
            label: model.name,
            ...(model.description === undefined ? {} : { hint: model.description }),
          }))}
          triggerLabel={`模型：${modelName}，從下一步生效，點開切換`}
          open={open}
          onOpenChange={onOpenChange}
          onValueChange={(id) => {
            const model = findModel(catalog, id);
            if (model === undefined || id === selection.modelId) return;
            select(selectionForModel(model, selection));
          }}
        />
      </span>
      {efforts !== undefined && (
        <span data-slot="effort-pick" data-testid="effort-seat">
          <ComposerPick
            label="推理強度"
            value={effort ?? ''}
            {...(effortName === undefined ? {} : { shown: effortName })}
            options={efforts.efforts.map((item) => ({
              value: item.id,
              label: item.name,
              ...(item.description === undefined ? {} : { hint: item.description }),
            }))}
            triggerLabel={`推理強度：${effortName ?? '預設'}，從下一步生效，點開切換`}
            open={effortOpen}
            onOpenChange={setEffortOpen}
            onValueChange={(id) => {
              if (id === effort) return;
              select({ modelId: selection.modelId, reasoningEffort: id });
            }}
          />
        </span>
      )}
    </>
  );
}
