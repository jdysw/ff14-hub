# Mobile Widgets 验收清单（PR #59 → PR #60）

## 2026-10-21 PVP 续开发验收结果

此前“缺少 Android SDK”的限制已在本轮本地构建环境解决。此次没有合并原 PR，也没有部署生产。

- 使用 JDK 17.0.20.1、SDK 35、Build Tools 35.0.0 和带发行包 SHA256 的 Gradle 8.10.2 Wrapper，实际执行 `gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug` 成功。Android 测试 17 项通过；lint 无错误，仍有原有的备份配置、缺少应用图标及中文文案资源化警告。
- `pnpm run lint`、`pnpm run typecheck`、`pnpm run build:web` 通过。修复已有 PVP 旧设置迁移的 unsafe spread；排除 Android build/.gradle 生成目录，避免构建报告误入 JS lint。
- Web PVP/本地数据迁移 3 个文件、11 项测试通过；真实 workerd/D1 的 `mobile-widgets-v1.spec.ts` 4 项通过。
- `pnpm check:android-pvp` 通过，安装包内置 JSON 与共享 TypeScript 国服轮换源一致。首次无网/接口 404 时也可显示 PVP，并明确标注内置规则。
- Android 15/API 35 x86_64 模拟器安装成功、设置页启动成功；通过应用内按钮和系统桌面添加实际前线及水晶冲突组件。看到当前/下一张地图、北京时间换图时间、离线标记和系统倒计时。
- 模拟器关闭联网、设置绝对时间核验水晶 10 点时段赤土红沙、11 点时段角力学校；重启后两种组件仍存在，系统重新安排下一个 PVP 边界闹钟，AndroidRuntime 日志无异常退出。时间变更与重启事件经过实机 Android 系统路径，不能据此声称非精确闹钟在省电模式下准点触发。
- 单独前线的系统闹钟指向北京时间次日零点；同时存在水晶时只安排一个最早边界闹钟。JVM/Robolectric 进一步覆盖首次离线、相同设置保留、跨区服隔离、设置变更往返后的旧请求拒绝、坏协议/坏轮换保留成功缓存，以及无 PVP 时不安排换图唤醒。
- 调试 APK 采用 `.debug` 独立包名，使用 Android Debug 签名，`apksigner verify` 已通过。它不是正式签名的发布包。
- 本次实测预览接口仍返回 404，因此联网更新的远端端到端验收仍待预览部署；尚未验收实体手机、厂商省电策略、任意字体缩放及全部尺寸、真实游戏临时变更后的轮换事实。鱼窗、活动和 iOS 不作为本次完成范围。

下方仍保留完整发布门槛；本轮构建与模拟器结果不等于所有发布门槛均已满足。

## 合并依赖与禁止动作

1. 先验收并压缩合并 **PVP PR #59**，确保其 web/本地数据迁移测试全部通过。
2. 再把 Android PR #60 的 base 从 PVP 分支调整到 main，解决可能产生的同步冲突。
3. **保留 GitHub Actions 关闭**。使用已配置的 Cloudflare 预览手动构建，验证 Worker API；不得仅凭 Cloudflare「构建成功」断言 Android APK 正常。
4. 未完成实际 Android SDK 构建与设备安装前，不合并 PR #60、不部署生产 API、不提供未经核验的 APK。

## CI 等效的本地验收

在有 pnpm、Node 22、Android SDK 35、JDK 17 和 Gradle 8.10.2 的机器执行：

```bash
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm --filter @ff14-hub/web exec vitest run test/pvp-rotation.spec.ts test/pvp-board.spec.tsx test/local-data.spec.ts
pnpm --filter @ff14-hub/worker exec vitest run test/mobile-widgets-v1.spec.ts
pnpm run build:web
cd apps/android
gradle wrapper --gradle-version 8.10.2
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

**不能直接把测试断言改为成功**。若发现测试数据的锚点与计算规则不一致，应重新计算固定 UTC 时间并修正测试样例。

## 后端公开接口

- `GET /api/v1/widgets/v1/summary` 返回 200 + `schemaVersion=1`，且无 Cookie、登录或私有工作空间数据。
- `region=global` 不泄露国服活动；PVP 国服规则明确标注其版本。
- `fishIds=1,1`、`fishIds=0`、超出 10 个 ID、额外未知参数返回 422；POST 不能修改数据。
- 反馈给客户端 `unavailable` 或 `stale`，而不是在数据源失效时伪造「没有活动」。
- 大批量关注鱼请求有硬限制；响应不含 WebDAV 密钥或用户钓获记录。

## Android 调试 APK

- **Debug** 请求 `https://ff14-preview.zhixia.uk`；**Release** 请求 `https://ff14.zhixia.uk`，调试版用独立包名 `.debug`。预览接口未部署时，debug APK 可安装，但会提示没有离线数据。
- 通过系统桌面添加五种小部件；点击后能打开 FF14 Hub 网站，缩放尺寸不裁切关键信息。
- 设置页按鱼名搜索、添加不超过十种鱼、切换区服、保存并刷新；无网络时不能清空已成功缓存的信息。
- 北京时间 2026-10-21 10:00–11:00 水晶冲突显示「赤土红沙」，11:00 以后显示「角力学校」；10-21 前线为「尘封秘岩」，10-22 变为「周边遗迹群」。
- 在仅放置鱼窗/活动小部件时不得安排 PVP 每小时本机唤醒；PVP 小部件可在下一个地图轮换点重新计算。省电模式可能延迟，不能将 AlarmManager 非精确提醒描述为准点保证。
- 校验断网缓存、快照超时标注、手动恢复网络、后台应用被系统回收后的行为。
- 测试 Android 13+ 通知权限未授予情况：首期没有主动通知权限请求，桌面显示不能依赖通知权限。
- 验证电量、请求量、异常退出、恶意/异常 JSON，以及重复加入同一鱼 ID 的错误提示。

## iOS 兼容保证

- 将 `mobileWidgetResponseV1Schema` 作为平台独立公共协议，明确版本、UTC 毫秒、时区、地图规则和缓存状态。
- **不在本期新增 Swift/WidgetKit 工程**。未来 iOS 客户端须优先直接复用 v1，确需不兼容变动时增加 v2 而非破坏 v1。

## 尚未具备的能力

鱼糕 WebDAV 双向进度同步、精确鱼窗开始/关闭本地通知、PVP 主动提醒、活动推送、Android 锁屏实时活动及真正的 iOS 小部件，均不属于当前 APK MVP 的已完成内容。
