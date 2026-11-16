import { LocateFixed } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { PlanScanOutcome } from '@/shared/connection/plan-document';
import { useControl } from '@/shared/right-sidebar/context';
import { TRACE_LOCATE_LOADING_TEXT } from '@/shared/right-sidebar/locate-text';

import { PlanPreviewTab } from './preview-tab';
import { REVIEW_PLAN_ID_PREFIX } from './review-view';

/** 計劃分頁找不到那一份時（還沒載入到那一段對話，或存下來的分頁指到別處）。 */
export const PLAN_TAB_MISSING_TEXT =
  '這份計劃不在目前載入的對話裡。往上捲載入更早的對話，或從計劃卡重新打開。';

/** 計劃分頁那顆「先載到那一輪再定位」的鈕（#1798）。說法同觀測分頁的定位鈕。 */
export const PLAN_TAB_LOCATE_LABEL = '載入那一段對話並在對話裡定位';

/** 旁路掃描還在讀歷史（#1798）。 */
export const PLAN_TAB_SCANNING_TEXT = '正在從更早的對話裡找這份計劃…';

/** 掃描讀取失敗時那一句的開頭，後面接伺服器給的原因。 */
export const PLAN_TAB_READ_FAILED_LEAD = '讀不到這份計劃：';

/** 掃描找到了，但對話裡還沒載到它：全文上方那一句。 */
export const PLAN_TAB_SCANNED_TEXT = '這份計劃在更早的對話裡，還沒載入對話區。';

/** 載完了還是沒有這份計劃（載入失敗、換代被丟掉）。 */
export const PLAN_TAB_STILL_MISSING_TEXT =
  '載完了，這份計劃仍不在載入的對話裡。載入失敗的原因寫在對話區上方「載入更早的對話」旁邊。';

/**
 * 計劃分頁（#654）。那一份不在載入的對話裡時（重新整理後還原的分頁、計劃在更早的輪），另外往前讀歷史找它
 *（#1798，`Conversation.findPlan`），**不動對話窗口**：找到先在這裡顯示全文，旁邊一顆鈕先 `loadThrough` 載到那一頁
 * （同觀測分頁，#1601）、計劃出現在對話裡之後再捲到那張計劃卡。掃完沒有、讀取失敗都只講一句。**「待定位」記在這一層**：載完之後
 * 計劃庫裡有了它，鈕那一格卸掉。知道標題（條目裡有、或掃到了）就記進版面（`noteTitle`，#2014），分頁標籤在定位之前、
 * 重新整理之後都寫得出標題；掃完沒有就清掉，標籤退回「計劃」，跟分頁裡「找不到」那一句（`PLAN_TAB_MISSING_TEXT`）一致。讀取失敗不清：讀不到不代表它不在了。
 */
export function PlanTab({
  id,
  noteTitle,
}: {
  id: string;
  /** 記下或清掉這份計劃的標題（`undefined` 是清掉）。身分要穩定：它在 effect 的依賴裡。 */
  noteTitle: (title: string | undefined) => void;
}) {
  const { api, sources, isMobile } = useControl();
  /** 對話條目裡的那一份：有它才定位得到。 */
  const entriesPlan = sources.plans?.get(id);
  const { findPlan, loadThrough } = sources;
  const [scan, setScan] = useState<PlanScanOutcome | 'scanning' | undefined>(undefined);
  /** 換代（`stale`）時加一，從新的游標重掃。 */
  const [attempt, setAttempt] = useState(0);
  // 沒帶工具呼叫 id 的審核（`review:`）不在日誌裡，掃完整份也找不到，不掃。
  const scannable =
    entriesPlan === undefined && findPlan !== undefined && !id.startsWith(REVIEW_PLAN_ID_PREFIX);
  // 分頁關掉（卸載）、換 thread（`findPlan` 換身分）、計劃自己出現在條目裡（例如往上捲到了）都中止這一次掃描。
  useEffect(() => {
    if (!scannable || findPlan === undefined) return;
    const abort = new AbortController();
    setScan('scanning');
    void findPlan(id, abort.signal).then((outcome) => {
      if (abort.signal.aborted || outcome.kind === 'aborted') return;
      if (outcome.kind === 'stale') {
        setAttempt((n) => n + 1);
        return;
      }
      setScan(outcome);
    });
    return () => abort.abort();
  }, [scannable, findPlan, id, attempt]);
  const found =
    entriesPlan === undefined && scan !== 'scanning' && scan?.kind === 'found' ? scan : undefined;
  const shown = entriesPlan ?? found?.plan;
  const knownTitle = shown?.title;
  const gone = entriesPlan === undefined && scan !== 'scanning' && scan?.kind === 'not-found';
  useEffect(() => {
    if (knownTitle !== undefined) noteTitle(knownTitle);
    else if (gone) noteTitle(undefined);
  }, [knownTitle, gone, noteTitle]);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'settled' | 'missing'>('idle');
  const preview = useRef<HTMLElement>(null);
  const stillMissing = useRef<HTMLParagraphElement>(null);
  const onLocate = useCallback(() => {
    if (loadThrough === undefined || found === undefined || phase === 'loading') return;
    setPhase('loading');
    void loadThrough(found.firstSeq).then(() => setPhase('settled'));
  }, [loadThrough, found, phase]);
  // 載完、畫出來之後才定位：`await` 回來時對話區與計劃庫都還沒重畫。**只看條目裡的那一份**：掃描找到的全文一直都在，拿它判斷的話
  // 載入失敗（原因在 `history.error`）或換代被丟掉（`historyEpoch`）時也會去定位一張不存在的卡。
  //
  // **結果靠焦點交代，不另開 live region**（#1290 只准狀態列掛 `role="status"`）：成功時那顆鈕卸掉、焦點掉到 body，停靠時交給全文
  // （spec §8「只在焦點本來會丟掉時才搬」，讀屏唸計劃標題）；窄螢幕由 `locate` 收抽屜、交給對話裡那一則。仍找不到時焦點交給說明那一句。
  useEffect(() => {
    if (phase === 'missing') {
      stillMissing.current?.focus();
      return;
    }
    if (phase !== 'settled') return;
    if (entriesPlan === undefined) {
      setPhase('missing');
      return;
    }
    setPhase('idle');
    api.locate(`tool-${id}`);
    const active = document.activeElement;
    if (!isMobile && (active === null || active === document.body)) {
      preview.current?.focus({ preventScroll: true });
    }
  }, [phase, entriesPlan, api, id, isMobile]);
  if (shown === undefined) {
    const failed = scan !== 'scanning' && scan?.kind === 'failed' ? scan : undefined;
    return (
      <p
        className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-body"
        data-testid="plan-tab-missing"
      >
        {scan === 'scanning' && scannable
          ? PLAN_TAB_SCANNING_TEXT
          : failed !== undefined
            ? `${PLAN_TAB_READ_FAILED_LEAD}${failed.message}`
            : PLAN_TAB_MISSING_TEXT}
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {found !== undefined && loadThrough !== undefined && (
        <div
          className="flex flex-col items-start gap-2 border-b border-border px-6 py-3"
          data-testid="plan-tab-scanned"
        >
          <p className="text-muted-foreground text-tip">{PLAN_TAB_SCANNED_TEXT}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 lg:min-h-9"
            // 載入中不用 `disabled`：焦點在這顆鈕上，disabled 會把焦點丟掉。
            aria-disabled={phase === 'loading' ? true : undefined}
            data-testid="plan-tab-locate"
            onClick={onLocate}
          >
            <LocateFixed aria-hidden />
            {phase === 'loading' ? TRACE_LOCATE_LOADING_TEXT : PLAN_TAB_LOCATE_LABEL}
          </Button>
          {phase === 'missing' && (
            <p
              ref={stillMissing}
              tabIndex={-1}
              className="text-muted-foreground text-tip"
              data-testid="plan-tab-still-missing"
            >
              {PLAN_TAB_STILL_MISSING_TEXT}
            </p>
          )}
        </div>
      )}
      <PlanPreviewTab ref={preview} plan={shown} />
    </div>
  );
}
