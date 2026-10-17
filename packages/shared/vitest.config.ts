import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // shared 是纯契约层，只在 Node 运行时测试，不需要 Workers 池。
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // 不允许"没有测试也算通过"：契约层必须有真实断言。
    passWithNoTests: false,
  },
});
