# tests/e2e —— 端到端测试目录（预留）

本目录为规划 4.1 与 HUB-005 要求的 **Playwright 用例预留位置**，阶段 01 尚未启用。

## 为什么现在只预留

阶段 01 的验收只需要「本地同域静态页 + `/api/v1/health` 冒烟」，
这件事由更轻的方式覆盖，且都不依赖浏览器驱动：

| 目标 | 当前实现 |
|---|---|
| API 契约、错误结构、认证边界、D1 约束 | `worker/test/*.spec.ts`（真实 workerd + Miniflare D1） |
| 纯契约与前端客户端逻辑 | `packages/shared/test/*.spec.ts`、`apps/web/test/*.spec.ts` |
| 同域静态页 + health 冒烟 | `scripts/smoke-local.mjs`（`pnpm run smoke:local`） |

Playwright 的价值在阶段 03 之后才会体现（拖拽布局、多断点、PWA、空布局恢复等交互），
现在就引入只会带来浏览器下载与 flake 成本，而不会增加阶段 01 的保障。

## 启用时的约束

1. 测试对象是**本地** `wrangler dev`（同源），不是预览或生产环境。
2. 不得在测试中写入真实凭证；设备 Token 必须在测试内动态生成并只存在于临时 D1。
3. 一旦在此目录加入用例，必须同步在 `.github/workflows/ci.yml` 增加独立的 e2e job，
   且该 job 不得使用 `continue-on-error`。
