# FF14 Hub 手动发布验证清单

> 本项目不依赖 GitHub Actions 自动运行，不应为了执行下列检查而开启付费 CI。每项都在有权限的本地开发环境或隔离测试环境手动执行，并保留命令与退出码。**通过构建并不代表自动部署生产。**

## 0. 前置与变更边界

- `node >= 22.12`；按 `package.json` 的版本使用 pnpm。Windows 优先 PowerShell。
- 从 PR 的最新提交安装依赖：`pnpm install --frozen-lockfile`。
- 变更目录至少检查 `git diff --check`，对比 PR 包含的数据库迁移、密钥引用与公共 API 结构。
- 本轮已将迁移源码重新整理为单文件 `migrations/0001_core.sql`；先运行 `pnpm run test:db-baseline`，再在隔离 workerd/D1 应用并测试完整基线。已有 D1 应先只读核对 `d1_migrations` 和现存表，禁止把旧历史表直接 DROP，也不得重置生产迁移记账；参见 [数据库单文件基线](d1-single-baseline.md)。
- 实际 Secret、管理员 Token、WebDAV/S3 凭证不得提交仓库或日志；预览与生产使用独立环境。

## 1. Web 与 Worker 基线

```sh
pnpm run verify
pnpm run validate:config
# 上面两项的合并入口：pnpm run verify:release
```

`verify` 包含鱼糕脚本生成一致性、Android PVP 共享规则一致性、ESLint、严格类型检查、Vitest/workerd/D1 测试、运维测试和 Web/Worker 构建干跑。它**不运行 Android Gradle，也不会部署**。`validate:config` 分别检查 preview 和 production 的 Wrangler 干跑配置，不会代替上线后的绑定校验。

```sh
pnpm run smoke:local
# 需预先启动相应本地 Web/Worker API，脚本才可验证真实交互
pnpm run e2e:navigation
pnpm run e2e:local-personal
pnpm run audit:prod
```

`audit:prod` 会依赖公开 npm registry，离线时记录“未执行”而不是“通过”。浏览器 E2E 需要依照 README 启动服务，不得将未执行的 E2E 记成通过。

## 2. Android 原生组件（独立门禁）

要求 JDK 17、Android SDK Platform 35 / Build Tools 35，正确设置 `JAVA_HOME` / `ANDROID_HOME`。

Linux/macOS：
```sh
cd apps/android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Windows PowerShell：
```powershell
cd apps/android
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

注意 Android 调试版默认走预览环境，与生产应用隔离。Gradle 任务通过后仍需在真实设备核验组件尺寸、轮换、省电恢复和缓存行为。没有 Android SDK 的环境，只能报告规则资源检查通过，不能声称 Android 构建通过。

## 3. 本次审计的专项回归

通知投递（`worker/test/local-notifications.spec.ts`）：
- 失败/超时/429/5xx 不永久耗尽“供应商已接受投递”的日额度；
- 同一时刻并发调度不能在投递前突破额度；
- 租约过期旧执行者不可返还其他任务的额度；
- 到期、跨日与三次重试边界正常；配额仅以供应商接受的 2xx 为成功，不能推断终端实际展示。

钓鱼看板（`apps/web/test/fishing-board.spec.tsx`、`forecast-session.spec.ts`）：
- 首页和详情同时挂载可共享预测 Worker；卸载最后一个订阅者才释放资源；
- 秒级倒计时准确，整表筛选/排序只在分钟和窗口开闭时重算；
- 捕获浏览器恢复可见状态与目录换版后重新计算；
- 国服/国际服、6/24/72/168 小时、已钓获隐藏、关注与鱼识候选等行为不退化。

需要收集 React Profiler/Performance 数据和较低性能设备上的加载耗时，再判断是否继续拆分 4 MB 鱼类目录。缺少量化结果时不写性能提升百分比。

## 4. 发布

- 先部署 **preview**，检查公开导航/活动、管理员登录、通知和鱼窗，核实 Preview D1 与 Secrets。
- 确认审批后才调用受控的 `pnpm run release:production`。不得将 `wrangler deploy` 的默认环境推断为 production。
- 发布后运行 `node scripts/ops/verify-live.mjs production`，核对实际自定义域名、健康及静态资源，并检查 `BOOTSTRAP_SECRET` 等 Secrets 确实仍在。
- 如果生产异常，按 `docs/operations-runbook.md` 回滚代码与数据库变更；不要通过重置管理员密钥作为恢复手段。

## 5. 单用户 API 退役验证

维护者确认目前仅本人使用，不需要旧设备工作空间兼容层。已从现行路由移除 `/api/v1/identity/*`、`/api/v1/me/*`、`/api/v1/modules/catalog`。发布检查必须断言这些路由返回结构化 JSON 404，并再次验证公开导航、活动、鱼类、Android Widget、唯一 owner 管理和本机提醒未受影响。

保留原先已执行的 D1 迁移记录以保持迁移版本链，本次没有执行 `DROP TABLE` 或删除历史用户数据。不能用已退役的身份/布局恢复脚本作为上线门禁，数据库中的旧表可在单独备份与增量迁移后再清理。
