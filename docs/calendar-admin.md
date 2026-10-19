# FF14 Hub 国服活动管理员启用与权限说明

## 权限模型

国服活动中心默认匿名可读。写权限由数据库表 `site_admin_devices` 显式授予设备 ID；只有通过既有设备 Bearer Token 且设备未撤销，并且在白名单中的设备才能调用 `/api/v1/admin/calendar/*`。本功能不创建传统账号或管理员口令，不在前端存储管理密钥。

新迁移 `0017_calendar_admin.sql` **不自动授权任何设备**。这确保任意用户不能通过创建个人工作空间或初始化设备提权。

## 站长第一次授权（仅在你已确认设备确为自己的情况下）

1. 从 **Cloudflare D1 控制台** 的生产数据库 `DB` 中查看已存在设备及其工作空间；务必通过设备名称和创建记录与本人会话交叉核实，不要仅根据最近登录时间猜测哪台设备属于站长。

```sql
SELECT d.id AS device_id, d.name, d.workspace_id, d.revoked_at
FROM devices AS d
ORDER BY d.created_at DESC
LIMIT 30;
```

2. 确定本人设备 ID 且 `revoked_at IS NULL` 后，在 Cloudflare D1 控制台执行一次（将 `<已核实的本人设备ID>` 替换成真实 ID）：

```sql
INSERT OR IGNORE INTO site_admin_devices (device_id, granted_at)
SELECT id, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM devices WHERE id = '<已核实的本人设备ID>' AND revoked_at IS NULL;
```

3. 在网站的“会话凭证”中连接同一设备，进入“国服活动日历”。管理员表单只在授权完成后显示。如果没有出现，检查设备是否已撤销、连接的 Token 是否对应同一设备，以及生产迁移是否执行。

4. 要撤销管理员权限：`DELETE FROM site_admin_devices WHERE device_id = '<设备ID>';`。设备 Token 已撤销也会同时失去管理员访问权。

**不要**在 GitHub Issue、前端页面、浏览器 URL、日志或聊天中发布设备 Token、Bootstrap Secret 或 WebDAV 密码。

## 编辑语义与官方同步

- 管理员可以创建、修改、隐藏公开活动；字段包含标题、分类、北京时间开始与结束、说明及 HTTPS 来源。
- 日期未知时起止必须同时留空。这类条目不会进入日期网格或 ICS。
- 修改官方活动是覆盖数据，存放在 `curated_calendar_events`，不会直接改动定时同步的 `official_calendar_snapshots`。
- 隐藏以逻辑覆盖记录持久化，后续官方定时同步不能自动取消隐藏。管理员可补全表单保存恢复。
- 每次更新携带 `expectedRevision`。返回 HTTP 409 表示多人并发修订冲突，应刷新再编辑。
- 站点管理员不是普通工作空间管理员；私人 `workspace_events` 不会混入此全局公共活动管理界面。
