import { MarkdownText } from '@/components/markdown-text';
import { Reasoning } from '@/components/ui/reasoning';
import { reasoningSummary } from '@/lib/reasoning-view';

/**
 * 一則回覆的推理（[#527](https://github.com/DemianLi/nexus-agent/issues/527)），畫在泡泡上方、跟工具卡分開
 * （同 dsh 的 `ReasoningRow`）。**預設收合**：推理是旁白不是回覆，展開會把工具卡擠出畫面。
 *
 * 轉接層（#1683，地圖 #1497 第 ④ 步）：畫成 SG 的 `Reasoning`（原生 `<details>`／`<summary>`），外觀照 SG（#1468 Q8）。
 *
 * - 收合時一行摘要：串流中是最新一行，講完是第一行（`reasoningSummary`），放在 SG 標題後面的 `trailing`（patch `0021`）。
 *   展開後「·」與摘要藏起來（`group-open/reasoning:hidden`，#1638 驗收 B）。
 * - 內文用正文的 `MarkdownText`（patch `0020` 讓 SG 收節點）。SG 的內文框是 `whitespace-pre-wrap`、會往下繼承，把 markdown 的軟換行
 *   變成硬換行，所以包一層 `whitespace-normal` 擋掉。內文照 SG 一直掛載，收著時也在 DOM 裡（#1683 PM 決定題 1；成本由驗收 E 量）。
 * - **摘要不進可存取名稱**（`aria-hidden`）：它每來一顆 chunk 就變一次，焦點停在 summary 上時報讀器會跟著重唸。名稱是
 *   「思考過程」或「思考中」，展開與否由原生 `<summary>` 報。推理也不進 polite 區唸（狀態列已經唸「執行中」）。
 * - 沒有展開動效，只有箭頭轉（同工具卡，規格 §7）；思考中的字用 SG 的 `.status-shimmer`。
 * - SG 的 `Reasoning` 不轉傳其他屬性，`data-testid` 只能放在外面那層。
 */
export function ReasoningRow({ text, running }: { text: string; running: boolean }) {
  const summary = reasoningSummary(text, running);
  return (
    <div data-testid="reasoning-row">
      <Reasoning
        thinking={running}
        trailing={
          summary !== '' && (
            <>
              <span aria-hidden className="shrink-0 group-open/reasoning:hidden">
                ·
              </span>
              {running ? (
                // 串流中要看到的是最新的字：外層不撐滿、可以縮，太長時 `justify-end` 讓溢出往左邊裁。
                // 不像 dsh 每三幀讀版面改 `scrollLeft`，純 CSS、不讀版面。
                <span
                  aria-hidden
                  data-testid="reasoning-summary"
                  className="flex min-w-0 justify-end overflow-hidden group-open/reasoning:hidden"
                >
                  <span className="shrink-0 whitespace-nowrap">{summary}</span>
                </span>
              ) : (
                <span
                  aria-hidden
                  data-testid="reasoning-summary"
                  className="min-w-0 truncate group-open/reasoning:hidden"
                >
                  {summary}
                </span>
              )}
            </>
          )
        }
      >
        <div className="whitespace-normal">
          <MarkdownText text={text} streaming={running} />
        </div>
      </Reasoning>
    </div>
  );
}
