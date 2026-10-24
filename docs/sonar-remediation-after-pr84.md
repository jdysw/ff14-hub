# PR84 合并后的 Sonar 历史问题整改

## 基线

- 主线：`7c7103d`（PR84 的 squash commit）。
- 2026-10-24 SonarCloud Issues API 完整分页读取 `OPEN,CONFIRMED`：**352 条唯一 issueKey**，其中 Critical 44、Major 139、Minor 169。
- 完整清单：[sonar-baseline-after-pr84.tsv](./sonar-baseline-after-pr84.tsv)。`targeted_in_batch` 标记本批代码整改对象，不代表平台已确认关闭。
- 主线完整复扫前，不以 PR 的 new-code 数字推算历史问题剩余数。

## 本批代码整改对象：77 条

| 规则 | 基线数量 | 处理 |
| --- | ---: | --- |
| TS/JS S2681 | 32 | 按语法树补充单语句条件分支的明确代码块，保留原执行边界、条件外语句及串行异步顺序 |
| TS S6759 | 12 | 组件参数使用 Readonly，维持组件 API 与运行行为 |
| TS/JS S7758 | 22 | ASCII 分类、BOM 和字节编码使用 codePointAt/fromCodePoint；越界读取保留 NaN，ASCII 判断拒绝所有非 ASCII 码点 |
| TS/JS S8786 | 2 | 导航快照标签剥离使用单向扫描；活动时间前缀把可选冒号与后续空白绑定，消除两个相邻重叠空白量词 |
| TS S3776 | 2 | 拆分云端同步预览、阶段说明及鱼糕冲突选择、状态显示，相关函数认知复杂度均降至 15 以下 |
| TS S3358 | 4 | 云端同步阶段及说明改为显式互斥分支 |
| TS S7780 | 3 | 本批涉及的活动日期正则字符串使用 String.raw，保持正则源文本 |

鱼糕脚本仅修改源文件后通过项目生成器更新分发文件，没有手工修改生成产物。导航离线导入仍只解析数据，不执行第三方 JavaScript。没有并行化数据库更新、重试、租约或用户同步写入。

## 验证

- `pnpm run verify` 全部通过：项目测试 **620**（Web 268、Worker 172、shared 157、engine 17、sync 6），运维测试 **62**（新增导航快照纯文本解析及长未闭合标签用例 2 项）。
- 鱼糕生成物、Android PVP 规则、D1 基线守卫、ESLint、TypeScript、Web 构建及 Worker dry-run 通过。
- 对 **20 个**仅调整代码块或类型的文件做编译后语法结构对照：消去单语句 if 的代码块差异后，与 `7c7103d` 一致。同步组件拆分及编码 API 变更由实际项目测试覆盖。
- 本地 SonarJS：本批所有 S2681/S6759 所在文件的 conditional-indentation / prefer-read-only-props 无告警；同步面板及活动解析模块通过认知复杂度 15、正则复杂度 20、超线性正则及嵌套条件检查。
- `git diff --check` 通过。

## 首次 PR 扫描反馈与修正

- `PR85@e83d747`：1 条新增 `javascript:S7773`（抽出导航清理函数时继承的全局 parseInt），已改为 Number.parseInt，行为不变。
- 质量门失败原因为新代码重复率 **7.4%**。`api/duplications/show` 与逐文件重复行指标确认：全部 **30 条新重复行**来自 `scripts/userscripts/fishcake-runtime.js` 及其生成的 `apps/web/public/fishcake-sync.user.js`（各 15 行）；新抽取的导航函数和同步组件没有重复行。
- 添加根目录 `.sonarcloud.properties`，仅设置 `sonar.cpd.exclusions=apps/web/public/fishcake-sync.user.js`。机械生成的发布副本不参与复制粘贴重复率，原始源码仍参与；发布文件的代码规则与安全分析也保留。没有设置 `sonar.exclusions`、issue ignore 或改变质量门阈值；生成物检查仍必须通过。
- 配置依据：[Sonar 官方重复率范围说明](https://docs.sonarsource.com/sonarqube-cloud/managing-your-projects/project-analysis/setting-analysis-scope/exclude-from-coverage-duplication)，Automatic Analysis 使用根目录 `.sonarcloud.properties`。
- 另以主线真实实现对照 396 组书签解析输入（Unicode、畸形实体、href、分组和重复链接），输出一致。
- 上述修正提交仍须完成新的 PR 复扫，不能沿用首次扫描状态。

## 待验收与剩余工作

- 本 PR 最新 SHA 的 SonarCloud 与远端构建结果。
- 合并后主线完整扫描，逐条核验上述 issueKey，才能报告历史剩余数。
- 其余复杂度、嵌套条件、异步循环、Android 导出组件、安全诊断等保持在完整台账中，不通过放宽质量门、隐藏规则或批量标记误报处理。
- 不改动已经发布的数据库迁移以消除其中字符串重复告警。
