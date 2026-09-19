/**
 * 來源：shadcn registry `input`（style new-york，https://ui.shadcn.com/r/styles/new-york-v4/input.json），
 * shadcn CLI 4.21.0 `shadcn add sidebar sheet --overwrite`。裝進來就是我們的原始碼，不靠重跑 `shadcn add` 更新。
 * 改過的地方：拿掉 `shadow-xs`（邊緣畫在陰影裡：輸入框留 border，不再疊陰影；原型沒改這一處，§11 第 1 條擋下）。
 */
import * as React from 'react';
import { cn } from 'cn';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
