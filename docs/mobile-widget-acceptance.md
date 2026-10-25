# Android 小组件验收

使用 JDK 17、Android SDK 35 和仓库内 Gradle Wrapper，不重新生成或更换 Wrapper：

```sh
pnpm run check:android-pvp
pnpm --filter @ff14-hub/worker exec vitest run test/mobile-widgets-v1.spec.ts
cd apps/android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Windows 使用 `.\gradlew.bat`。原生任务单独执行，不能从 Web 构建成功推断 APK 正常。

## API

- `GET /api/v1/widgets/v1/summary` 符合 v1 schema，不要求玩家登录、不返回个人钓获或云存储凭证。
- 区服隔离，未知/非法参数与超额鱼 ID 被拒绝；鱼类选择最多十种。
- 数据不可用与过期状态明确，不把失败伪装成空日程。
- 在线 Web 与 Android 使用已发布游戏规则，离线客户端保留上次成功缓存或内置规则。

## 设备

- 调试版独立包名 `.debug`，连接 preview；正式版连接 production。
- 通过系统桌面添加 PVP、鱼窗、活动、概览组件；不同初始尺寸的 PVP 实例均可拖动缩放，检查字体放大、窄屏、点击及内容裁切。
- 按鱼名搜索和选择，切换区服、保存和刷新。设置变化后旧请求不得覆盖新结果，失败不清空成功缓存。
- 无网络首次启动可按内置国服规则显示 PVP，明确来源；鱼窗/活动不可用时说明状态。
- 纷争前线按北京时间 23:00、水晶冲突按每小时边界检查轮换；与共享规则及测试样例核对，不沿用旧的零点前线规则。
- 测试开机、升级、校时、时区变化、省电、断网与恢复。没有 PVP 组件时不安排其轮换唤醒。
- Receiver 保持不导出时，仍可通过系统 launcher 添加并更新组件。

非精确闹钟和后台刷新受系统调度影响，不承诺准点。Android 当前没有独立鱼窗通知或 iOS 工程。小米背景与负一屏限制见 [兼容说明](pvp-xiaomi-compatibility.md)。
