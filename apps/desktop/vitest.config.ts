import react from '@vitejs/plugin-react';
import { defineConfig, mergeConfig } from 'vitest/config';
import { sharedTestConfig } from '../../vitest.shared.ts';
import { workspaceAliases } from './vite.aliases.ts';

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    plugins: [react()],
    resolve: {
      alias: workspaceAliases,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./vitest.setup.ts'],
    },
  }),
);
