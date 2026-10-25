# 部署

正式站：[ff14.zhixia.uk](https://ff14.zhixia.uk/)。预览站：[ff14-preview.zhixia.uk](https://ff14-preview.zhixia.uk/)。

当前使用 **Cloudflare Workers Builds**；仓库没有 GitHub Actions 工作流。合并或推送到 `main` 会触发已配置的主线构建，分支构建用于预览。构建命令、仓库连接和构建凭证在 Cloudflare 控制台维护，不由仓库中的 Action 配置提供。

## 发布前

1. 完成 [验证清单](manual-release-verification.md)，核对实际待发布 SHA。
2. 涉及迁移时，备份目标 D1，先在 preview 验证待应用迁移。构建成功不表示数据库迁移已完成。
3. 分别核对 preview/production 的 D1 绑定、域名、环境变量和 Secrets。`wrangler.jsonc` 声明环境；不要让分支预览连接生产库。

生产发布脚本只允许 `WORKERS_CI=1` 且 `WORKERS_CI_BRANCH=main` 的 Workers Builds，或经过明确授权的人工发布。人工发布要求干净的本地 `main` checkout，并设置 `FF14_MANUAL_RELEASE_APPROVAL=ff14-hub-production` 后运行 `pnpm run release:production`。

`release-worker.mjs` 上传版本时保留变量，确认版本 ID 后切换流量，再验证线上资源。`pnpm run release:preview` 使用独立预览环境。`pnpm run build` 和 `verify:release` 都是构建/干跑，不发布。

## 发布后

```sh
node scripts/ops/verify-live.mjs production
```

核对健康检查、环境、安全响应头和当前构建的 JS/CSS 哈希。自定义域名若返回明确的 Cloudflare 浏览器挑战，脚本可以检查固定的同一 Worker 备用域名，但会报告 `customDomainVerified:false`；这不表示主域名已验证。

同时检查 GitHub 上该 SHA 的 Cloudflare 构建结论。Sonar 通过不代表单测或 Android 构建通过。

回退见 [运维手册](operations-runbook.md)。Worker 版本回退不会逆转 D1 迁移。
