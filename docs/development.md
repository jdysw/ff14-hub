# 本地开发

需要 Node.js >= 22.12.0，pnpm 版本以根目录 `package.json` 为准。

```sh
pnpm install --frozen-lockfile
pnpm run build:web
pnpm run db:migrate:local
pnpm run dev:api
```

`dev:api` 启动本地 Worker 与静态资源，默认地址为 `http://localhost:8787`。本地 D1 与远程数据库隔离；空库需要另外准备鱼类目录，见 [数据库说明](d1-single-baseline.md)。

只开发前端时运行 `pnpm run dev`，使用 Vite 热更新。需要真实 API、管理员或端到端联调时使用同源 Worker。

本地配置参考 `.dev.vars.example`，实际值写入忽略的 `.dev.vars`。不要复制生产密钥用于日常开发，也不要提交凭证。

## 代码入口

- 网页：`apps/web/src/main.tsx` → `app/App.tsx` → `local/LocalApp.tsx`。
- API：`worker/index.ts` → `worker/app.ts` → `worker/api/v1/`。
- 公共契约和计算：`packages/shared`、`packages/fish-engine`；鱼糕格式处理：`packages/fish-sync`。
- 定时投递：`worker/scheduled/index.ts`；个人数据：`apps/web/src/app/local/store.ts`。
- 钓鱼看板通过 `fish/data.ts` 的目录读取、进度读取/保存方法访问本机数据，不经过通用模块操作分发。
- shared 仅维护现行公共 API、数据校验和纯函数；旧工作空间导航分组、导入恢复及个人活动协议已经退役。
- Android：`apps/android`，使用独立 Gradle 门禁。

运行 `pnpm run verify` 检查网页、Worker、共享包、生成物和构建；原生 Android 及真实浏览器另外验证，见 [验证清单](manual-release-verification.md)。
