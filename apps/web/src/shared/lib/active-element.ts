/**
 * 焦點在哪個元素上，從 `node` 所在的那棵樹看（#2366）。嵌入版的 `<nexus-chat>` 在 Shadow DOM 裡，焦點在 shadow root 裡面時
 * `document.activeElement` 是宿主元素本身，判斷「焦點掉了沒、在不在這一區」要問 shadow root。
 *
 * 焦點不在這個 shadow root 裡時退回 `document.activeElement`：落在宿主頁的欄位上就是那個欄位（不搶），什麼都沒聚焦就是 body，
 * 跟獨立頁面一樣算掉了。
 *
 * @module
 */

export function activeElementOf(node: Node | null | undefined): Element | null {
  const root = node?.getRootNode();
  if (root instanceof ShadowRoot) return root.activeElement ?? document.activeElement;
  return document.activeElement;
}
