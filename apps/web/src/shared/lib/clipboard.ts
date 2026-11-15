/**
 * 把一段字放進剪貼簿。
 *
 * `navigator.clipboard` 只在安全來源有（`https`、`localhost`）。經 SSH 轉 port 連進來是 `localhost`，拿得到；
 * 直接用內網 IP 的 `http` 連進來就沒有，這時退回 `execCommand('copy')`——舊，但在非安全來源上還能用。
 * 兩條都失敗回 `false`，由呼叫端講一聲，不拋。
 *
 * @module
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 權限被拒或分頁不在前景：退回舊路。
  }
  return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  const focused = document.activeElement;
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    // 焦點回到按下去的那顆按鈕，不留在已經拿掉的 textarea 上。
    if (focused instanceof HTMLElement) focused.focus();
  }
}
