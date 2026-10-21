# FF14 Hub Android 小部件（第一阶段）

本目录是**独立 Android 原生应用**，不替换 FF14 Hub 网页。当前只开发 Android；iOS 暂不建工程，未来可直接消费同一版本化 JSON 协议（见 `docs/mobile-widgets.md`）。

## 当前实现

- 桌面可添加 **PVP 战场（小/中/大）、鱼窗、国服活动、综合概览**。所有 PVP 入口都合并两种战场，缩放同一个实例即可动态切换信息密度。
- PVP 合并显示纷争前线与水晶冲突；前线每日北京时间 **23:00**、冲突每小时整点轮换。小、中、大只是初始尺寸，拖动同一个组件即可动态增减信息，详见 `docs/pvp-responsive-widgets.md`。
- 鱼窗可在设置页**按名称搜索并选取**，也能直接输入鱼 **数字 ID**（最多 10 个），Worker 仅计算这些鱼的公开未来 24 小时窗口。不传递个人钓获记录、WebDAV 密码。
- 活动仅读取已有的**国服官方活动快照**，待核实时间的公告不会被编造成可提醒事件。国际服不错误复用国服活动。
- WorkManager 15 分钟间隔请求快照，另使用无需精确闹钟权限的本机轮换事件在换图边界重绘 PVP；受省电模式/系统调度影响二者都可能延迟，不能视为准点提醒。无网络时显示本机缓存与过期提示，PVP 可按离线轮换规则继续计算。
- 点击小部件打开 `https://ff14.zhixia.uk/`。

## 本地安装与测试

要求 Android SDK Platform 35、Build Tools 35 和 JDK 17。仓库已包含官方 Gradle 8.10.2 Wrapper，distributionSha256Sum 固定发行包校验值；无需全局安装 Gradle。设置 `JAVA_HOME` 和 `ANDROID_HOME` 后可直接构建。

```bash
cd apps/android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Windows 执行 `gradlew.bat`。Android Studio 也可通过 Build → Build APK(s) 构建。

构建出的调试 APK 位于 `apps/android/app/build/outputs/apk/debug/app-debug.apk`。Debug 构建、JVM 测试和 Android lint 已在 Windows + JDK 17 + SDK 35 实际执行通过；设备验收另见 `docs/mobile-widget-acceptance.md`，构建通过不代表真实手机验收完成。

## PVP 首次离线使用

- 即使预览 API 尚未部署，前线和水晶冲突也会使用安装包附带的国服规则，显示当前地图、下一张、北京时间换图时间和系统倒计时，并标注“内置国服规则 · 联网后校验”。不会伪造已成功联网。
- 规则资产由 `packages/shared/src/pvp-rotation.ts` 生成；更新共享规则后在仓库根目录运行 `pnpm generate:android-pvp`，提交资产，并运行 `pnpm check:android-pvp` 检查一致性。锚点遵循既有 PVP PR 的国服约定，游戏规则改变时需要更新。
- 保存相同设置保留完整快照；变更鱼或区服时保留 PVP 规则，但隔离失效的鱼窗和活动。设置代际校验拒绝旧请求，异常 JSON 不会覆盖成功缓存。
- 开机、应用更新、手动校时及时区变化会重绘并恢复换图计划。PVP 合并组件按两种模式的最早边界安排；无 PVP 组件时取消换图闹钟。
- 非精确闹钟受系统调度和省电限制，地图文字可能延迟更新，不承诺整点准时提醒。参见 [Android 官方闹钟说明](https://developer.android.com/develop/background-work/services/alarms)。

## 设计约束与待办

- 不新增游戏账号，也不让 Worker 保存个人 WebDAV 账号或密码。
- 公开 API：`GET /api/v1/widgets/v1/summary?region=cn&fishIds=123,456`。调试 APK 自动请求 `https://ff14-preview.zhixia.uk`，Release APK 才请求正式 API。调试版应用 ID 带 `.debug` 后缀，可与正式版共存，缓存和偏好互不混用。接口未部署时 PVP 使用明确标注的内置规则，鱼窗及活动显示未选择/暂不可用。
- 设置页已支持按名称检索公开鱼类目录并添加到关注列表；后续支持扫码导入个人偏好、钓获状态 WebDAV 同步。
- 本阶段**没有** Android 定时通知 / 关键鱼窗本地提醒 / 锁屏活动 / iOS UI。通知调度与桌面数据刷新需要分开验收。
- 仅已证实的时间信息才能生成后续提醒。未核实的鱼窗和活动只作参考展示。
- 时间显示默认北京时间；未来 iOS 端通过 UTC 毫秒自行显示当地时区，但 PVP 轮换规则仍固定北京时间。
