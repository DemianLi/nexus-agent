import { Cpu } from 'lucide-react';
import { toast } from 'sonner';

import { PickerSeat } from '@/components/picker-seat';
import type { PickerGroup } from '@/components/picker-seat';
import type { ModelSeat as ModelSeatData } from '@/hooks/use-model-seat';
import {
  effortOf,
  findModel,
  reasoningOf,
  seatText,
  selectionForModel,
} from '@/lib/model-selection';

/** 選擇失敗時 toast 的標題；原因放在說明裡。 */
export const MODEL_SELECT_FAILED = '沒換成這顆模型';

/**
 * 輸入框底列的模型座（[#723](https://github.com/DemianLi/nexus-agent/issues/723)）：點開選模型，模型有宣告推理強度
 * 的話底下多一段選強度。**從下一步生效，跑著的那步不換**——浮層裡寫明，免得人以為這一步會跟著換。
 *
 * 資料與「有沒有這個座位」由 `useModelSeat` 決定；這裡拿到的一定是有型錄的。
 */
export function ModelSeat({
  seat,
  open,
  onOpenChange,
}: {
  readonly seat: ModelSeatData;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { catalog, selection } = seat;
  const current = findModel(catalog, selection.modelId);
  const text = seatText(catalog, selection);
  const effort = current === undefined ? undefined : effortOf(current, selection);
  const efforts = current === undefined ? undefined : reasoningOf(current);

  const groups: PickerGroup[] = [
    {
      id: 'model',
      heading: '模型',
      items: catalog.models.map((model) => ({
        id: model.id,
        label: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        checked: model.id === selection.modelId,
      })),
    },
  ];
  if (efforts !== undefined) {
    groups.push({
      id: 'effort',
      heading: '推理強度',
      items: efforts.efforts.map((item) => ({
        id: item.id,
        label: item.name,
        ...(item.description === undefined ? {} : { description: item.description }),
        checked: item.id === effort,
      })),
    });
  }

  return (
    <PickerSeat
      testId="model-seat"
      icon={<Cpu className="size-4" />}
      label={text}
      accessibleName={`模型：${text}，點開切換`}
      tip={`模型：${text}（從下一步生效）`}
      popoverLabel="選模型"
      searchPlaceholder="搜尋模型…"
      groups={groups}
      open={open}
      onOpenChange={onOpenChange}
      onPick={(group, item) => {
        const model = findModel(catalog, item.id);
        const next =
          group.id === 'effort'
            ? { modelId: selection.modelId, reasoningEffort: item.id }
            : model === undefined
              ? undefined
              : selectionForModel(model, selection);
        if (next === undefined) return;
        onOpenChange(false);
        void seat.select(next).then((failure) => {
          if (failure !== undefined) toast.error(MODEL_SELECT_FAILED, { description: failure });
        });
      }}
    />
  );
}
