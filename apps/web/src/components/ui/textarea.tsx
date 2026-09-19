/**
 * 來源：shadcn registry `textarea`（style new-york，https://ui.shadcn.com/r/styles/new-york-v4/textarea.json），
 * shadcn CLI 4.21.0 `shadcn add input-group textarea command popover --overwrite`。裝進來就是我們的原始碼，
 * 不靠重跑 `shadcn add` 更新。
 * 改過的地方：拿掉 `shadow-xs`（同 `input.tsx`：留 border 不再疊陰影，§11 第 1 條擋下）。輸入框裡用的是
 * `InputGroupTextarea`，邊線與陰影都由外層的 `InputGroup` 畫。
 */
import * as React from 'react';
import { cn } from 'cn';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
