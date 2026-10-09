import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** 清單裡的一列。 */
export interface PickerItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** 現在選的是這一列。 */
  readonly checked: boolean;
}

/** 清單分的一段（例如「模型」與「推理強度」）；只有一段時不畫標題。 */
export interface PickerGroup {
  readonly id: string;
  readonly heading: string;
  readonly items: readonly PickerItem[];
}

/** 超過幾列才出現搜尋框。 */
export const PICKER_SEARCH_THRESHOLD = 6;

/**
 * 輸入框底列的選擇座位（[#723](https://github.com/DemianLi/nexus-agent/issues/723)；#437 的權限座也用它）：
 * 一顆小按鈕，點開是浮層清單，選了就關。
 *
 * - **窄螢幕只剩圖示**（`< sm`）：底列同排還有加入鈕、送出提示、用量表與送出鈕，擠不下文字；按鈕的**無障礙名稱**照樣
 *   含目前的值（`accessibleName`），圖示旁的字只是給看得到的人。tooltip 寫同一句（hover 才有，手機靠點開浮層）。
 * - **焦點**：選了之後交回輸入框（`onCloseFocus`），不留在已經關掉的按鈕上。
 * - **受控**：`open` 由呼叫端持有，`/model` 才打得開它。
 */
export function PickerSeat({
  icon,
  label,
  accessibleName,
  tip,
  groups,
  onPick,
  open,
  onOpenChange,
  popoverLabel,
  searchPlaceholder = '搜尋…',
  testId,
  warning = false,
  locked,
}: {
  readonly icon: ReactNode;
  /** 圖示旁的字：目前的值。 */
  readonly label: string;
  /** 按鈕的無障礙名稱，要含目前的值。 */
  readonly accessibleName: string;
  readonly tip: string;
  readonly groups: readonly PickerGroup[];
  /** 選了某一段的某一列。 */
  readonly onPick: (group: PickerGroup, item: PickerItem) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly popoverLabel: string;
  readonly searchPlaceholder?: string;
  readonly testId: string;
  /** 目前的值是要留意的那一種（例如權限的「全開」）：座位換警示色。 */
  readonly warning?: boolean;
  /** 現在選不了（例如一輪還在跑）：清單照開、每一列停用，底下寫這一句原因。 */
  readonly locked?: string;
}) {
  const rows = groups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger
            aria-label={accessibleName}
            data-testid={testId}
            data-warning={warning}
            className={`hover:bg-chip-hover active:bg-chip-pressed flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-ui transition-colors duration-(--duration-quick) lg:h-9 lg:min-w-9 ${warning ? 'text-warning' : 'text-muted-foreground'}`}
          >
            <span aria-hidden className="flex size-4 items-center justify-center">
              {icon}
            </span>
            <span aria-hidden className="hidden max-w-40 truncate sm:inline">
              {label}
            </span>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        aria-label={popoverLabel}
        className="w-72 max-w-[calc(100vw-2rem)] p-0"
        onCloseAutoFocus={(event) => {
          // 交回輸入框，不留在剛關掉的按鈕上。
          event.preventDefault();
          document.getElementById('prompt')?.focus();
        }}
      >
        <Command>
          {rows > PICKER_SEARCH_THRESHOLD && <CommandInput placeholder={searchPlaceholder} />}
          <CommandList>
            <CommandEmpty>找不到符合的項目。</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                key={group.id}
                {...(groups.length > 1 ? { heading: group.heading } : {})}
              >
                {group.items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={`${item.label} ${item.id}`}
                    data-checked={item.checked}
                    disabled={locked !== undefined}
                    onSelect={() => {
                      onPick(group, item);
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body">{item.label}</p>
                      {item.description !== undefined && (
                        <p className="text-muted-foreground truncate text-tip">
                          {item.description}
                        </p>
                      )}
                    </div>
                    {item.checked && <Check aria-label="目前選的" className="size-4 shrink-0" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          {locked !== undefined && (
            <p
              className="text-muted-foreground border-t px-3 py-2 text-tip"
              data-testid="picker-locked"
            >
              {locked}
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
