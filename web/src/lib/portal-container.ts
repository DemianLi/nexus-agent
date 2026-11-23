/**
 * 浮層（對話框、popover、tooltip）掛在哪裡（#2366）。Base UI 的 Portal 預設掛到 `document.body`；嵌入版的 `<nexus-chat>`
 * 在 Shadow DOM 裡，掛到 body 就出了 shadow root、吃不到樣式，所以它在這裡提供 shadow root 裡的一個節點。獨立頁面不提供，
 * 照舊掛到 body。
 *
 * vendor 的 dialog、popover、tooltip 讀這一格（vendor README「本地修改」第 82 條）。
 *
 * @module
 */
import { createContext, useContext } from 'react';

export const PortalContainerContext = createContext<HTMLElement | undefined>(undefined);

/** 浮層要掛的節點；`undefined` 就是 Base UI 的預設（`document.body`）。 */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext);
}
