import type { ViteUserConfig } from 'vitest/config';

/**
 * 所有前端包共享的 Vitest 基础配置。
 * 各包只需通过 mergeConfig 补充 environment / setupFiles / include。
 */
export const sharedTestConfig: ViteUserConfig = {
  test: {
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.d.ts', 'src/generated/**', 'src/**/*.test.{ts,tsx}'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
};
