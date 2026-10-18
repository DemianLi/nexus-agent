import { defineConfig } from 'vitest/config';

import { pathsPlugin } from '../../vitest.shared.ts';

export default defineConfig({
  plugins: [pathsPlugin()],
});
