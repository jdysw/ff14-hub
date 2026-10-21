# Mobile Widgets 验收清单（PR #59 → PR #60）

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
