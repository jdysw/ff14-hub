# 剩余 275 项逐项处理记录（2026-10-25）

## 范围与口径

PR85 首批以 `main@7c7103d` 的 352 项为基线，处理对象为其中 77 项。本轮接着处理原清单中其余 **275 个唯一 issueKey**：

- **269 项代码整改或既有整改复核**，见 [逐项台账](./sonar-remaining-275-tracker.tsv)。
- **6 项逐条审核为 FALSE_POSITIVE**，已通过 Sonar UI 单独提交理由，并用公开 Issues API 核验状态。没有使用批量变更、Accept、规则关闭或新增文件级问题排除。
- 该口径是源代码与逐项审核完成记录，**不表示尚未合并的主线已显示 0**。代码项在台账中保留 `pending-main-rescan`，最终须由最新 PR 检查及合并后的主线完整分析验收。

## 代码整改

- 将大型钓鱼/导航/搜索界面的状态逻辑、文案、结果行及独立区域分离；保留数据世代、并发保护、撤销、筛选优先级和稳定 ID。
- 将鱼窗计算按单条规则查询对象组织，分离天气缓存、全天连续天气及每日时间段扫描；保留完整区间身份、跨日、前置天气和候选条件。
- 审核脚本按身份、钓点、鱼饵、天气、海钓、鱼识及证据修正拆分；仍保留来源缺失、冲突和原始事实，不把资料不足改为一致。
- 使用惰性串行任务、首个结果及有限重试工具，保留配额、租约、重试次数和副作用顺序。官方详情仍每批最多 6 项，D1 导入仍每批 50 条；没有盲目 Promise.all。
- 流读取使用异步迭代，提前退出时等待取消；保留字节上限、截止时间和响应类型验证。
- D1 SQL 白名单冻结；发布 argv 验证命令形状、环境、版本与消息并重建固定模板。Git/taskkill 不再依赖 PATH 命令名查找；curl 首次请求与重定向均限制 HTTPS。
- 原生 fieldset/按钮承担分组与关闭，键盘事件置于可交互控件；明确标签空白，调整对比度和层叠优先级。
- 鱼糕 Hub realm 只输出实际需要的文档验证器；完整适配器仍放在 page realm。分发文件由生成器更新并校验，保持经典脚本格式。
- Android 六个小组件 Provider 关闭导出；拆分搜索、渲染和布局断言，替换弃用 URL 构造。依赖版本集中到 catalog，生成依赖锁与 SHA256 verification metadata。

## 单独审核的 6 项

| issueKey | 规则 | 依据 |
| --- | --- | --- |
| AaFtGRBa5WNdnY_XE2Cv | plsql:S1192 | SQLite/D1 独立表 CHECK 枚举不是 PL/SQL 程序，不能声明该规则要求的常量 |
| AaFtGRBa5WNdnY_XE2Ct | plsql:S1192 | 同上，逐条核对 L94 的约束，保留已发布迁移及校验 |
| AaFtGRBa5WNdnY_XE2Cu | plsql:S1192 | L122 的内容模式与相关约束不能引用 PL/SQL 常量 |
| AaFtGRBa5WNdnY_XE2Cw | plsql:S1192 | L122/L135 审计模式枚举属于 SQLite DDL |
| AaFtGQ_g5WNdnY_XE2AK | typescript:S6845 | 具名可滚动列表需保留键盘焦点；删除 tabIndex 破坏现有回归和键盘滚动 |
| AaFtGRAe5WNdnY_XE2Av | javascript:S7785 | 源码被嵌入非 async 的经典 userscript IIFE，不适用 ES module 顶层 await 建议 |

滚动焦点依据：[MDN overflow 无障碍说明](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow#accessibility)。迁移文件及校验未修改。提交审核时均关闭额外“分享给 Sonar 改进分析器”的选项。

## 验证证据

- 完整 `pnpm run verify` 通过：**629 项项目测试**（Web 268、Worker 172、shared 166、engine 17、sync 6）与 **66 项运维测试**。ESLint、TypeScript、生成物/Android PVP/D1 守卫及 Web/Worker dry-run 均通过。
- 本地 SonarJS 对本轮规则对应的源文件检查通过；认知复杂度阈值 15、函数嵌套阈值 5。补充 Unicorn 对应规则和循环 await 检查均无告警。此检查不代替平台完整分析。
- 121 组真实目录规则的新旧鱼窗查询输出/错误一致，包含 50 规则混合的七天查询。
- 396 组 Unicode/畸形实体/href/分组/重复链接的新旧书签解析输出一致。
- 新增串行顺序、拒绝后停止、迭代器关闭、零值结果、undefined 成功结果、失败后暂停、流取消、发布 argv 与发布版 userscript 来源检查用例。
- Android API35 模拟器完成 Provider 关闭导出后的前线组件系统添加；Android 单测 XML 报告 30 项、0 失败/错误，Lint/APK 构建及严格依赖校验通过。其余 Provider 按相同系统服务契约和单测核验，未宣称六种均完成设备端人工交互。
- 真实 Chromium 页面验证：方向键移动搜索结果、Esc 收起；390px 视口的首页/设置无横向溢出且 hidden 区域均 display:none；390px 弹层背景按钮命中、关闭成功，减少动态效果下 backdrop animation 为 none。
- 浏览器最小化时截图接口不可用，因此上述为真实浏览器 DOM、布局几何与交互验证，未宣称完成图片级视觉回归。

## 远端复扫跟进

`cd57181` 的 SonarCloud 质量门和 Cloudflare 构建通过，但报告 8 条新增可维护性问题：LocalApp 的两处联合类型别名、简介补全回调嵌套、CSV for 计数器赋值，以及四处取反比较。已分别使用具名视图/模块类型、具名简介更新方法、显式 CSV 游标循环及直接比较运算修正。CSV 另以 196 组引号/换行/Unicode/畸形输入对照原实现，结果与错误一致；ESLint、类型检查及相关 Web/运维测试复验通过。最终修正仍需扫描新的提交。

最新运行的实际测试数量与远端检查结论记录在 PR85 描述中；主线历史关闭数仍以合并后的完整复扫为准。
