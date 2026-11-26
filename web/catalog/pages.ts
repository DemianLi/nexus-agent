/**
 * 元件目錄左欄的分組與中文頁名。鍵是 `guard/main.tsx` 的子頁名（`main` 是總覽）。
 * 測試頁加了子頁要在這裡加一列，`src/components/ui/components-doc.test.ts` 會擋漏掉的與多出來的。
 */
export const MAIN = 'main';

export interface CatalogGroup {
  label: string;
  pages: readonly (readonly [name: string, label: string])[];
}

export const CATALOG_GROUPS: readonly CatalogGroup[] = [
  { label: '總覽', pages: [[MAIN, '總覽']] },
  {
    label: '基礎元件',
    pages: [
      ['buttons', '按鈕'],
      ['primitives', '分隔線、骨架與通知'],
      ['fields', '輸入欄位的狀態'],
      ['collapsibles', '展開收合'],
    ],
  },
  {
    label: '浮層',
    pages: [
      ['dialog', '對話框'],
      ['alert-dialog', '確認框'],
      ['sheet', '側邊抽屜'],
      ['feedback', '回饋框'],
      ['dropdown', '下拉選單'],
      ['dropdown-keyboard', '下拉選單（關著）'],
      ['command', '指令清單'],
    ],
  },
  {
    label: '側欄',
    pages: [
      ['desktop-sidebar', '左側欄（桌面）'],
      ['mobile-sidebar', '左側欄（手機）'],
      ['thread-statuses', '會話狀態'],
      ['right-empty', '右側欄（沒有分頁）'],
      ['cost', '成本分頁'],
    ],
  },
  {
    label: '對話',
    pages: [
      ['messages', '對話區'],
      ['transcript-rows', '重試、往前翻與空白畫面'],
      ['transcript-refs', '會話引用與標記'],
      ['attachments', '附件'],
      ['reasoning', '推理列'],
      ['turn-status', '狀態列'],
    ],
  },
  {
    label: '工具',
    pages: [
      ['tool-steps', '工具步驟'],
      ['tool-cards', '工具卡'],
      ['stage-surfaces', 'stage 上的面'],
      ['diff-stats', '增刪行數'],
      ['diff-view', '差異檢視'],
    ],
  },
  {
    label: '核准、提問與計劃',
    pages: [
      ['handoff', '核准與換手'],
      ['questionnaire', '提問面板'],
      ['plan', '計劃與目標'],
    ],
  },
  {
    label: '觀測分頁',
    pages: [
      ['trace-heads', '一輪的標頭'],
      ['trace-empty', '空狀態'],
      ['trace-plan', '計劃那一列'],
      ['trace-digests', '更早的摘要'],
      ['trace-groups', '只有摘要的組'],
      ['trace-subagent', '子代理的呼叫結構'],
      ['trace-steps', '一輪裡的各種列'],
    ],
  },
  {
    label: '輸入框',
    pages: [
      ['composer-idle', '閒著'],
      ['composer-draft', '有草稿'],
      ['composer-running', '跑著'],
      ['composer-running-draft', '跑著有草稿'],
      ['composer-menu', '「/」選單開著'],
      ['composer-danger', '權限全開'],
      ['composer-locked', '權限鎖住'],
      ['composer-pick-open', '模型清單開著'],
      ['composer-tones', '用量環的三個色階'],
      ['composer-dormant', '用量環的門檻'],
    ],
  },
];
