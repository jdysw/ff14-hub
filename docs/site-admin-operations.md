# FF14 Hub 全站管理员后台：操作与安全边界

## 进入方式

在 FF14 Hub 的「设置」页面，连续五次点击「我的设置」标题（四秒内）。
这是为了减少普通访客看到不需要的管理员入口，**不是安全控制**。真正的授权由 Cloudflare Worker 的唯一 owner 密码 + TOTP + Bearer 会话核验。

认证通过后才显示独立的「站点管理」页面，包含管理概览、网站设置、国服活动和账号与安全。
登录后的设置页会额外出现「站点管理后台」直达入口；退出并刷新后将隐藏。

## 用户可在线修改、不需重新部署的内容

- 网站显示名称
- 全站公开公告与公告启用状态
- 首页是否允许展示国服活动模块（访客本地个性化设置会继续生效）
- 国服活动：新建、修改、隐藏、恢复，内容同步到日历和 ICS

所有站点展示设置写入 D1 `site_admin_settings`，更新必须携带 expectedRevision，并由数据库触发器写入 `site_admin_settings_audit`。
活动编辑继续使用 `calendar_editor_entries` / `calendar_admin_audit`，不覆盖官方快照。

## 管理员与普通设备隔离

- **网页及 API 不再提供管理员账号创建、初始化或二次绑定接口**，不会接纳任何新的管理员。
- 既有唯一 owner 保留在 `calendar_admin_accounts`。后台安全选项仅允许退出，不提供替换认证因素。
- `/api/v1/admin/login` 只为已激活 owner 签发临时、内存保存的会话。
- `/api/v1/admin/settings` 和 `/api/v1/admin/calendar/items` 的读写都需要有效管理员 Bearer 会话。
- `/api/v1/site` 仅匿名返回经 Zod 白名单校验的公开展示配置，不暴露管理员账号信息。
- 不允许通过后台查看玩家 WebDAV 密钥、私人工作台、设备凭据等。普通用户数据仍按工作空间单独授权。

## 仍必须采用受控部署的变更

数据库结构迁移、应用代码与运行时依赖更新、Cloudflare Secrets、域名与 DNS、D1 绑定、CORS/Origin、安全与认证策略、Worker 定时任务等仍通过工程变更完成。
管理员持有网站展示内容编辑权限，并不代表可以直接读取或修改基础设施密钥。

## 运维说明

- BOOTSTRAP_SECRET 已参与现有密码摘要的 HMAC 与 TOTP seed 的 AES-GCM 密钥派生；**不得随意替换，否则既有管理员可能无法登录**。
- 需要恢复已丢失的管理员认证因素时，不开放临时公开注册 API，应执行离线的经过验证的恢复脚本、备份与人工审计。
- GitHub Actions 保持关闭；Cloudflare 手动测试并部署，不能因仓库合并而跳过测试。
- 注意：Cloudflare Wrangler 部署时可能不继承现有部署 Secret。发布后必须核对并保留 `BOOTSTRAP_SECRET` 绑定，否则管理员登录会失效。
