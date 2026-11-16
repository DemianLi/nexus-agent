/**
 * 右側欄分頁的定義：一種分頁怎麼認身分、怎麼讀回、標籤是什麼、畫什麼。**每個切片登記自己的**（`features/<切片>/sidebar-tab.tsx`），
 * 組裝層把它們列成一張清單（`app/right-sidebar/tabs.ts`），側欄的殼與版面的讀寫都只查清單，不認得任何一種分頁。
 * 加一種分頁是新增一個定義、在清單加一列，殼不動。
 *
 * 「註冊」是建置時加一列，不是執行期載入程式碼（內網、無外部 CDN）。
 *
 * @module
 */

import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

/**
 * 版面裡的一個分頁：殼只認得 `kind`，其餘欄位是那一種分頁自己的座標。**各種分頁的型別要用 `type` 不用 `interface`**：
 * 只有 `type` 才接得進這個索引簽名。
 */
export type SidebarTab = {
  readonly kind: string;
  readonly [field: string]: unknown;
};

/** 沒有座標的分頁：一個會話一份，身分就是種類名（觀測、成本）。 */
export type SingletonTab<K extends string = string> = { readonly kind: K };

/** 分頁內容拿到的東西，由 `app/right-sidebar/right-sidebar.tsx` 的 `TabBody` 給。其餘（資料來源、定位）從 context 取。 */
export interface TabBodyProps<T extends SidebarTab> {
  readonly tab: T;
  /**
   * 現在看得見嗎：右側欄開著、而且是選中的這一個分頁。分頁藏起來時不卸載（保住捲動位置），所以內容要靠它判斷
   * 要不要訂閱資料。
   */
  readonly visible: boolean;
  /** 人在分頁裡做了選擇，把自己換成新的座標（改動換檔）。算人動過，會寫進 `localStorage`。身分（`key`）不能變。 */
  readonly replace: (change: (current: T) => T) => void;
  /**
   * 分頁自己補記的資訊（計劃的標題）。**不算人動過**：已經動過的話隨下一次版面變動一起寫進去，還沒動過就不寫。
   * 沒有變的時候 `change` 要回傳傳進去的同一個參考，版面才不會白畫、白寫。身分（`key`）不能變。
   */
  readonly refine: (change: (current: T) => T) => void;
}

export interface TabDefinition<T extends SidebarTab> {
  readonly kind: T['kind'];
  /** 同一份分頁的身分：同一個鍵只開一個。單例用種類名；有座標的把座標寫進去（`changes:${seq}`）。 */
  key(tab: T): string;
  /**
   * 從 `localStorage` 讀回。`raw` 是個物件、`kind` 已經對上這一種；欄位不對回 `undefined`，整份版面就作廢
   * （`parseLayout`）。只收該收的欄位，多餘的不留。
   */
  parse(raw: Record<string, unknown>): T | undefined;
  /** 分頁標籤的文字與 tooltip。是 hook：改動的標籤要訂閱摘要。 */
  useTitle(tab: T): { label: string; detail: string | undefined };
  readonly Icon: LucideIcon;
  readonly Body: ComponentType<TabBodyProps<T>>;
  /** 空狀態裡的入口鈕（沒有分頁時直接打開）；只有單例面板有，順序照清單。 */
  readonly entry?: { readonly label: string };
}

/** 殼用的型別：座標被擦掉，只剩 `kind`。 */
export type AnyTabDefinition = TabDefinition<SidebarTab>;

/** 把一個分頁定義轉成殼用的型別。不複製，轉出來的就是同一個物件。 */
export function defineTab<T extends SidebarTab>(definition: TabDefinition<T>): AnyTabDefinition {
  return definition as unknown as AnyTabDefinition;
}

/** 單例面板的定義：標籤就是 `title`，鍵就是種類名，空狀態有入口鈕。 */
export function defineSingletonTab<K extends string>({
  kind,
  title,
  Icon,
  Body,
}: {
  readonly kind: K;
  readonly title: string;
  readonly Icon: LucideIcon;
  readonly Body: ComponentType<TabBodyProps<SingletonTab<K>>>;
}): AnyTabDefinition {
  return defineTab<SingletonTab<K>>({
    kind,
    key: () => kind,
    parse: () => ({ kind }),
    useTitle: () => ({ label: title, detail: undefined }),
    Icon,
    Body,
    entry: { label: title },
  });
}

/** 座標用：非負的安全整數。 */
export const isIndex = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export interface TabRegistry {
  readonly definitions: readonly AnyTabDefinition[];
  /** 這個分頁屬於哪一種定義；清單裡沒有的種類是程式錯誤（存下來的版面在 {@link TabRegistry.parse} 就擋掉了）。 */
  definitionOf(tab: SidebarTab): AnyTabDefinition;
  keyOf(tab: SidebarTab): string;
  /** 存下來的一個分頁；不是物件、認不得的 `kind`、欄位不對都是 `undefined`。 */
  parse(raw: unknown): SidebarTab | undefined;
}

/** 種類名不能重複：重複的話後面那一種永遠讀不回來，建置時就擋。 */
export function createTabRegistry(definitions: readonly AnyTabDefinition[]): TabRegistry {
  const byKind = new Map<string, AnyTabDefinition>();
  for (const definition of definitions) {
    if (byKind.has(definition.kind)) throw new Error(`分頁種類重複：${definition.kind}`);
    byKind.set(definition.kind, definition);
  }
  const definitionOf = (tab: SidebarTab): AnyTabDefinition => {
    const definition = byKind.get(tab.kind);
    if (definition === undefined) throw new Error(`沒有登記的分頁種類：${tab.kind}`);
    return definition;
  };
  return {
    definitions,
    definitionOf,
    keyOf: (tab) => definitionOf(tab).key(tab),
    parse: (raw) => {
      if (typeof raw !== 'object' || raw === null) return undefined;
      const record = raw as Record<string, unknown>;
      const kind = record.kind;
      return typeof kind === 'string' ? byKind.get(kind)?.parse(record) : undefined;
    },
  };
}
