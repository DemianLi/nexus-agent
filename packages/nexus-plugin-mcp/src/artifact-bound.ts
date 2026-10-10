/**
 * 工具結果的 `artifact` 進會話日誌之前先設上限——[#1320](https://github.com/DemianLi/nexus-agent/issues/1320)。
 *
 * ## 實測（2026-10-10，`@langchain/mcp-adapters` 2.0.0，舊協議與新協議兩台夾具結果相同）
 *
 * adapter 把 MCP 結果拆成給模型的 `content` 與不給模型的 `artifact`（`dist/content.js` 的 `convertCallToolResult`）。
 * 量到的是：
 *
 * | 內容 | 進 `content` | 進 `artifact` | 會話日誌 `tool/result` |
 * | --- | --- | --- | --- |
 * | 內嵌二進位／文字資源，要求 3072 KB | 空（資源預設只放 artifact） | 整份原樣（`type: 'resource'`） | **3,146,139 位元組** |
 * | `structuredContent`，要求 1024 KB | 只有 server 附的文字摘要 | 整份原樣（`mcp_structured_content`） | **663,043 位元組** |
 * | 圖片，要求 3072 KB | 換成一句文字說明（#642） | 無（adapter 不把它放 artifact） | 411 位元組 |
 * | `resource_link`（兩條） | `Resource link: …` 文字 | 每條一份小的 `mcp_content` | 860 位元組 |
 *
 * 也就是 `project-content.ts` 先前的說法（「留 artifact，一張圖就是幾 MB，所以不留」）對圖片成立——圖片根本不在 artifact 裡——
 * 但**內嵌資源與 `structuredContent` 會整份進日誌**，`toLoggedMessage` 用 `toDict()` 把 `artifact` 一起帶進 `tool/result`。
 *
 * **上線那一側沒有這個問題**：同一次呼叫，即時串流的 `tool-finished` frame 是 230–253 位元組、整條串流約 9 KB，
 * `GET /threads/:id/history` 約 2.5 KB。`thread-pump.ts` 送給瀏覽器的是抽好的結果文字，不是序列化的 ToolMessage
 * （[#439](https://github.com/DemianLi/nexus-agent/issues/439)），所以 artifact 到不了瀏覽器；卡上「`...rest` 可能原樣轉發」的
 * 推論不成立。受影響的是會話日誌（磁碟與記憶體裡的 `SessionLog`）、LangGraph state 與存檔點。
 *
 * ## 處理：單條 artifact 超過上限就換成占位
 *
 * dsh 的立場（`.agents/notes/archived/feature/2026-07-30-web-result-card.md:18`）：結構值不上線，上線的只有 render 文字與
 * `presentationMeta`。我們對應的是：**原始資料不進日誌**，要留的出處／來源資訊該在 `afterToolCall` 投影成 meta，
 * 不靠日誌裡的 artifact。階段 B（結構化來源卡，[#1318](https://github.com/DemianLi/nexus-agent/issues/1318)）要從
 * `resource_link`／`structuredContent` 取來源，也是在同一個 `afterToolCall` 讀進來的原始 artifact，這一步發生在它之後，
 * 所以不擋 B；小的 `mcp_content`（resource link）本來就遠低於上限，原樣保留。
 *
 * 規則只有一條：**單條序列化後超過 {@link ARTIFACT_ENTRY_MAX_BYTES} 位元組的 artifact，換成
 * `{ type: 'mcp_omitted', originalType, bytes, uri?, mimeType? }`**——留下原型別、原始大小與（有的話）URI 和 MIME，資料拿掉。
 * 占位的 `type` 不能沿用原型別：adapter 在 hook 回傳後會用 `toolArtifactSchema` 驗一次，`type: 'resource'` 必須是完整的
 * 內嵌資源（`resource.uri` 等），占位過不了（實測會拋 `Expected a valid MCP embedded resource`）；其他型別則任意。
 * 以大小而不是型別判斷，因為我們沒辦法預先列舉 server 會塞什麼（`_meta` 也是 server 自訂的）；未超過的原樣保留。
 * 不是 dsh 的做法（dsh 的 `tool/result` 本來就不帶原始值），是退到最接近的實作：adapter 的 `artifact` 欄位表達不出
 * 「只放 meta」，所以在它進日誌前把大的那幾條換掉。
 *
 * @module
 */

/** 單條 artifact 進日誌的位元組上限（序列化後）。小的 resource link、`_meta` 遠低於它；整份資源與結構值遠高於它。 */
export const ARTIFACT_ENTRY_MAX_BYTES = 8 * 1024;

/** 換成占位之後的樣子。 */
export interface OmittedArtifact {
  readonly type: 'mcp_omitted';
  /** 被拿掉的那一條原本的 `type`。 */
  readonly originalType: string;
  /** 原本序列化後的位元組數。 */
  readonly bytes: number;
  readonly uri?: string;
  readonly mimeType?: string;
}

/**
 * 把超過上限的 artifact 換成占位。
 *
 * @param artifacts - adapter 回的 artifact 陣列。
 * @returns 有任何一條被換掉就回新陣列，沒有就回 `undefined`（照原樣）。
 */
export function boundArtifacts<T>(artifacts: readonly T[] | undefined): T[] | undefined {
  if (artifacts === undefined) return undefined;
  let changed = false;
  const bounded = artifacts.map((entry) => {
    const bytes = sizeOf(entry);
    if (bytes <= ARTIFACT_ENTRY_MAX_BYTES) return entry;
    changed = true;
    return omitted(entry, bytes) as T;
  });
  return changed ? bounded : undefined;
}

function sizeOf(entry: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(entry) ?? '');
  } catch {
    // 序列化不了的東西進不了日誌，也沒有意義留著。
    return Number.POSITIVE_INFINITY;
  }
}

function omitted(entry: unknown, bytes: number): OmittedArtifact {
  const record = isRecord(entry) ? entry : {};
  const inner = isRecord(record['resource'])
    ? record['resource']
    : isRecord(record['data'])
      ? record['data']
      : {};
  const uri = inner['uri'];
  const mimeType = inner['mimeType'];
  return {
    type: 'mcp_omitted',
    originalType: typeof record['type'] === 'string' ? record['type'] : 'unknown',
    bytes: Number.isFinite(bytes) ? bytes : -1,
    ...(typeof uri === 'string' && { uri }),
    ...(typeof mimeType === 'string' && { mimeType }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
