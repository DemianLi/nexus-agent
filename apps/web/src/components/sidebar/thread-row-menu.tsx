import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Pin, PinOff } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarInput, SidebarMenuAction } from '@/components/ui/sidebar';
import type { ThreadActionResult } from '@/lib/thread-management';

/**
 * 會話列的管理：「⋯」選單（釘選、改名、封存）與行內改名輸入（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）。
 * 只在側欄拿到 `ThreadManagement` 時才畫（`thread-list.tsx`）；規則與開關見 `lib/thread-management.ts`。
 *
 * - **選單**：桌面滑過那一列才現身（鍵盤聚焦也算），觸控（1024 以下）常駐。選項依狀態換：釘選／取消釘選、封存／取消封存。
 *   **封存的不能釘**，所以封存的那一列沒有釘選。**目前這條不給封存**：人還在這條裡講話。
 * - **改名**：那一列原地換成輸入框，Enter 送出、Esc 放棄、點旁邊算送出（沒改或空的算放棄）。送出失敗（伺服器說了原因）留在輸入框、
 *   講出原因，不蓋掉人打的字。
 *
 * @module
 */

export interface RowMenuProps {
  readonly label: string;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly current: boolean;
  readonly onPin: () => ThreadActionResult;
  readonly onUnpin: () => ThreadActionResult;
  readonly onArchive: () => ThreadActionResult;
  readonly onUnarchive: () => ThreadActionResult;
  readonly onRename: () => void;
}

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

export function ThreadRowMenu(props: RowMenuProps) {
  const { label, pinned, archived, current } = props;
  // 選「改名」之後選單關閉會把焦點還給「⋯」，蓋掉輸入框剛要到的焦點；那一次不還。
  const renaming = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction
          showOnHover
          aria-label={`「${label}」的選項`}
          className="size-8 lg:size-5"
        >
          <MoreHorizontal aria-hidden />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(event) => {
          if (renaming.current) {
            renaming.current = false;
            event.preventDefault();
          }
        }}
      >
        {!archived && (
          <DropdownMenuItem
            onSelect={() => {
              report(pinned ? '取消釘選' : '釘選', pinned ? props.onUnpin() : props.onPin());
            }}
          >
            {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
            {pinned ? '取消釘選' : '釘選'}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => {
            renaming.current = true;
            props.onRename();
          }}
        >
          <Pencil aria-hidden />
          重新命名
        </DropdownMenuItem>
        {(archived || !current) && <DropdownMenuSeparator />}
        {archived ? (
          <DropdownMenuItem onSelect={() => report('取消封存', props.onUnarchive())}>
            <ArchiveRestore aria-hidden />
            取消封存
          </DropdownMenuItem>
        ) : (
          !current && (
            <DropdownMenuItem onSelect={() => report('封存', props.onArchive())}>
              <Archive aria-hidden />
              封存
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
