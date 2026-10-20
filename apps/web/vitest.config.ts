import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** Pure logic runs in Node; component suites opt into jsdom explicitly. */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['test/**/*.spec.{ts,tsx}'],
    passWithNoTests: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
