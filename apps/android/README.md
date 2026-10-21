# FF14 Hub Android 小部件（第一阶段）

本目录是**独立 Android 原生应用**，不替换 FF14 Hub 网页。当前只开发 Android；iOS 暂不建工程，未来可直接消费同一版本化 JSON 协议（见 `docs/mobile-widgets.md`）。

## 当前实现

- 桌面可添加 **纷争前线、水晶冲突、鱼窗、国服活动、综合概览** 5 类小部件，支持系统允许的尺寸调整。
- PVP 地图根据服务端 JSON 下发的锚点、周期与顺序在手机本地计算；前线每日北京时间 00:00、冲突每小时整点轮换。
- 鱼窗在设置页输入已关注的鱼 **数字 ID**（最多 10 个），Worker 仅计算这些鱼的公开未来 24 小时窗口。不传递个人钓获记录、WebDAV 密码。
- 活动仅读取已有的**国服官方活动快照**，待核实时间的公告不会被编造成可提醒事件。国际服不错误复用国服活动。
- WorkManager 15 分钟间隔请求快照；受省电模式/系统调度影响可能延迟，不能视为准点提醒。无网络时显示本机缓存与过期提示，PVP 可按离线轮换规则继续计算。
- 点击小部件打开 `https://ff14.zhixia.uk/`。

## 本地安装与测试

要求 Android Studio（含 Android SDK Platform 35、Build Tools 35）、JDK 17、Gradle 8.10.2。此仓库尚未提交 Gradle Wrapper 的二进制 JAR（避免放入未经验证的可执行二进制），因此首期使用 Android Studio 导入 `apps/android`，必要时先在该目录执行 `gradle wrapper --gradle-version 8.10.2`。

```bash
cd apps/android
gradle wrapper --gradle-version 8.10.2
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

Windows 执行 `gradlew.bat`（首次执行 `gradle wrapper` 会生成它）。Android Studio 也可通过 Build → Build APK(s) 构建。

构建出的调试 APK 通常位于 `apps/android/app/build/outputs/apk/debug/app-debug.apk`，需要用户在自己的设备上安装。**当前仓库只包含源码；没有通过实际 Android SDK 编译/安装验证，不提供未经确认的 APK。**

## 设计约束与待办

- 不新增游戏账号，也不让 Worker 保存个人 WebDAV 账号或密码。
- 公开 API：`GET /api/v1/widgets/v1/summary?region=cn&fishIds=123,456`。直到后端该 PR 合并部署，该接口在正式站可能返回 404；此时小部件会显示“暂无离线数据”而不是错误信息。
- 当前设置页用鱼 ID 而不是名称检索；后续增加可搜索鱼类目录、扫码导入个人偏好、钓获状态同步。
- 本阶段**没有** Android 定时通知 / 关键鱼窗本地提醒 / 锁屏活动 / iOS UI。通知调度与桌面数据刷新需要分开验收。
- 仅已证实的时间信息才能生成后续提醒。未核实的鱼窗和活动只作参考展示。
- 时间显示默认北京时间；未来 iOS 端通过 UTC 毫秒自行显示当地时区，但 PVP 轮换规则仍固定北京时间。
