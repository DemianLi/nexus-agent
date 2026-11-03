declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent;
  export default component;
}

/** 測試頁的 3D 模型給 e2e 讀視角、找設備在畫面上的位置（`ModelView.vue`）；只在測試頁。 */
interface Window {
  __model?: {
    view(): import('./scene').View;
    point(id: string): { x: number; y: number };
  };
}
