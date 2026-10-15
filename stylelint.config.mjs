import stylelintConfigStandard from 'stylelint-config-standard';

/** @type {import('stylelint').Config} */
export default {
  extends: [stylelintConfigStandard],
  rules: {
    // 设计令牌统一使用 CSS 自定义属性，避免硬编码颜色
    'declaration-property-value-no-unknown': true,
    'custom-property-pattern': [
      '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
      { message: '自定义属性必须使用 kebab-case' },
    ],
    'selector-class-pattern': [
      '^ac-[a-z0-9]+(-[a-z0-9]+)*(__[a-z0-9]+(-[a-z0-9]+)*)?(--[a-z0-9]+(-[a-z0-9]+)*)?$',
      { message: '类名必须使用 ac- 前缀的 BEM 写法（元素用 __，修饰符用 --）' },
    ],
    // Vite / bundler 解析 CSS import，不使用 url() 包裹
    'import-notation': null,
    // 设计令牌按语义分组，保留空行以提高可读性
    'custom-property-empty-line-before': null,
    'no-descending-specificity': null,
    'media-feature-range-notation': 'prefix',
  },
  ignoreFiles: [
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/target/**',
    'apps/desktop/src-tauri/gen/**',
  ],
};
