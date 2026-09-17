import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/App';
import '@/index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('找不到 #root 掛載點');
}

// PROTOTYPE #375：`?prototype=375`（或建置時 VITE_PROTOTYPE=375）改掛原型，真的 App 不掛，
// 免得它去連不存在的 harness。丟棄分支專用。
if (
  new URLSearchParams(window.location.search).get('prototype') === '375' ||
  import.meta.env.VITE_PROTOTYPE === '375'
) {
  void import('@/prototype-375/prototype-app').then(({ PrototypeApp }) => {
    createRoot(root).render(
      <StrictMode>
        <PrototypeApp />
      </StrictMode>,
    );
  });
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
