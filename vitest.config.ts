import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: 'node',
    projects: [
      { extends: true, test: { name: 'legacy', include: ['tests/**/*.test.{ts,tsx}'], exclude: ['tests/e2e/**'] } },
    ],
  },
});
