// ESLint 扁平配置（HUB-005）。
//
// 设计取向：
// - Worker / 前端 / 测试各自使用**精确的**全局变量集合，而不是把 browser+worker+node 混在一起
//   （混在一起会让 `document` 在 Worker 代码里也「合法」，从而掩盖真实错误）。
// - 使用类型感知规则集（recommendedTypeChecked）：这一层的价值在于能发现
//   「未处理的 Promise」「any 泄漏」「不安全的 JSON 解析结果」等问题。
// - 不引入格式化类规则：格式化交给编辑器/Prettier 语义，避免 lint 与格式化互相打架。
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.wrangler/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // projectService 让文件自动归属到最近的 tsconfig，无需手工维护 project 列表。
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 未使用变量交给 TS（noUnusedLocals）与这条规则共同把关；允许 _ 前缀显式忽略。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // 强制显式类型导入：与 tsconfig 的 verbatimModuleSyntax 保持一致。
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // 空接口与空对象类型通常是设计问题。
      '@typescript-eslint/no-empty-object-type': 'error',
      // 允许 `void promise` 这种显式忽略 Promise 的写法（用于事件处理器）。
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
    },
  },

  // Worker 运行在 workerd：只有 Workers 运行时全局变量 + Node 兼容的少量全局。
  {
    files: ['worker/**/*.ts'],
    ignores: ['worker/test/**'],
    languageOptions: {
      globals: { ...globals.worker },
    },
  },

  // 前端运行在浏览器。
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // 测试与构建配置运行在 Node 上（Workers 测试内部仍是 workerd，但用到 Node 侧工具）。
  {
    files: ['**/test/**/*.ts', '**/*.spec.ts', '**/*.config.ts', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.worker },
    },
  },

  // 声明文件与纯 JS 配置文件：关闭类型感知规则
  //（它们不属于任何 tsconfig project，且 declare global 需要命名空间声明合并）。
  {
    files: ['**/*.d.ts', 'eslint.config.js', 'scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-namespace': 'off',
    },
  },

  // Service Worker（HUB-012：apps/web/public/sw.js）是经典脚本，运行在
  // ServiceWorkerGlobalScope 里，且**刻意**不属于 apps/web 的 tsconfig 项目
  // （它必须是可直接发布的静态文件，不经构建）。因此与上面的 *.d.ts / scripts 同款处理：
  // 关闭类型感知规则、给出 Worker/ServiceWorker 全局变量。
  // 注意：这里不放宽任何规则集，只是让 self / caches / clients / fetch 等真实全局可识别。
  {
    files: ['apps/web/public/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.worker, ...globals.serviceworker },
    },
  },
);
