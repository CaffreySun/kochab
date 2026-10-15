import js from '@eslint/js';
import jsonc from 'eslint-plugin-jsonc';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

/** 需要类型信息的规则适用的文件（不含工具脚本与生成代码） */
const TYPED_FILES = ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'];

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/target/**',
    'apps/desktop/src-tauri/gen/**',
    'packages/*/src/generated/**',
    'pnpm-lock.yaml',
  ]),

  js.configs.recommended,

  // 仓库根目录的 TS（如 vitest.shared.ts）不属于任何 tsconfig project，
  // 因此只上语法解析，不启用类型感知规则。类型感知规则本身只作用于
  // TYPED_FILES，所以这里不需要（也不能）再铺一层 disableTypeChecked
  // ——它自带的 languageOptions 会把这里的 parser 覆盖掉。
  {
    name: 'ac/root-ts',
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tseslint.parser, sourceType: 'module' },
  },

  ...tseslint.configs.recommendedTypeChecked.map((c) => ({
    ...c,
    files: TYPED_FILES,
  })),
  {
    name: 'ac/typed-project-service',
    files: TYPED_FILES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // scripts/ 是纯 ESM 工具脚本，不参与 TS 工程
  {
    name: 'ac/scripts',
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // 配置文件同样不做类型检查
  {
    name: 'ac/config-files',
    files: ['**/*.config.{js,mjs,ts}', '**/*.d.ts', 'packages/*/src/generated/**'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    name: 'ac/react',
    files: ['**/*.tsx'],
    ...react.configs.flat.recommended,
    settings: { react: { version: 'detect' } },
  },
  {
    name: 'ac/react-runtime',
    files: ['**/*.tsx'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      // 新 JSX 转换（react-jsx）不再需要 React 在作用域内
      'react/react-in-jsx-scope': 'off',
      // props 类型由 TypeScript 保证，prop-types 冗余
      'react/prop-types': 'off',
      'react/jsx-sort-props': [
        'error',
        { ignoreCase: true, callbacksLast: true, shorthandFirst: true, reservedFirst: true },
      ],
      'react/self-closing-comp': 'error',
      'react/no-array-index-key': 'error',
      'react/no-unstable-nested-components': ['error', { allowAsProps: true }],
    },
  },
  // 只用 react-hooks 的两条经典规则。
  //
  // v7 的 `configs.flat.recommended` 还会启用一整套 React Compiler 规则
  // （`set-state-in-effect`、`refs`、`static-components`…）。它们与本项目
  // 的两类正常写法冲突：
  // 1. 组件挂载时在 effect 里发请求、拿到数据后 setState——没有数据层时这是标准写法；
  // 2. TDesign 的 Table/List 用「渲染函数属性」表达单元格，会被判成组件定义。
  // 与其为规则扭曲代码，不如只保留真正能防 bug 的两条。
  {
    name: 'ac/react-hooks',
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  jsonc.configs['flat/recommended-with-jsonc'],
]);
