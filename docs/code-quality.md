# 代码质量

本地检查入口为 `pnpm run verify`，发布前另运行 `pnpm run validate:config`。原生 Android 和真实浏览器验证见 [检查清单](manual-release-verification.md)。

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
