import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/App';
import '@/index.css';
import { applyTheme, readThemePreference } from '@/lib/theme';

// `index.html` 的內嵌腳本已經在第一次繪製前套過；這裡用同一份規則再套一次，之後的變化由 `useThemePreference` 接手。
applyTheme(readThemePreference());

const root = document.getElementById('root');
if (!root) {
  throw new Error('找不到 #root 掛載點');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
