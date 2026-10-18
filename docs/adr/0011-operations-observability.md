# ADR 0011 — 06E 调度观测与私有运维诊断

本阶段实现 HUB-039 的本地可验收基础：持久化调度完成/失败、工作空间聚合诊断、固定告警代码与日志加固。没有注册真实 Cron、启用云端日志导出、创建外部告警服务或发送通知。

## 调度记录

迁移 0015 添加 `scheduler_observations`，仅保存运行 UUID、开始/结束时间、状态、计划/处理计数及失败阶段，不保存工作空间内容、订阅、端点、凭证或异常正文。

调度入口先写 running，再依次 await 规划与投递；完成后记录 succeeded。开始记录失败时不执行后续副作用。规划、投递或完成记录失败均输出固定结构化错误并向平台抛出固定消息，不携带原异常/cause。若写失败记录本身也失败，仍让平台看到调用失败，不能以“日志写入失败”为由吞掉原任务失败。

成功表示本轮规划与处理函数完成，不表示所有推送成功。planned 是新增逻辑任务数，processed 是认领处理数；设备是否收到/显示通知仍无法证明，网络投递保持此前的 at-least-once 边界。

每次开始时最多把 100 条超过 30 分钟仍未完成的观测记录标为 abandoned（没有观察到完成，不等于确认进程已停止），并最多清理 100 条旧的已结束历史，保留最近 100 条历史加当前运行。该维护不修改业务任务或租约。最近成功时间来自保留窗口，不是永久审计记录。

## 私有诊断 API

`GET /api/v1/me/operations?region=cn`（或 global）复用设备认证，必须用 Authorization 请求头；响应 no-store，未知查询字段拒绝。停用模块后仍能诊断，接口不要求模块 enabled，也不触发规划/投递/恢复动作。

单次 D1 batch 读取：当前工作空间/区服的规则、到期未完成任务、阻塞与失效租约、24h 失败/投递分类、最近 Hub 导入及水位；当前区服公开鱼类目录的来源验证/演示/抓取时间摘要；当前空间的模块门禁。没有原始任务、规则正文、操作 payload、设备/工作空间 ID、任意失败 reason、推送端点或订阅密钥。

全局调度部分只返回最近运行的状态、时间及阶段，以及保留窗口内最近成功时间；不返回 runId、工作量计数或其他工作空间数据。全局 liveness 与私有工作空间统计是不同维度。

固定告警代码如下（只在响应中计算，不主动发送）：

| 代码 | 含义 |
| --- | --- |
| scheduler_not_observed | 尚无调度观测，info；不把未部署 Cron 误报成故障 |
| scheduler_failed / scheduler_stale | 最近运行失败，或超过 30 分钟未完成/已标记 abandoned |
| due_backlog / stale_leases | 到期未完成任务或过期租约，后者仍受原业务认领门禁保护 |
| delivery_failures | 近 24h 有失败任务或临时/永久投递失败；accepted 只表示推送服务接受 |
| push_unconfigured | 有启用规则但 VAPID 格式检查不通过；格式通过也不能证明渠道可达 |
| catalog_unverified | 当前目录没有非演示且来源验证为 verified 的记录，info；不代表鱼类规则已验证 |
| source_stale | 上述已验证来源的 fetchedAt 超过 7 天；该阈值是运维提示，不改变鱼窗算法 |
| modules_pending | 当前空间有关模块存在待完成生命周期操作 |

同步仅报告 Hub 导入时间，无法得知客户端关闭后的 DAV 新鲜度。来源抓取器尚未实现，因此 `fetchMonitoringAvailable=false`；未验证真实 Cron 周期，`cadenceVerified=false`；`webdavFreshnessAvailable=false`。无这些观测数据时不声称健康。数据库不可读返回错误，不伪造空的健康响应。

## 日志保护

`logLine` 现在先按敏感字段名隐藏整段值，覆盖不带高熵前缀的口令、账号、Token、端点和订阅；再做已有文本模式脱敏。调用方不能用 fields 覆盖 level/event，也不能写原型特殊字段。调度路径不记录原异常消息。文本模式仍是兜底，不能保证识别任意未标记的敏感正文；调用方仍只能传挑选过的元数据。

## 验收、兼容与未完成

Workers/D1 测试覆盖实际 scheduled 入口、规划/投递/记录失败、保留策略、跨空间/区服隔离、私有缓存头、无秘密响应及日志字段覆盖。整库恢复演练通过本地 `--test-scheduled` 真正触发入口，再验证诊断可读；备份/恢复包含观测记录，恢复库不重新触发调度。该开关只用于隔离本地演练，不修改生产配置或注册 Cron。

迁移是新增表/索引，旧 Worker 可忽略，回退应用版本不删除观测表。仍未完成真实 Cron 心跳/漏跑检测、外部告警、数据抓取失败追踪、真实 DAV 客户端故障采集、完整安全审计与生产监控。因此不把 HUB-039 的完整部署验收标记为完成。

参考 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)、[本地测试 Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally)。复用已有 D1、模块/通知数据与日志工具，无新依赖或外部源码复制。
