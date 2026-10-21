# Mobile Widget Snapshot API v1（Android 首发，保留 iOS 兼容）

2026-10-21 更正：国服前线北京时间每日 **23:00** 换图，规则版本升级至 `2026-10-21-cn-v2`；协议版本仍为 1。Android 合并 PVP 视图与缩放设计见 `pvp-responsive-widgets.md`。

## 协议

`GET /api/v1/widgets/v1/summary?region=cn&fishIds=101,202`

- **只读、匿名、无 Cookie、无个人进度**。不传 WebDAV、钓获信息或任何个人通知令牌。鱼 ID 最多 10 个，不可重复；留空时返回 `fish.status=selection_required`。
- 响应为普通 JSON（UTF-8），无 Android 类名/Parcelable 字段。未来 iOS 的 WidgetKit 直接按同一契约读取。
- 顶层 `schemaVersion: 1` 固定；变更破坏兼容性时使用 `/v2/summary`，旧版端点保留兼容期，不让旧安卓/未来 iOS 突然解析失败。
- 时间统一以 **UTC Unix 毫秒**表示（`*AtMs`），`timezone: "Asia/Shanghai"` 只解释本轮 PVP 规则的每日换图边界，不要求设备更改系统时区。
- `generatedAtMs` 是服务端生成时刻；`refreshAfterMs` 指建议刷新时刻（通常 15 分钟后），`staleAfterMs` 是缓存失效时刻。不可用的数据返回 `unavailable` 状态，禁止用空列表冒充“无活动/无鱼窗”。
- `pvp.frontline` / `pvp.crystalline` 均返回 `current`、`next`、`startsAtMs`、`changesAtMs`、`anchorUtcMs`、`anchorIndex`、`periodMs`、`cycle`、`ruleVersion`。移动端即便断网也可使用整数 floor division、正模运算计算当前换图；客户端若缓存过期须警告可能规则已修改。
- `fish.items[]` 包含公开鱼名、ID、开/关窗时刻和 `validationStatus`、`candidateOnly`；不能据此自动推定个人是否钓获，更不能对 `candidateOnly` 承诺精准提醒。
- `events.items[]` 只收录有明确起止时间且尚未结束的国服官方日程；`events.sourceCheckedAtMs` 和 `status` 表示官方快照是否已过期，个人活动和待核实公告不进入确定时间数组。

## 客户端示例（字段形状示意，非实时游戏数据）

```json
{
  "schemaVersion": 1,
  "generatedAtMs": 1792548600000,
  "refreshAfterMs": 1792549500000,
  "staleAfterMs": 1792555800000,
  "timezone": "Asia/Shanghai",
  "region": "cn",
  "pvp": {
    "frontline": {
      "current": "尘封秘岩（争夺战）",
      "next": "周边遗迹群（阵地战）",
      "startsAtMs": 1792508400000,
      "changesAtMs": 1792594800000,
      "anchorUtcMs": 1792508400000,
      "anchorIndex": 4,
      "periodMs": 86400000,
      "cycle": ["尘封秘岩（争夺战）", "荣誉野（碎冰战）", "昂萨哈凯尔（竞争战）", "沃刻其特（演习战）", "尘封秘岩（争夺战）", "周边遗迹群（阵地战）", "昂萨哈凯尔（竞争战）", "沃刻其特（演习战）"],
      "ruleVersion": "2026-10-21-cn-v2"
    },
    "crystalline": {
      "current": "赤土红沙",
      "next": "角力学校",
      "startsAtMs": 1792548000000,
      "changesAtMs": 1792551600000,
      "anchorUtcMs": 1792548000000,
      "anchorIndex": 6,
      "periodMs": 3600000,
      "cycle": ["角力学校", "火山之心", "海岸斗场", "九霄云上", "机关大殿", "休兵书库", "赤土红沙"],
      "ruleVersion": "2026-10-21-cn-v2"
    }
  },
  "fish": {"status":"selection_required", "items":[]},
  "events": {"status":"unavailable", "sourceCheckedAtMs":null, "items":[]}
}
```

## 当前架构与后续

- Android 调试 APK 使用预览 API，Release APK 使用正式 API，避免绕过预览验收；两者使用同一数据结构。Android 使用原生 App Widgets + WorkManager + HTTPS 缓存；额外用本机非精确轮换提醒触发 PVP 视图重绘，仍受省电模式限制。WorkManager 周期刷新是 **尽力而为**，不可提供分钟/秒级准点推送保证；通知将另设本地计划和系统权限管理。
- 未来的 iOS 仅需实现 WidgetKit timeline 与同一 JSON 契约，不必增加 iOS 专属后端或用户系统。
- 服务端只计算最多 10 条关注鱼的未来窗口，避免对全部鱼图鉴做高成本的每次请求计算。
- 当前 PVP PR #59 尚未合并；本功能 PR 基于其分支构建。需先验证并合并 PVP，再验证该 API + Android 工程，最后再部署后端。GitHub Actions 维持关闭。
