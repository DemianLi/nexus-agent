/**
 * 把一個被拋出的值連同它的 `cause` 鏈與 `AggregateError` 成員一起轉成一行字
 * （[#1511](https://github.com/DemianLi/nexus-agent/issues/1511)）。
 *
 * 照 dsh 的 `errorChain`（`packages/llm/llm/src/error.ts:117`，`1517a4db`）：給**診斷用的訊息**（通知、日誌、關機時印的那一行）用，
 * 不拿來解析——要路由請看錯誤碼。為什麼需要：serve 關機、閒置逐出的 `report`、CLI 印錯用的都只有 `error.message`，
 * 所以聚合錯誤要把每一份的原因嵌進自己的 message，否則「哪一份會話、為什麼失敗」在 `String(error)` 底下就不見了。
 *
 * @module
 */

/**
 * 渲染一個被拋出的值。
 *
 * 最外層的訊息在前，每一層 `cause` 用 `: ` 接在後面（跟外層訊息逐字相同的不重複），
 * `AggregateError` 的成員用 `[…; …]` 包起來。環狀的 cause 只寫 `<circular cause>`，菱形共用的 cause 照常寫全。
 * 任何一個節點的存取子拋錯都只讓那個節點變成 `<unrenderable value>`，整條鏈不會因此拋出（這支函式餵的是日誌與通知）。
 *
 * @param value - catch 到的值（`unknown`）。
 * @returns 一行診斷文字。
 */
export function errorChain(value: unknown): string {
  // 只記目前遞迴路徑（離開時移除），所以只有真的環才會被標出來。
  const path = new Set<unknown>();
  const render = (current: unknown): string => {
    if (path.has(current)) return '<circular cause>';
    path.add(current);
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(current, 'message');
          if (
            descriptor !== undefined &&
            'value' in descriptor &&
            typeof descriptor.value === 'string'
          ) {
            return descriptor.value;
          }
        }
        return String(current);
      }
      const message = current.message === '' ? current.name : current.message;
      const members =
        current instanceof AggregateError && current.errors.length > 0
          ? ` [${current.errors.map(render).join('; ')}]`
          : '';
      const causeText =
        current.cause === undefined || current.cause === null ? '' : render(current.cause);
      // `new Error(String(value), { cause: value })` 這種包法會逐字重複 cause，再寫一次只是雜訊。
      const cause = causeText === '' || causeText === message ? '' : `: ${causeText}`;
      return `${message}${members}${cause}`;
    } catch {
      // 只有惡意的 toString／getter 會走到這裡：這支函式餵日誌與通知，不能讓任何東西逃出去。
      // 內層各自接住自己的拋出，所以只有那個節點塌掉。
      return '<unrenderable value>';
    } finally {
      path.delete(current);
    }
  };
  return render(value);
}
