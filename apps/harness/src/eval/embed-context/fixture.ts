/**
 * 畫面情境量測的題目（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)，地圖 #2365 第 8 點）。只定義**輸入**：畫面上選了什麼、
 * 使用者問什麼、期望的對象。判準在 [`rubric.ts`](./rubric.ts)。
 *
 * 四類各三題，選取的東西都是設備編號加名稱，判分只認編號（模型轉述名稱時常換字，編號不會）：
 *
 * | 類 | 問句 | 期望 |
 * | --- | --- | --- |
 * | `named` 有指名 | 自己點名了另一台 | 講問句點名的那台，不拿選取的 |
 * | `ambiguous` 指代不明 | 「這台」「它」 | 第一句寫出選取的那台 |
 * | `unrelated` 跟畫面無關 | 跟設備無關 | 不提選取的 |
 * | `unclear` 補了仍不明 | 「這台」，選取的是一群 | 反問是哪一台 |
 */

export type Category = 'named' | 'ambiguous' | 'unrelated' | 'unclear';

export const CATEGORIES: readonly Category[] = ['named', 'ambiguous', 'unrelated', 'unclear'];

export interface Question {
  readonly id: string;
  readonly category: Category;
  /** 宿主頁送的 `context.label`。 */
  readonly selected: string;
  /** 選取那一台的編號；選的是一群時是那一群裡的每一台。 */
  readonly selectedIds: readonly string[];
  readonly text: string;
  /** 問句點名的那台（`named`）。 */
  readonly targetId?: string;
}

export const QUESTIONS: readonly Question[] = [
  {
    id: 'n1',
    category: 'named',
    selected: 'P-101 冷卻水泵',
    selectedIds: ['P-101'],
    text: 'P-204 進料泵的額定揚程通常要去哪裡查？',
    targetId: 'P-204',
  },
  {
    id: 'n2',
    category: 'named',
    selected: 'AHU-3 空調箱',
    selectedIds: ['AHU-3'],
    text: 'CH-1 冰水主機一般多久要清洗一次冷凝器？',
    targetId: 'CH-1',
  },
  {
    id: 'n3',
    category: 'named',
    selected: 'T-12 儲槽',
    selectedIds: ['T-12'],
    text: '請說明 V-7 安全閥的定期檢查重點。',
    targetId: 'V-7',
  },
  {
    id: 'a1',
    category: 'ambiguous',
    selected: 'P-101 冷卻水泵',
    selectedIds: ['P-101'],
    text: '這台的軸承大概多久要換一次？',
  },
  {
    id: 'a2',
    category: 'ambiguous',
    selected: 'AHU-3 空調箱',
    selectedIds: ['AHU-3'],
    text: '它的濾網堵塞會有什麼徵兆？',
  },
  {
    id: 'a3',
    category: 'ambiguous',
    selected: 'V-7 安全閥',
    selectedIds: ['V-7'],
    text: '這個要怎麼做定期檢查？',
  },
  {
    id: 'u1',
    category: 'unrelated',
    selected: 'P-101 冷卻水泵',
    selectedIds: ['P-101'],
    text: '請假一般要提前幾天申請比較好？',
  },
  {
    id: 'u2',
    category: 'unrelated',
    selected: 'CH-1 冰水主機',
    selectedIds: ['CH-1'],
    text: '幫我把「會議改到週四下午」寫成一句禮貌的通知。',
  },
  {
    id: 'u3',
    category: 'unrelated',
    selected: 'T-12 儲槽',
    selectedIds: ['T-12'],
    text: 'Excel 怎麼把兩欄合併成一欄？',
  },
  {
    id: 's1',
    category: 'unclear',
    selected: 'B 棟 3 樓（P-301、P-302、AHU-5 共 3 台）',
    selectedIds: ['P-301', 'P-302', 'AHU-5'],
    text: '這台現在的運轉狀態正常嗎？',
  },
  {
    id: 's2',
    category: 'unclear',
    selected: '2 號產線（P-201、P-202、P-203）',
    selectedIds: ['P-201', 'P-202', 'P-203'],
    text: '它上次保養是什麼時候？',
  },
  {
    id: 's3',
    category: 'unclear',
    selected: '冷卻系統（CT-1、CT-2 兩座冷卻塔）',
    selectedIds: ['CT-1', 'CT-2'],
    text: '這台的風扇馬達是幾匹的？',
  },
];
