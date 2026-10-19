# GitHub Actions 自动部署

仓库：`jdysw/ff14-hub`。正式站 `https://ff14.zhixia.uk`，预览站 `https://ff14-preview.zhixia.uk`。

## 触发与边界

`.github/workflows/ci.yml` 的三个 CI 矩阵检查全部成功后，只有本仓库 `main` 的 push 或手动运行才进入 production 部署。部署 checkout 同一份 `github.sha`，发布前再检查它仍是最新 main；过时运行跳过发布。PR、fork、其他分支只检查，不注入部署密钥。main 运行不主动取消正在进行的远程迁移；部署任务另有生产串行锁。

步骤：冻结安装 → 发布配置预检 → 构建前端 → 确认 main 提交 → D1 正式库迁移 → Wrangler production 上传 → 有界重试公开 HTTPS 健康与静态资产哈希检查。所有现有测试链仍保留。失败使流水线失败，不隐藏错误。

日常只需合并通过检查的 PR 到 main。需要重部署时，从 GitHub Actions 的 CI 页面选择 Run workflow，分支选 main；仍会先跑完整检查。此流程只自动部署 production；预览仍显式执行 `pnpm exec wrangler deploy --env preview`，不会把任意 PR 代码交给有密钥的 runner。

## Secrets

在仓库 Settings → Secrets and variables → Actions 配置：

- `CLOUDFLARE_API_TOKEN`：专门为本仓库创建的 Token；不复用广泛管理 Token，不提供令牌管理权限。
- `CLOUDFLARE_ACCOUNT_ID`：当前部署账号 ID（与 Wrangler 配置一致）。

Token 权限：指定账号的 Workers Scripts Edit、D1 Edit、Account Settings Read；指定区域 zhixia.uk 的 Workers Routes Edit 与 Zone Read。权限中的 Edit 可写对应资源，不是只读；传统账号级 Workers/D1 权限不能假称为仅限这两个应用。不给 DNS Edit、Pages、KV、账单、API Token 管理权限。GitHub 托管 runner 的出口 IP 会变化，未设置固定 IP 白名单；轮换或撤销在 Cloudflare 控制台完成。

Cloudflare 的 `BOOTSTRAP_SECRET` 等应用 Secrets 已在 Worker 配置，GitHub 无需持有这些值。自动部署不初始化身份、不读取 owner 文件、不更改私有模块状态、不运行需本机凭证的 alpha-smoke。

## 验证与维护

部署后 `scripts/ops/verify-live.mjs production` 无需私有凭证，验证数据库/环境、安全头和线上 JS/CSS 与当前构建的哈希。最多 5 次，每次网络请求超时 15 秒，间隔 5 秒；它不会忽略 TLS 错误、跳转到其他主机或输出凭证。失败后查看 Actions，再定位网络、权限、迁移或发布错误。

Token 轮换：创建同范围新 Token，更新 GitHub Secret，成功重跑 CI/部署后撤销旧 Token。不要把 Token 粘贴到聊天、Issue、workflow YAML 或命令参数中。可通过 `gh secret set CLOUDFLARE_API_TOKEN --repo jdysw/ff14-hub` 的交互输入保存；仓库列表只能验证 Secret 名称和更新时间，不能取回原值。

回退：优先用 revert PR 回滚代码并经完整 CI 重新部署。紧急情况下可按维护手册执行 Wrangler 的版本回退，但它不会逆转 D1 schema；迁移必须兼容前一版本，涉及删除/重写数据的变更需另外安排备份和发布步骤。此仓库当前套餐不能依赖 GitHub 私有仓库的受保护分支/环境审批能力，准入门槛由 workflow 条件和 CI needs 保证。
