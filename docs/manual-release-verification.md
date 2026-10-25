# 验证与发布检查

## 本地基线

需要 Node.js >= 22.12.0 和 `package.json` 指定的 pnpm，先安装冻结依赖：

```sh
pnpm install --frozen-lockfile
pnpm run verify:release
```

`verify` 包括生成物一致性、D1 基线守卫、ESLint、TypeScript、各包单测、workerd/D1、运维测试及 Web/Worker 构建干跑。`verify:release` 再追加 preview/production 配置干跑。两者都不部署，也不执行 Android Gradle。

完整运行方式见 [本地开发](development.md)。外部依赖漏洞检查使用 `pnpm run audit:prod`；网络不可用时记录未执行。

## 浏览器

先按 [开发说明](development.md) 启动本地同源服务，再执行：

```sh
pnpm run smoke:local
pnpm run e2e:navigation
pnpm run e2e:local-personal
```

人工核验首页与手机布局、搜索快捷键、模块展开/收起与焦点恢复、待办、钓鱼标记和备份恢复。同步与通知使用隔离资料；测试凭证或合成管理员不写入生产。

WebDAV/S3 条件写、鱼糕脚本管理器和实际通知收件须在对应服务确认，模拟通道或 DOM 测试不能代替实际送达验证。

## Android

需要 JDK 17、Android SDK Platform 35 / Build Tools 35，使用仓库内的 Gradle Wrapper：

```sh
cd apps/android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Windows 使用 `.\gradlew.bat`。调试版连接 preview，与正式应用隔离。构建、严格依赖校验和设备交互分别记录；缺少 SDK 时不报告原生构建通过。设备检查见 [Android 验收](mobile-widget-acceptance.md)。

## 上线前后

1. 固定待发布 SHA，运行上述与变更相关的检查及 `pnpm run ops:preflight`。
2. 涉及数据库时备份，检查已应用记录，先在 preview 验证；新库应用全部现行迁移。见 [迁移说明](d1-single-baseline.md)。
3. 核对环境、D1、Secrets、允许的 Origin 和测试路由关闭状态。
4. 通过 Cloudflare Workers Builds 或经授权的人工流程发布，见 [部署说明](automatic-deployment.md)。
5. 运行 `node scripts/ops/verify-live.mjs production`，核对同一提交的线上资源；Sonar 主线完整分析须匹配该 SHA。

不以远端构建成功代替本地测试，也不以 PR 的“0 新问题”代替主线历史问题核验。
