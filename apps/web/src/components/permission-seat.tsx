import { Shield, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import { PickerSeat } from '@/components/picker-seat';
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

/**
 * 輸入框底列的權限座（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）：點開選一組權限組合（沙箱加核准），
 * 選了就送 `/permission <組名>`（dsh 的網頁選單也是）。**選「全開」要先確認**（alert-dialog，預設落在取消）。
 *
 * 目前是哪一組只看伺服器推的投影（`usePermissionSeat`）。`custom`（沙箱與核准對不上任何一組）只顯示，不是切換目標。
 * 一輪在跑或斷線時清單照開、每列停用，底下寫原因（`locked`）。
 */
export function PermissionSeat({
  seat,
  open,
  onOpenChange,
  locked,
  onSwitch,
}: {
  readonly seat: PermissionSeatData;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly locked: string | undefined;
  /** 送出那一行斜線命令。 */
  readonly onSwitch: (line: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const { catalog, currentValue } = seat;
  const text = permissionSeatText(catalog, currentValue);
  const danger = currentValue === DANGER_PRESET;
  const target = confirming === null ? undefined : currentPreset(catalog, confirming);

  return (
    <>
      <PickerSeat
        testId="permission-seat"
        icon={danger ? <ShieldAlert className="size-4" /> : <Shield className="size-4" />}
        label={text}
        warning={danger}
        accessibleName={`權限：${text}，點開切換`}
        tip={`權限：${text}`}
        popoverLabel="選權限"
        groups={[
          {
            id: 'permission',
            heading: '權限',
            items: catalog.options.map((option) => ({
              id: option.value,
              label: option.name,
              ...(option.description === undefined ? {} : { description: option.description }),
              checked: option.value === currentValue,
            })),
          },
        ]}
        open={open}
        onOpenChange={onOpenChange}
        {...(locked === undefined ? {} : { locked })}
        onPick={(_group, item) => {
          onOpenChange(false);
          // 已經是這一組：什麼都不送。
          if (item.id === currentValue) return;
          if (item.id === DANGER_PRESET) setConfirming(item.id);
          else onSwitch(permissionLine(item.id));
        }}
      />
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
