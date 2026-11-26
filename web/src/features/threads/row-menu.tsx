import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  createDropdownMenuHandle,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { DropdownMenuHandle } from '@/components/ui/dropdown-menu';
import { SidebarInput, SidebarMenuAction } from '@/components/ui/sidebar';
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
import { explainArchiveStop } from '@/features/threads/management';
import type { ArchiveAnswer, ThreadActionResult } from '@/features/threads/management';
import type { ThreadActivityKind } from '@nexus/wire';

/**
 * 會話列的管理：「⋯」選單（釘選、改名、封存、刪除）與行內改名輸入（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）。
 * 只在側欄拿到 `ThreadManagement` 時才畫（`list.tsx`）；規則與開關見 `features/threads/management.ts`。
 *
 * - **選單**：桌面滑過那一列才現身（鍵盤聚焦也算），觸控（1024 以下）常駐。選項依狀態換：釘選／取消釘選、封存／取消封存。
 *   **封存的不能釘**，所以封存的那一列沒有釘選。目前這條也能封存：人留在這條，輸入框上方換成已封存的橫幅（`archived-banner.tsx`）。
 * - **刪除**（[#2958](https://github.com/DemianLi/nexus-agent/issues/2958)）：server 接了已刪除存放區才有；每一條都能刪（目前這條、已封存的也是），
 *   一律先問。在跑或在等人的，確認鈕寫「停掉並刪除」：server 刪除時一律先停再搬，字要講出這件事。刪掉目前這條之後去哪裡由 `App` 決定。
 * - **整張清單共用一份選單與確認框**（`ThreadRowMenus`），每一列只有一顆觸發鈕（`ThreadRowMenuTrigger`），按下時帶著那一列的
 *   `RowMenuTarget`。
 * - **改名**：那一列原地換成輸入框，Enter 送出、Esc 放棄、點旁邊算送出（沒改或空的算放棄）。送出失敗（伺服器說了原因）留在輸入框、
 *   講出原因，不蓋掉人打的字。
 *
 * @module
 */

/** 「⋯」按下去時那一列的樣子：選單的選項依它換。 */
export interface RowMenuTarget {
  readonly threadId: string;
  readonly label: string;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly current: boolean;
  /** 在跑或在等人回答（「跑完沒看」不算）。 */
  readonly active: boolean;
}

/** 選單上的動作，按 thread id 呼叫。`onRename` 等選單收完（`onOpenChangeComplete`）才呼叫。 */
export interface RowMenuActions {
  readonly onPin: (threadId: string) => ThreadActionResult;
  readonly onUnpin: (threadId: string) => ThreadActionResult;
  readonly onArchive: (
    threadId: string,
    options?: { readonly stopActivity?: boolean },
  ) => ArchiveAnswer;
  readonly onUnarchive: (threadId: string) => ThreadActionResult;
  readonly onRename: (threadId: string) => void;
  readonly onDelete: (threadId: string) => ThreadActionResult;
}

/**
 * 一張清單一份：交給該清單每一顆 `ThreadRowMenuTrigger` 與唯一一份 `ThreadRowMenus`。元件存活期間要保持同一個
 * （例如 `useState(createRowMenuHandle)`），`ThreadRow` 的 `memo` 比對它的身分。
 */
export type RowMenuHandle = DropdownMenuHandle<RowMenuTarget>;

/** 建一份 {@link RowMenuHandle}。 */
export const createRowMenuHandle = (): RowMenuHandle => createDropdownMenuHandle<RowMenuTarget>();

/** 動作失敗時講出原因；成功什麼都不說（那一列的位置變了就是回饋）。 */
function report(action: string, result: ThreadActionResult): void {
  void result.then(
    (message) => {
      if (message !== undefined) toast.error(`${action}失敗`, { description: message });
    },
    (error: unknown) => {
      toast.error(`${action}失敗`, {
        description: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

/** 封存一條會話；它還在跑時 server 要人先說「要停掉」，那一句交給 `onNeedsStop` 去問（確認框）。 */
function archive(
  actions: RowMenuActions,
  threadId: string,
  options: { readonly stopActivity?: boolean } | undefined,
  onNeedsStop: (activity: readonly ThreadActivityKind[]) => void,
): void {
  void actions.onArchive(threadId, options).then(
    (answer) => {
      if (answer === undefined) return;
      if (typeof answer === 'string') toast.error('封存失敗', { description: answer });
      else onNeedsStop(answer.needsStop);
    },
    (error: unknown) => {
      toast.error('封存失敗', {
        description: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

/** 一列上的「⋯」：只是一顆觸發鈕，選單本身整張清單共用一份（`ThreadRowMenus`）。 */
export function ThreadRowMenuTrigger({
  handle,
  target,
}: {
  readonly handle: RowMenuHandle;
  readonly target: RowMenuTarget;
}) {
  return (
    <DropdownMenuTrigger
      handle={handle}
      payload={target}
      render={
        <SidebarMenuAction
          showOnHover
          aria-label={`「${target.label}」的選項`}
          className="size-8 lg:size-6"
        />
      }
    >
      <MoreHorizontal aria-hidden />
    </DropdownMenuTrigger>
  );
}

/**
 * 整張清單共用的選單與確認框：按下哪一列的「⋯」，選單就照那一列（觸發鈕帶的 `payload`）換選項。
 * 每一列各掛一份的話，清單每重畫一次就要重畫幾百份選單（回歸測試在 `list.rerender.test.tsx`）。
 */
export function ThreadRowMenus({
  handle,
  actions,
  deletable,
}: {
  readonly handle: RowMenuHandle;
  readonly actions: RowMenuActions;
  /** server 接了已刪除存放區：選單多一項「刪除」。 */
  readonly deletable: boolean;
}) {
  // 封存還在跑的會話要多問一句：問的是哪一條、server 說它在跑什麼（舊 server 沒帶就是空的）。
  // 對話框問的是哪一條另外存、關掉時不清：關閉的動畫還在畫，清掉的話標題與內文會先變空才消失。
  const [confirmStop, setConfirmStop] = useState<
    { readonly target: RowMenuTarget; readonly activity: readonly ThreadActivityKind[] } | undefined
  >(undefined);
  const [stopOpen, setStopOpen] = useState(false);
  // 選了「改名」的那一條：等選單收完才換成輸入框。選單還開著時，輸入框拿到的焦點會被選單拉回去，一失焦就當成沒改收起來。
  // 選單關掉時也不把焦點還給「⋯」，那一次焦點要留給輸入框。
  const renaming = useRef<string | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<RowMenuTarget | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <>
      <DropdownMenuRoot
        handle={handle}
        onOpenChangeComplete={(open) => {
          const threadId = renaming.current;
          if (open || threadId === undefined) return;
          renaming.current = undefined;
          actions.onRename(threadId);
        }}
      >
        {({ payload: target }) =>
          target !== undefined && (
            <DropdownMenuContent align="start" finalFocus={() => renaming.current === undefined}>
              {!target.archived && (
                <DropdownMenuItem
                  onClick={() => {
                    report(
                      target.pinned ? '取消釘選' : '釘選',
                      target.pinned
                        ? actions.onUnpin(target.threadId)
                        : actions.onPin(target.threadId),
                    );
                  }}
                >
                  {target.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
                  {target.pinned ? '取消釘選' : '釘選'}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => {
                  renaming.current = target.threadId;
                }}
              >
                <Pencil aria-hidden />
                重新命名
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {target.archived ? (
                <DropdownMenuItem
                  onClick={() => report('取消封存', actions.onUnarchive(target.threadId))}
                >
                  <ArchiveRestore aria-hidden />
                  取消封存
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={() =>
                    archive(actions, target.threadId, undefined, (activity) => {
                      setConfirmStop({ target, activity });
                      setStopOpen(true);
                    })
                  }
                >
                  <Archive aria-hidden />
                  封存
                </DropdownMenuItem>
              )}
              {deletable && (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    setConfirmDelete(target);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 aria-hidden />
                  刪除
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          )
        }
      </DropdownMenuRoot>
      <AlertDialog open={stopOpen} onOpenChange={setStopOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>封存「{confirmStop?.target.label}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {explainArchiveStop(confirmStop?.activity ?? [])}可從「已封存」取消封存。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不要</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmStop === undefined) return;
                archive(
                  actions,
                  confirmStop.target.threadId,
                  { stopActivity: true },
                  () => undefined,
                );
              }}
            >
              停掉並封存
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>刪除「{confirmDelete?.label}」？</AlertDialogTitle>
            <AlertDialogDescription>
              會移到「最近刪除」，到期前可復原；從它分支出去的會話不受影響。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不要</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmDelete === undefined) return;
                report('刪除', actions.onDelete(confirmDelete.threadId));
              }}
            >
              {confirmDelete?.active === true ? '停掉並刪除' : '刪除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** 行內改名。`onCommit` 回失敗的原因；成功回 `undefined`，由呼叫端收起這個輸入框。 */
export function RenameField({
  initial,
  onCommit,
  onCancel,
}: {
  readonly initial: string;
  readonly onCommit: (title: string) => ThreadActionResult;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  // Enter 與失焦會連著來（送出後輸入框消失也會失焦）：只送一次。
  const settled = useRef(false);

  const commit = () => {
    if (settled.current || pending) return;
    const title = value.replace(/\s+/g, ' ').trim();
    if (title === '' || title === initial) {
      settled.current = true;
      onCancel();
      return;
    }
    setPending(true);
    setError(undefined);
    onCommit(title).then(
      (message) => {
        if (message === undefined) {
          settled.current = true;
        } else {
          setPending(false);
          setError(message);
        }
      },
      (failure: unknown) => {
        setPending(false);
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
  };

  return (
    <div className="flex flex-col gap-1 px-1 py-1">
      <SidebarInput
        autoFocus
        aria-label="重新命名會話"
        aria-invalid={error !== undefined}
        value={value}
        disabled={pending}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setValue(event.target.value);
          setError(undefined);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            settled.current = true;
            onCancel();
          }
        }}
        onBlur={commit}
        className="h-11 lg:h-8"
      />
      {error !== undefined && (
        <p role="alert" className="text-destructive px-1 text-tip">
          {error}
        </p>
      )}
    </div>
  );
}
