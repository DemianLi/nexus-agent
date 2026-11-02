/**
 * 整頁拖放（#733）：檔案拖進視窗時回報「正在拖」，放開時把檔案交出去。
 *
 * - **只認檔案**（`dragHasFiles`）：拖文字、連結進來不出提示、也不吞事件，輸入框照舊收文字。
 * - `dragenter`／`dragleave` 會在每個子元素的邊界各觸發一次，所以用計數（進一次加一、離開減一、歸零才算離開視窗）。
 * - **`enabled` 為假時什麼都不掛**：伺服器不收附件時，拖進來的檔案維持瀏覽器自己的行為。
 */

import { useEffect, useRef, useState } from 'react';

import { dragHasFiles } from '@/lib/file-drag';

export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const latest = useRef(onFiles);
  latest.current = onFiles;

  useEffect(() => {
    if (!enabled) return;
    const carriesFiles = (event: DragEvent) => dragHasFiles(event.dataTransfer?.types);
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // 不取消 dragover，瀏覽器就不會讓 drop 發生。
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      latest.current(Array.from(event.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      depth.current = 0;
      setDragging(false);
    };
  }, [enabled]);

  return enabled && dragging;
}
