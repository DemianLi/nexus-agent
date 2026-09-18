/**
 * 來源：shadcn registry `skeleton`（style new-york，https://ui.shadcn.com/r/styles/new-york-v4/skeleton.json），
 * shadcn CLI 4.21.0 `shadcn add sidebar sheet --overwrite`。裝進來就是我們的原始碼，不靠重跑 `shadcn add` 更新。
 * 沒有改動。
 */
import { cn } from 'cn';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-accent', className)}
      {...props}
    />
  );
}

export { Skeleton };
