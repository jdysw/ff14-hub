# 代码质量

本地检查入口为 `pnpm run verify`，发布前另运行 `pnpm run validate:config`。原生 Android 和真实浏览器验证见 [检查清单](manual-release-verification.md)。

## 测试范围

`pnpm test` 运行各包测试和运维测试。只改前端可运行 `pnpm --filter @ff14-hub/web test`，只改 API 可运行 `pnpm --filter @ff14-hub/worker test`，只改运维脚本可运行 `pnpm test:ops`。`verify` 调用同一个完整测试入口。

| 位置 | 负责验证 |
| --- | --- |
| `packages/*/test` | 游戏时间与预测计算、共享协议边界、数据转换 |
| `apps/web/test` | 筛选、编辑、恢复、同步冲突、取消请求和离线更新等用户操作 |
| `worker/test` | 真实 workerd/D1、权限、公开 API、持久化与上游故障 |
| `scripts/ops/*.test.mjs` | 发布保护、备份校验、导入转换及生成物正确性 |

Worker 中需要数据库的文件显式引入 `./setup-d1`。纯解析、凭证原语和静态资源测试不再初始化 D1，仍使用真实 workerd 提供的 Web API。

修改缺陷时，优先扩展已有流程测试。新增测试须能说明它能拦住哪一种实际错误。相同输入分类选取有效值、边界值和异常值代表，私有数据、并发覆盖和不可恢复的数据丢失风险仍应覆盖完整边界。

外观微调不新增颜色、CSS 类名、导入顺序、像素数或动画字符串断言。构建和类型检查已能发现的导出名称、文件存在性检查不再重复放进组件测试。静态资源由 Worker HTTP 测试负责，PWA 测试直接执行 Service Worker 行为。

旧导航和本机个人数据的浏览器验收脚本依赖已经移除的 UI 入口，已连同专用 Playwright 依赖清理。真实浏览器验收按发布检查清单操作，覆盖最新界面。

Sonar 的 PR 扫描只检查相应变更，不能代替合并后主线完整分析。核对历史问题时，以相同提交 SHA 的主线扫描和 OPEN/CONFIRMED 数量为准；概览包含误判时，数字不等于未解决数量。

## 保留的六项误判

这些条目已逐条在 Sonar 标记为 FALSE_POSITIVE 并说明理由，没有使用 Accept 或禁用规则。

| 位置与规则 | 原因 |
| --- | --- |
| `migrations/0001_core.sql`，plsql:S1192，4 项 | SQLite/D1 的独立 CHECK 枚举被套用 PL/SQL 常量规则。保留已发布迁移与约束原义。 |
| `HomeOfficialEvents.tsx`，typescript:S6845 | 具名可滚动列表保留 `tabIndex=0`，供键盘用户访问滚动内容。 |
| `scripts/userscripts/fishcake-runtime.js`，javascript:S7785 | 代码嵌入经典 userscript 的非 async IIFE，不适用 ES module 顶层 await 建议。 |

对应 issueKey：`AaFtGRBa5WNdnY_XE2Cv`、`AaFtGRBa5WNdnY_XE2Ct`、`AaFtGRBa5WNdnY_XE2Cu`、`AaFtGRBa5WNdnY_XE2Cw`、`AaFtGQ_g5WNdnY_XE2AK`、`AaFtGRAe5WNdnY_XE2Av`。

`.sonarcloud.properties` 仅对生成的 `apps/web/public/fishcake-sync.user.js` 排除重复率计算；源码仍参与扫描，生成一致性由 `check:fishcake-script` 校验。不通过排除文件来隐藏问题。

旧整改台账、问题快照和逐批验证流水保存在 Git 历史及 PR84–86 中，不作为当前待办。
