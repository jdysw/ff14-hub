# FF14 Hub 公开前安全与历史记录审计（2026-10-24）

> 状态：**有条件、不批准立即转公开**。本报告只审计公开风险，不代替渗透测试、全量历史密钥扫描、云端 Secrets 检查或法律意见。审计基线：`main` 的 `6bab17bee26ce425e07917e3ed175c290edc3e5f`。任何新的提交须重新检查。

## 1. 范围与方法

- 使用仓库读取权限检查 `main` 当前 Git 树（438 个 blob）、根目录、`.gitignore`、`wrangler.jsonc`、`.dev.vars.example`、`package.json`、`THIRD_PARTY_NOTICES.md`、认证与通知模块及运维文件。
- GitHub API 返回主分支 **66 条提交**；逐条查看这些提交的文件补丁，识别 PEM 私钥头、常见 GitHub/npm/支付服务 Token 前缀、AWS AKIA 标识及长秘密变量赋值。此检查不是 Git 整库、二进制文件、所有历史 blob 或熵分析工具扫描；大型差异的 `patch` 可能不完整。
- 查询现存分支：当时只有 `main`；打开的 PR 为 0。历史 PR 的未引用对象、曾存在的其他引用和非默认分支提交未证明已覆盖。
- 查看 2026-10-19 的 Actions Run `39254848761` 三个任务日志（core/product/privacy），筛查典型 Token、PEM 头及未脱敏秘密赋值。该运行无存留 artifacts；**其余历史 Actions 运行/日志/制品未逐一检查**。
- 静态检查 `worker/modules/events/calendar-admin-auth.ts`、`worker/api/v1/admin.ts`、`worker/modules/reminders/notification-channel.ts`、`worker/env.ts` 和前端 DAV/S3 传输逻辑。未连接生产 D1、读取 Cloudflare Secrets、重置密钥或主动测试生产服务。

## 2. 已证实的发现

| 编号 | 结论 | 风险 | 证据与说明 |
| --- | --- | --- | --- |
| SEC-01 | 主分支历史补丁中**未识别出高置信度的典型密钥格式** | 已检查范围内未发现；不可视作全历史无泄露证明 | 66 条主分支提交的差异匹配；有测试字符串/变量赋值误报，未复现真实生产凭证 |
| SEC-02 | 代表性 CI 日志中密钥字段被遮蔽 | 仍须全量检查 | Run `39254848761` 的 3 个任务；`BOOTSTRAP_SECRET` 标记 `(hidden)`、GitHub token 标记 `***`；未发现典型明文密钥模式 |
| SEC-03 | 项目具备初步合理的凭证分隔措施 | 需生产实测 | `.gitignore` 排除 `.dev.vars`、`.env*`、私钥；历史指定敏感路径无记录，示例文件仅含占位符 |
| SEC-04 | 公开仓库会暴露生产基础设施标识及操作路径 | 信息披露，非等同密钥泄露 | `wrangler.jsonc` 中存在 Cloudflare account ID、预览/生产 D1 database ID 和域名；运维文档描述后台入口。登录仍依靠服务端鉴权，不应依赖入口隐藏 |
| SEC-05 | 管理员认证设计具备基本防护，但未完成黑盒审计 | 发布前需复核 | 随机盐 + PBKDF2-SHA256 100k + 服务端 HMAC pepper；TOTP AES-GCM；防重放步进；Bearer 会话数据库存摘要，8 小时过期；`admin:login` 全局 5 分钟 30 次限流，需评估滥用导致的站长登录可用性影响 |
| SEC-06 | `BOOTSTRAP_SECRET` 是多用途主密钥材料 | 高影响运维约束 | 密码 pepper、TOTP 解密和通知凭据派生都依赖该部署密钥。**禁止为公开而盲目替换**：应有备份、恢复与密文迁移方案后才轮换 |
| SEC-07 | 现行 Actions CI 已删除 | 质量流程缺口，非泄密证据 | 2026-10-19 的 `ee15582` 删除 `.github/workflows/ci.yml`；发布前验证依赖手动流程和 Cloudflare Workers Builds，不能将 Sonar 检查误认为单测通过 |

GitHub 官方明确：私有仓库转公开后源码、提交历史、Actions 历史与日志可被他人读取，且任何人可 fork。见 [GitHub visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)。

## 3. 阻断与整改

### P0：转公开前必须完成

1. **数据/版权许可**：参见同分支 `docs/public-release-licensing-plan-2026-10-24.md`。对鱼糕观测数据、无许可证的国服数据挖掘源及衍生快照做权利确认；没有确认的第三方实质性数据不能通过添加 MIT 许可证获得再分发权。
2. **全部可公开对象密钥扫描**：在授权的完整 Git 克隆上使用 Gitleaks/TruffleHog 检查 `--all` / 所有 refs、历史 blob、提交信息、LFS 文件；并逐个核对历史 Actions 运行日志与 artifacts。当前仅完成 66 条主分支提交补丁模式扫描与一次历史 Run 的日志样本。
3. **生产环境核验**：仅通过云端 Secrets 名称/存在性校验，确认没有秘密置于明文 `vars`、日志或公开 API；对管理员、通知与存储的鉴权及输出实施授权范围内的安全回归，不读取、打印或传送真实秘密。
4. **权利范围与许可证确认**：经代码版权持有人批准后才能加入根目录许可证；不能默认为第三方数据、游戏素材或历史代码提供新的许可证。
5. **历史清理策略**：若曾提交未经授权资料或真实密钥，普通删除文件并不擦除 Git 历史。应先保留私有审计备份，考虑经审核的 clean-history 公共仓库／历史改写，并依法轮换已泄露密钥；不要直接把现存历史转为公开。

### P1：建议同批完成

- 以公开可复用的 `.example` / 环境注入代替不必要的硬编码 Cloudflare account ID、生产 D1 ID；标识本身不是登录凭证。
- 把管理员初始配置、TOTP 恢复、通知加密密钥恢复作为发布演练项目；登录限流增加可用性与异常访问场景测试。
- 在 README 明确项目非 Square Enix 官方产品、游戏素材权利归属与许可边界；保留所有 `third_party/*-LICENSE` 原始版权声明。
- 为公开后的外部 PR 配置最小权限与不访问生产 secrets 的验证，避免 fork PR 接触部署凭证。

## 4. 放行条件（全部满足前仓库保持 private）

- [ ] 所有拟保留的第三方数据已取得并存档授权依据；未授权的部分不在准备公开的任何可达历史对象中。
- [ ] 所有 refs、可达 Git 对象、历史 Actions 日志和制品完成凭证扫描；命中项已由有权限者确认/轮换。
- [ ] Cloudflare 生产 Secrets、管理员认证路径和公开 API 已完成受控核验；不输出秘密值。
- [ ] 代码著作权人确认许可证文本与分发范围；独立记录游戏/数据授权限制。
- [ ] 运行 `pnpm run verify:release`，按 `docs/manual-release-verification.md` 执行浏览器与 Android 必要测试，记录结果。
- [ ] 复核 SonarQube Cloud 运行错误及可见性设置，不以放松 Quality Gate 当作修复。

## 5. 审计限制与当前结论

本次完成了仓库配置、关键鉴权代码、主分支 66 个提交的补丁级关键词扫描，以及历史 CI 日志抽样，**没有发现可确认的生产密钥泄漏**。由于历史全对象扫描与全量 Actions 日志未完成，不能断言“绝对无泄漏”。同时第三方数据授权尚缺，**当前不应把此仓库直接转公开**。

审计仅提交文档，不修改运行代码、密钥、生产服务、Git 历史或仓库可见性。
