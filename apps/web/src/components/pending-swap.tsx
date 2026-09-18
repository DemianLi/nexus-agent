/**
 * 換手層（規格 §4.3、§8，#408）：有待決的核准或提問時，面板換掉輸入框。⑨ 的提問面板也掛在這一層。
 *
 * - **輸入框隱藏不卸載**：`hidden`＋`inert`，草稿還在呼叫端的 state 裡、游標與選單也不重來。原型的 `Swap` 會卸載，
 *   不能照抄。
 * - **同時只一個面板、先來先處理**：畫 `pendings` 的第一顆；面板名稱帶跨面板進度「（1／2）」（`pendingLabel`）。
 * - **焦點只在本來會丟掉時才搬**，判斷只寫在這裡：焦點在這一區裡（輸入框要被藏起來、上一張面板被拿掉）或已經掉到
 *   body 時才搬；人在別處看工具卡就不搶，由狀態列唸面板名稱。搬到面板時落在面板宣告的位置（`data-pending-focus`，
 *   ⑨ 的當前題），沒有就落在面板本身（`tabIndex=-1`，核准面板不落在按鈕上）；面板收掉時到下一張或回輸入框。
 * - **動效是「換內容」**（§7）：舊的 150 淡出，換過去之後新的 250 長出（`motion-swap`，在 `styles/motion.css`）。
 *   第一次畫出來不動：載入歷史、切換對話不走動效。
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { PendingInput } from '@nexus/wire';

import { Card } from '@/components/ui/card';
import { pendingLabel } from '@/lib/pending-label';

/** 舊的那一邊淡出多久（`--duration-quick`）；淡完才換成新的。 */
const SWAP_OUT_MS = 150;

const COMPOSER = 'composer';

export function PendingSwap({
  pendings,
  composer,
  composerRef,
  renderPanel,
}: {
  readonly pendings: readonly PendingInput[];
  /** 輸入框：沒有待決時畫它，有待決時藏起來。 */
  readonly composer: ReactNode;
  /** 面板收掉、焦點要回輸入框時用。 */
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  /** 面板裡面的東西；外框、名稱與邊框光由這一層畫。 */
  readonly renderPanel: (pending: PendingInput) => ReactNode;
}) {
  const pending = pendings[0];
  const target = pending?.interruptId ?? COMPOSER;
  const [shown, setShown] = useState(target);
  const [swapped, setSwapped] = useState(false);
  const leaving = target !== shown;

  // 淡出那 150ms 裡還要畫舊的那一張，而它可能已經被答掉、不在 `pendings` 裡了。
  const lastShown = useRef<PendingInput | undefined>(undefined);
  const current = pendings.find((item) => item.interruptId === shown);
  if (current !== undefined) lastShown.current = current;
  const panel = shown === COMPOSER ? undefined : (current ?? lastShown.current);
  const index = panel === undefined ? -1 : pendings.indexOf(panel);
  const label =
    panel === undefined
      ? undefined
      : pendingLabel(panel, {
          index: Math.max(0, index),
          total: Math.max(1, pendings.length),
        });

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => {
      setShown(target);
      setSwapped(true);
    }, SWAP_OUT_MS);
    return () => clearTimeout(timer);
  }, [leaving, target]);

  const zone = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const active = document.activeElement;
    const lost =
      active === null || active === document.body || (zone.current?.contains(active) ?? false);
    if (!lost) return;
    if (shown === COMPOSER) {
      composerRef.current?.focus();
      return;
    }
    const element = zone.current?.querySelector<HTMLElement>('[data-slot="pending-panel"]');
    (element?.querySelector<HTMLElement>('[data-pending-focus]') ?? element)?.focus();
  }, [shown, composerRef]);

  const phase = leaving ? 'out' : swapped ? 'in' : undefined;
  return (
    <div ref={zone}>
      <div className="motion-swap" data-phase={phase}>
        <div hidden={panel !== undefined} inert={panel !== undefined}>
          {composer}
        </div>
        {panel !== undefined && label !== undefined && (
          <Card
            key={panel.interruptId}
            data-slot="pending-panel"
            tabIndex={-1}
            role="region"
            aria-label={label}
            // 邊框光（§5、§7）：等你處理的整圈呼吸；靜態補償在 `styles/theme.css`。
            className="border-beam gap-0 rounded-3xl p-1"
            data-kind="pending"
            data-active="true"
          >
            <div className="text-muted-foreground flex items-center gap-2 px-3 pt-2 pb-2 text-xs">
              <span className="size-1.5 shrink-0 rounded-full bg-(--brand)" aria-hidden />
              <span className="min-w-0 truncate">{label}</span>
            </div>
            {renderPanel(panel)}
          </Card>
        )}
      </div>
    </div>
  );
}
