/**
 * 人的泡泡裡的 `@` 會話引用（[#713](https://github.com/DemianLi/nexus-agent/issues/713) Q3）：照 #1695 X6-C 畫成連結樣式的 `@標題`。
 *
 * - 文字裡的 `@標題` 是伺服器換好的，`references` 說每一段對應哪條會話（`referenceSegments`）。
 * - **能點的只有清單上有的會話**（同專案的主會話）：點了切過去。別的專案、子代理只顯示：serve 綁在一個工作目錄上，
 *   今天切不過去。判斷由外面用 {@link SessionReferenceContext} 給，這裡不查清單。
 * - 可見文字就是 `@標題` 本身，複製、搜尋都跟純文字一樣。
 * - **能不能點要不靠 hover 也看得出來**（手機沒有 hover）：能點的一直帶 brand 色底線，不能點的只是粗一點的字。字維持
 *   泡泡的字色：brand 當字色在亮色泡泡上對比不到 4.5，所以 brand 只上在底線。
 */

import { createContext, useContext } from 'react';
import type { WireSessionReference } from '@nexus/wire';

import { referenceSegments } from '@/lib/session-mention';

export interface SessionReferenceLinks {
  /** 這條會話切得過去嗎。 */
  readonly openable: (sessionId: string) => boolean;
  readonly open: (sessionId: string) => void;
}

/** 沒有提供者（例如單獨畫 Transcript 的測試）就一律只顯示。 */
export const SessionReferenceContext = createContext<SessionReferenceLinks | null>(null);

const LINK =
  'inline cursor-pointer underline decoration-brand decoration-2 underline-offset-3 [overflow-wrap:anywhere]';
const PLAIN = 'font-medium [overflow-wrap:anywhere]';

/** 一段人話：引用畫成連結或粗字，其餘照原文（`whitespace-pre-wrap` 由外殼負責）。 */
export function ReferencedText({
  text,
  references,
}: {
  readonly text: string;
  readonly references?: readonly WireSessionReference[] | undefined;
}) {
  const links = useContext(SessionReferenceContext);
  const segments = referenceSegments(text, references);
  if (segments.length === 1 && segments[0]?.kind === 'text') return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') return <span key={index}>{segment.text}</span>;
        const { sessionId } = segment.reference;
        if (links?.openable(sessionId) === true) {
          return (
            <button
              key={index}
              type="button"
              data-session-reference={sessionId}
              className={LINK}
              title="切到這條會話"
              onClick={() => links.open(sessionId)}
            >
              {segment.text}
            </button>
          );
        }
        return (
          <span key={index} data-session-reference={sessionId} className={PLAIN}>
            {segment.text}
          </span>
        );
      })}
    </>
  );
}
