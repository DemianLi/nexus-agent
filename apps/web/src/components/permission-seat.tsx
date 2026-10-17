import { useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ComposerPick } from '@/components/ui/composer';
import type { PermissionSeat as PermissionSeatData } from '@/hooks/use-permission-seat';
import {
  DANGER_PRESET,
  currentPreset,
  permissionLine,
  permissionSeatText,
} from '@/lib/permission-presets';

/** 切到「全開」前要人確認的說明；固定寫，不靠目錄的描述（那是部署的人寫的，可能沒寫）。 */
export const DANGER_CONFIRM_TEXT =
  '「全開」會關掉沙箱的限制，而且不再跳出核准請求：需要人點頭的操作會直接被回絕。模型問你的問題與計劃審核照常出現。';

/** 權限座的報讀名稱：看得到的值原樣在裡面（WCAG 2.5.3），鎖住時接著說原因（#1591 PM 決定第 2 題）。 */
export function permissionTriggerLabel(text: string, locked: string | undefined): string {
  return `權限：${text}，${locked === undefined ? '點開切換' : locked.replace(/。$/, '')}`;
}

/**
 * 輸入框底列左邊的模式座（[#437](https://github.com/DemianLi/nexus-agent/issues/437)；#1591 換成 SG 的 `ComposerPick`）：
 * 點開選一組權限組合（沙箱加核准），選了就送 `/permission <組名>`（dsh 的網頁選單也是）。**選「全開」要先確認**
 * （alert-dialog，預設落在取消）。
 *
 * - 目前是哪一組只看伺服器推的投影（`usePermissionSeat`）。`custom`（沙箱與核准對不上任何一組）用 `shown` 顯示「自訂」，
 *   清單裡沒有哪一列打勾，也不是切換目標。
 * - **鎖住時清單打不開**（一輪在跑、斷線；照 dsh `PermissionSelect.tsx:180`）：Trigger 照樣聚焦得到，原因寫在報讀名稱裡
 *   （patch `0007` 的 `disabled` 與 `triggerLabel`）。看畫面的人只看得到它停用了，看不到原因（dsh 也只放在 `title`）。
 * - **全開時換警示色**：外面這層帶 `data-danger`，覆寫檔對裡面的 Trigger 上色（README 本地修改第 35 條）。
 * - `hidden`（輸入框被面板換掉）時不畫：Pick 的清單 portal 在 body 上，不卸載的話會浮在面板上面。
 */
export function PermissionSeat({
  seat,
  locked,
  onSwitch,
  hidden = false,
}: {
  readonly seat: PermissionSeatData;
  readonly locked: string | undefined;
  /** 送出那一行斜線命令。 */
  readonly onSwitch: (line: string) => void;
  /** 輸入框現在被換掉了。 */
  readonly hidden?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  // 開著時鎖上（一輪開始跑）就收起；不然解鎖時清單會自己冒出來。
  if (open && (locked !== undefined || hidden)) setOpen(false);
  const { catalog, currentValue } = seat;
  const text = permissionSeatText(catalog, currentValue);
  const danger = currentValue === DANGER_PRESET;
  const target = confirming === null ? undefined : currentPreset(catalog, confirming);

  return (
    <>
      {!hidden && (
        <span data-slot="permission-pick" data-danger={danger} data-testid="permission-seat">
          <ComposerPick
            label="權限"
            align="start"
            value={currentValue}
            shown={text}
            options={catalog.options.map((option) => ({
              value: option.value,
              label: option.name,
              ...(option.description === undefined ? {} : { hint: option.description }),
            }))}
            triggerLabel={permissionTriggerLabel(text, locked)}
            open={open}
            onOpenChange={setOpen}
            disabled={locked !== undefined}
            onValueChange={(value) => {
              // 已經是這一組：什麼都不送。
              if (value === currentValue) return;
              if (value === DANGER_PRESET) setConfirming(value);
              else onSwitch(permissionLine(value));
            }}
          />
        </span>
      )}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
      >
        <AlertDialogContent data-testid="permission-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>切換到「{target?.name ?? '全開'}」？</AlertDialogTitle>
            <AlertDialogDescription>{DANGER_CONFIRM_TEXT}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming !== null) onSwitch(permissionLine(confirming));
              }}
            >
              切換
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
