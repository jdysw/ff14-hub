# FF14 Hub SonarCloud 积压问题整改追踪（2026-10-24）

> 基线：`main@599d0d4dfd44adfeb0d4cc1f27bc0029fea0beed`；SonarCloud 项目 `jdysw_ff14-hub`。
> 所有阶段统一提交至 `fix/sonar-backlog-20261024`，并通过同一个 PR 审查。不要直接改动主线或其他开发工作区。

## 基线与验收方法

- SonarCloud Issues API：`GET /api/issues/search?componentKeys=jdysw_ff14-hub&ps=300&p=1..3&issueStatuses=OPEN,CONFIRMED`，合计 **648** 项。
- 按软件质量的影响次数：可维护性 **605**、可靠性 **87**、安全性 **17**。一项问题可能同时影响多个维度，因此相加可超过 648。
- 高频规则：`typescript:S3358` 108、`typescript:S2681` 57、`typescript:S6819` 54、`css:S4666` 41、`typescript:S9382` 33、`javascript:S9382` 33、`javascript:S3358` 30。
- 集中分布文件：`FishingBoard.tsx` 70、`fishing-crosscheck.mjs` 28、`home-cards.css` 24、`LocalApp.tsx` 19、`calendar-feed.ts` 18。
- **验收标准**：SonarCloud 在 PR 最新提交上重新扫描、逐一确认问题消失且无新增 High/Blocker；ESLint、TypeScript、现有单测、运维检查与构建通过。仅改状态、降低 Quality Gate、隐藏规则和变更测试预期以规避缺陷均不计入修复。

## 第一批：可靠性与安全边界

- [x] 消除排序隐式比较：D1 就绪报告、迁移基线、鱼类海钓时间、活动分类、Shell 数据导入脚本。
- [x] S3 SigV4 签名头排序改为**显式字节序比较器**，保留协议要求的原有顺序，不使用语言环境排序。
- [x] D1 只读工具在启动 Wrangler 之前验证环境、执行模式、四条允许的 SQL，并新增拒绝恶意参数的测试。
- [x] Service Worker 只接受同源窗口 Client 的 postMessage，并新增拒绝外域消息的测试。
- [x] 以上变更已通过工作区 ESLint、TypeScript、相关 Web 测试及运维测试。
- [ ] **待 SonarCloud PR 扫描回报**：确认这些改变真正消除了对应规则的告警；代码层的测试通过不代表 SonarCloud 已确认关闭。
- [ ] Android 小组件 `xml:S5322`（6 项）需结合系统广播契约与接收器实现核实，不得盲目设置 `exported=false`。
- [ ] CLI `jssecurity:S8705` / `S8707` 中仍需单独核对实际输入来源、构建环境及测试契约。

## 第二批：S2681 控制流可读性与稳定性

- [x] 显式化公开活动缓存、导航目录、管理员游戏数据、目录分类别名、鱼类目录与通知凭证等路径的条件语句，保持条件外语句的原有执行时机。
- [x] 将鱼糕同步 JSON 规范化的对象键排序改为显式原有字节序比较器，不改变序列化规则。
- [x] 移除 S3 签名头比较器的嵌套三元写法，避免引入新 S3358，同时保持 SigV4 字节序不变。
- [x] 第二批变更再次通过 ESLint、TypeScript 与全部项目单元测试。
- [ ] 以上整改仍需 SonarCloud 最新 PR 扫描确认，不应提前扣减历史 648 基数。

## 第三批：原生可访问性状态与条件表达式

- [x] 将管理员、日历、同步、通知、待办等页面的纯文本状态信息由显式 `role="status"` 替换为原生 `<output>`；沿用已有 className，明确块级布局，保留屏幕阅读器状态语义。
- [x] 首页展示编辑器的三态布局说明改为类型约束的映射表，拆除嵌套三元表达式；分类编辑器的条件跳过和提前返回增加明确代码块。
- [x] 为首页展示编辑器补充原生 `status` 角色、切换布局后的文案验证。
- [x] 本批修改通过 ESLint、TypeScript、全量项目单元测试和运维测试（第二批后的基线；新增测试单独复验通过）。
- [ ] 尚有部分含按钮或多段结构的 `role="status"`，需结合标签语义与页面布局单独处理，不能无条件替换。
- [ ] 待 SonarCloud 在本 PR 最新提交上复扫确认每项实际消除。

## 第四批：S3358 嵌套条件拆解与逻辑等价

- [x] 后台 `ContentLifecycle` 的 HTTP 错误码采用受控映射，保留 401/409 与未知失败的原有提示。
- [x] `BackupStatusLine` 使用显式分支确定状态描述，不改变恢复时间追加规则。
- [x] 搜索匹配分值与钓鱼鱼窗排序分支拆开，维持此前的优先级。
- [x] Worker 中稳定 JSON 对象键排序改成显式 UTF-16 比较分支，避免 `localeCompare` 改变签名/序列化语义。
- [x] 本地通知投递状态与 HTTP 中间件 5xx/4xx 返回分支拆解，保留重试与错误隐私策略。
- [x] ESLint、类型检查、全量项目测试 605 项、运维专项 56 项，以及 Web/Worker 构建通过。
- [ ] SonarCloud 最新 PR 扫描确认之前，不计为已清零问题。

## 第五批：高风险输入边界、可访问性与 CSS 规则整理

- [x] 本地冒烟脚本仅允许 loopback HTTP（127.0.0.1、[::1]、localhost）作为探测目标，不允许含路径/凭证/查询的任意 URL；日志采用 JSON 字符串转义和长度限制，新增 2 条回归测试。
- [x] 官方活动快照生成器将输出目标限制在仓库 `.wrangler` 下的安全 `.sql` 文件名，独占创建且禁止目录遍历，新增安全目标验证。
- [x] 全站纯文本状态从 `role="status"` 迁移到原生 `<output>`，复杂 PWA 提示保留结构并使用 `aria-live`。关联样式与组件回归均通过。
- [x] 将首页卡片、后台、活动中心、鱼窗、现代首页与 Field Guide 样式中的重复选择器合并至统一声明位置，保留窄屏媒体规则和最终生效的属性值。
- [x] 完整检查：项目测试 605、运维测试 59（包括新增冒烟安全专项测试 2），ESLint、TypeScript、Web/Worker 构建通过；冒烟安全测试已纳入 `pnpm run test:ops`。
- [ ] **Android 6 项导出组件问题**：系统小组件需接收系统 `APPWIDGET_UPDATE`，官方示例存在 exported=true/false 两种实践；在设备/模拟器验证之前不能简单关闭导出，仍待加固和动态验证。
- [ ] 样式合并的视觉等价性仍需针对实际部署分别核对桌面/窄屏；构建及单元测试通过不等于截图回归通过。
- [ ] 该批 SonarCloud 效果仍需最新 PR 扫描逐项核实，不得把原始 648 项直接扣减为声称已关闭的数量。

## 第六批：PR 新增问题与 Quality Gate 红线

- [x] 2026-10-24 `PR #84@d42684a` 已完成 SonarCloud 分析，新增代码有 **9 项** OPEN/CONFIRMED；Quality Gate 未通过，**新增代码安全评级 B（要求 A）**。PR 扫描结果与主线历史 648 项分开管理。
- [x] 冒烟脚本禁止将上游响应或异常文本记录到终端，仅输出固定诊断标志与计数，处理 `jssecurity:S5145` 的真实污染源。
- [x] 搜索相关性评分、SigV4 比较器的单行条件分支加花括号，保持原排序语义。
- [x] 将鱼糕同步标准 JSON 的嵌套模板字符串分离构造，保持字节级序列化顺序；Service Worker 使用可选链处理来源缺失。
- [x] 管理员展示编辑器提取 `SubcategoryEditor` 独立组件，降低多层 JSX 与事件回调嵌套，保留分类迁移逻辑。
- [x] 以上改动通过 ESLint、TypeScript、项目测试 605 项、运维专项测试 59 项和 Web/Worker 构建。
- [ ] 必须等 PR 最新提交再次分析，确认新代码 9 项是否确实消除、Quality Gate 回归通过；并继续解决 `main` 的 648 项历史积压。

## 第七批：主线遗留 S2681 条件控制流

- [x] 处理通知任务构建、后台续约、加密存储事务、本地备份进度、今日计划与钓鱼跨源审计等模块的含糊单行 `if`/`return`/`continue`/`break`，不改变原语句执行边界。
- [x] 针对高频规则 `S9382` 审查了 66 项 `await` 循环：其中存在顺序写入、重试间隔、限流/租约等必须保持串行的场景，不能不加区分地 Promise.all，否则会引入并发错误；需要逐模块配套测试后重构。
- [x] ESLint、TypeScript、项目测试 605、运维测试 59 项和 Web/Worker 构建通过。
- [ ] 等待 PR 最新扫描和主线全量扫描确认确切关闭数量，继续解决其他规则。

## 第八批：钓鱼鱼窗的条件分支与视图文案

- [x] 将 `FishingBoard.tsx` 中高嵌套的鱼窗筛选、鱼种筛选、时间展示、候选窗口文案、资料来源说明、搜索占位符等提取为显式分支或可复用纯函数。
- [x] 维持首页关注/开放/未来鱼窗的筛选优先级和 `WindowPhase` 执行路径，过滤与排序仍对完整目录进行而非预先截断。
- [x] ESLint、TypeScript 与相关 Web 单元测试全部通过；等待 PR 最新 Sonar 扫描逐条确认。

## 第九批：PR 复扫后的剩余告警

- [x] `PR #84@dd1c710` 的 SonarCloud Quality Gate 已通过，但仍报告 2 条新增可维护性问题（`typescript:S6759` 和 `S2681`）；**通过质量门不等于历史问题清零**。
- [x] 为新增的子分类组件 Props 添加 readonly 类型约束；为 SigV4 会话令牌的赋值条件补足明确代码块。
- [x] 再次通过 ESLint、TypeScript、项目测试 605、运维专项 59 及 Web/Worker 构建。
- [ ] PR 最新提交须重新完成 SonarCloud 扫描，才可认定上述 2 项已经消除；主线历史积压继续整改。

## 第十批：最新 PR 扫描回报与可维护性回归（2026-10-24 20:19 CST）

- [x] 重新读取 SonarCloud `main@599d0d4` 的完整 `OPEN,CONFIRMED` 列表（分页 300×3），仍为 **648 项**；这是尚未合并的主线基线，不能按 PR 增量扫描数字误判为全部历史已清零。
- [x] `PR #84@a727369` 的 2026-10-24 12:08 UTC 扫描出现 **6 项**新增代码问题：`FishingBoard.tsx` 的 `S4323` 1 项、`S3358` 4 项、`S4624` 1 项；当时 Quality Gate 为 **OK**，但仍不满足零问题验收。
- [x] 将鱼窗小时数类型统一为 `WindowHours`，用独立状态文案函数取代嵌套三元和模板字符串；首页鱼窗的加载、错误、空状态、列表改为互斥条件分支。新增纯函数回归测试覆盖 5 种文案。
- [x] 拆分首页模块排版的列选择与末尾通栏决策，保留原有 48/96px 阈值；增加复用既有列布局和单模块通栏测试。
- [x] 将首页活动状态标签与倒计时目标独立计算、提取结束时间显示组件；增加“即将结束”回归断言。
- [x] S3 签名头构造移除无意义的 `void` 操作，复制签名头后删除浏览器禁止发送的 `host`，既有 SigV4 签名与禁发头测试通过。
- [x] 在独立 worktree 运行完整 `pnpm run verify`：鱼糕脚本及 Android 规则校验、D1 基线守卫、ESLint、TypeScript、项目测试 **607 项**、运维测试 **59 项**、Web 构建及 Worker dry-run 全部通过；`git diff --check` 待提交前复验。
- [ ] **本批代码必须提交到现有 PR #84 并等待 SonarCloud 分析该最新提交**，才能认定上述新增问题消除；Quality Gate 通过不代表 648 项历史问题清零。

## 第十一批：单行控制流清理（续）

- [x] 在后台历史数据路由、通知设备额度、鱼类目录、图鉴外特殊内容、鱼糕浏览器适配和 WebDAV 配置面板中添加明确条件控制块，保留原有返回值、错误与异步顺序。
- [x] 与同一 PR 并行提交的首页鱼窗分支修改分文件合并，沿用已有钓鱼文案重构与新增加的纯函数测试，未覆盖其改动。
- [x] 此批改动在独立 DevSpace 工作区通过 ESLint、TypeScript、605 项项目单测、59 项运维测试、Web/Worker 构建；与并行提交的整体验证仍须以最新 PR 的 CI/SonarCloud 为准。
- [ ] 继续按照主线 648 项基线核验历史遗留问题，PR 最新分析单独核对新增问题。

## 第十二批：跨工作区集成验收与生成物同步

- [x] 基于 `PR #84@fc5230b` 的独立全新 Git Worktree 执行完整 `pnpm run verify`，先发现鱼糕适配器修改后生成物未更新：`check:fishcake-script` 失败，属于真实构建一致性回归。
- [x] 执行项目自身 `pnpm run generate:fishcake-script` 重新生成 `apps/web/public/fishcake-sync.user.js`；没有更改检查程序或跳过断言。
- [x] 重新执行 `pnpm run verify`，鱼糕脚本、Android 规则、D1 基线、ESLint、TypeScript、项目单测 607 项、运维测试 59 项及 Web/Worker 构建均通过。
- [ ] 后续并行提交仍需以新的 PR HEAD 复扫与验证，尤其不能将 `Quality Gate OK` 误解为历史 648 项清零。

## 第十三批：历史脚本层控制流与鱼类审核规则（2026-10-24）

- [x] 使用 SonarCloud 主线 `OPEN,CONFIRMED` API 确认历史基线 **648 项**；其中 `javascript:S3358` 30 项（跨源审计相关文件 19 项），`javascript:S2681` 22 项（其余还包含 TypeScript S2681 57 项）。该数量属于主线，**本批提交须通过新的目标分支分析核验实际关闭量**。
- [x] 拆分 `fishing-special-content.mjs` 的专项分类条件，保持宇宙探索、重建、关联物品、任务、收藏品及图鉴外类别原有优先级。
- [x] 拆分 `fish-intuition-audit.mjs` 中前置鱼核对状态与鱼识审计总体状态；`fish-requirements.mjs` 保留数组与映射输入的既有分支语义。
- [x] `fishing-crosscheck.mjs` 对鱼饵对照、技能标准化、精度差异、前置依赖进行显式分支控制，明确原先始终追加交叉核对字段的行为。
- [x] `audit-fishing-cross-sources.mjs`、`audit-fish-intuition.mjs` 和鱼糕页面注入脚本补全条件控制块；**仅更新页面脚本源文件后，通过现有生成器同步更新油猴分发脚本**，避免生成物漂移。
- [x] 在独立工作区完成 `pnpm run verify`：鱼糕分发脚本检查、Android PVP 规则、D1 基线、ESLint、TypeScript、项目单测 **607**、运维专项 **59**、Web/Worker 构建全部通过。
- [ ] 本批增量 PR 的 SonarCloud 扫描和历史主线问题差异仍须复核；不得用 PR 的 new-code 0 代替历史 648 清零。

## 第十四批：跨来源核对的证据判定拆分（2026-10-24）

- [x] 对 `fishing-crosscheck.mjs` 中游戏钓法、鱼类稀有度、原始钓点证据、Teamcraft 诱鱼技能以及审计结果状态进行纯辅助函数封装，移除密集嵌套三元表达式（`javascript:S3358`）。
- [x] 保留钓点证据的原始有序集合：鱼糕候选钓点沿用来源顺序，Teamcraft 候选钓点沿用既有数值排序；缺失来源继续返回 `null`，不能将无证据误判为一致。
- [x] 验证 `pnpm run verify`（项目单测 607、运维专项 59、ESLint、类型检查、鱼糕脚本/Android/D1 守卫以及 Web/Worker 构建）。
- [ ] 需要 SonarCloud 对对应 PR 最新 SHA 重新分析，确认历史告警实际减少；主线仍未合并，因此其旧扫描不会即时减少。

## 第十五批：导航排序稳定性与目录修改分支（2026-10-24）

- [x] `nav-projection.ts` 的导航 ID、标题和收藏优先级排序去除多层三元：保留 UTF-16 既有排序及稳定的 ID 兜底，不改用 localeCompare 造成跨设备排序差异。
- [x] `nav-catalog-decisions.ts` 明确目录 ID 比较器的三态返回；保持目录升级计划稳定顺序。
- [x] `directory-editor.ts` 将目录新增和乐观并发更新的条件 SQL 拆分，保留 `expectedRevision===0` 时仅 INSERT 的原有保证，数据库操作依旧串行。
- [x] ESLint、TypeScript、项目单元测试 607、运维专项 59、Web/Worker 构建及项目生成物检查全量通过。
- [ ] 新增代码质量门和历史问题总量需等待本 PR 最新扫描；禁止将主线旧扫描仍显示 648 解释为当前改动无效。

## 第十六批：PR 新增问题及历史 JS 嵌套条件（2026-10-24）

- [x] `PR #84@8f37973` 的 SonarCloud 完成分析：Quality Gate 通过，但有 **5 项**新增代码问题（`javascript:S3358` 1、`javascript:S7723` 2、`javascript:S9382` 2）。本批针对这 5 项作代码层修复，**关闭情况以最新 PR 复扫为准**。
- [x] `audit-fishing-cross-sources.mjs` 修复 `throw Error()` 写法，固定输入名单通过 `Promise.all` 读取并按原顺序关联；国服/国际服结果分别处理，保留输出先后顺序与文件名，不依赖不安全的动态路径。
- [x] `fishing-crosscheck.mjs` 将 Teamcraft 钓法判断、气象证据、海钓时段与审计状态拆成可读分支，特别保留 `undefined` 与 `null` 的既有行为差异。
- [x] `build-fishing-catalog.mjs` 拆分泳饵名称、普通/海钓/刺鱼分类与鱼类稀有等级的多层三元；保持国服数据、传说鱼、隐藏鱼的原有优先级。
- [x] 新增跨来源状态回归测试，明确证据一致、冲突、缺失与仅单来源的处理边界。
- [x] 独立工作区 `pnpm run verify` 全部通过：项目测试 **607** 项、运维测试 **60** 项（新增 1 项）、ESLint、TypeScript、鱼糕生成物/Android/D1 一致性检查、Web 和 Worker dry-run 构建。
- [ ] 尚待本 PR 最新提交完成 SonarCloud 扫描，按具体 issueKey 核对新增告警关闭、历史问题真正减少；不得把主线未合并的 648 项当作 PR 扫描数字。

## 第十七批：导航、活动与通知渠道条件判定（2026-10-24）

- [x] `nav-api.ts` 按明确优先级选择直接导入数组或导入包 `links`，不再使用嵌套条件表达式，并保留空输入的原有结果。
- [x] `calendar-feed.ts` 拆分国服活动起止日期的年份补全分支，继续区分显式年份、同年延续及无法确认的日期。
- [x] `notification-channel.ts` 根据 Server酱 / Resend 渠道分支构造请求并区分回执解析，不改变内容长度上限、跳转控制、重试状态或安全头。
- [x] `CalendarAdminPanel.tsx` 将隐藏、人工维护、恢复等后台状态文案及成功提示拆分为纯函数，保持原有提示语和顺序。
- [x] 再次执行完整 `pnpm run verify`：项目测试 607、运维专项 60、ESLint、TypeScript、Web/Worker 构建与生成物检查全部通过。
- [ ] 最新 PR 的 SonarCloud 扫描尚需复核；旧 `main@599d0d4` 仍记录 648 项历史问题，不代表已提交至 PR 的改动没有效果。

## 第十八批：旧版个人数据界面与运维脚本控制流（2026-10-24）

- [x] `DataManagementPanel.tsx`、`LocalNotificationPanel.tsx` 的异步重复操作保护、文件不存在提前返回与测试消息回执条件显式分组，维持原有导入/恢复副作用顺序。
- [x] `scripts/import-navigation.mjs` 将重复网站证据合并中的来源去重、别名追加分离，保留先入源顺序和已存在站点直接跳过的路径。
- [x] `scripts/e2e-local-personal.mjs` 明确弹窗存在时不重复打开鱼窗，后续检索原样执行；原端到端脚本未放宽断言。
- [x] 再次运行 `pnpm run verify`：项目测试 607 项、运维测试 60 项、ESLint、TypeScript、Web/Worker 构建与生成物一致性检查均通过。
- [ ] PR 最新 SonarCloud 复扫及基于当前完整工作树的历史问题对照未完成；本批改动不得宣称 648 项已清零。

## 第十九批：待办时间表达式与每日鱼窗汇总（2026-10-24）

- [x] 重新核查 SonarCloud 主线 648 项历史告警以及 PR #84 新代码 0 项的扫描结果；这两个指标不是同一个口径。
- [x] `TodoBoard.tsx` 的期限文案、通知连接状态移除嵌套三元和嵌套模板字符串；组件属性加 `Readonly`，并为天/小时/分钟与开始/逾期边界新增回归测试。
- [x] `TodayPlan.tsx` 将鱼窗异常、加载、结果渲染拆为明确的互斥状态，组件属性声明为只读。
- [x] `fish-digest.ts` 将活动结束汇总和两日鱼窗格式化抽出独立方法，保持北京时间日界限、候选提示、消息排序、推送去重及数据库操作顺序；修正数字分组表达式（`S7749`）；新增无订阅空汇总断言。
- [x] 在隔离的 PR HEAD 工作树执行完整 `pnpm run verify`：项目测试 609 项（Web 268、Worker 164、shared 154、engine 17、sync 6），运维测试 60 项，ESLint、TypeScript、Web/Worker 构建、生成物/Android/D1 校验通过；`git diff --check` 通过。
- [ ] **仅确认代码本地验证通过**。需要 SonarCloud 针对本批最新 PR 提交完成重新分析，确认新增问题仍为 0，并继续处理未解决的主线历史问题。

## 第二十批：国服活动 HTML 的线性安全解析（2026-10-24）

- [x] `worker/modules/events/calendar-feed.ts` 用 `indexOf` 单向扫描取代 3 处对外来官方页面中 `<script>` / `<style>` 代码区块的回溯正则，保留大小写不敏感与 `<scripted>` 等相似标签不被剔除的语义。
- [x] 缺少闭合标签时立即退出当前标签扫描，避免大量不完整 `<script>` 导致反复检查相同后缀；输入上限、固定官方域名、日期判定不变。
- [x] 新增混合大小写代码区块、相似标签、超长不完整标签和可用时间提取的回归测试；不将脚本内部伪造的活动日期当作真实活动时间。
- [x] 再次执行完整 `pnpm run verify`：项目测试 611 项（Web 268、Worker 166、shared 154、engine 17、sync 6）、运维测试 60 项、ESLint、TypeScript、Web/Worker 构建、Android/D1/鱼糕一致性检查均通过。
- [ ] `AndroidManifest.xml` 6 项导出接收器安全问题仍需真机/模拟器功能测试。Android 官方示例既出现 `exported=true`（https://developer.android.com/codelabs/glance），也出现 `exported=false`（https://developer.android.com/develop/ui/compose/glance/create-app-widget），不在无设备验证情况下机械修改以求消警。
- [ ] 需等 SonarCloud 对 PR 最新 SHA 复扫，确认本批相应历史告警减少且没有新增告警；历史 648 项尚未完成全量验收。

## 后续批次（同一个 PR）

1. **P0 安全与可靠性**：清理未完成的 High/Blocker、消息来源、路径边界及正则复杂度问题。
2. **P1 控制流与可维护性**：拆分 `S3358` 嵌套三元、`S2681` 控制流歧义；同时补充必要回归测试。
3. **P2 语义与样式**：修正 `S6819` 可访问性语义、`S4666` CSS 规则和其他风格问题。
4. **P3 全量回归与复扫**：测试、构建、SonarCloud 逐规则归零；对确实不能按建议机械修改的代码保留具体技术论证，不以批量忽略代替整改。

**进度声明**：本文件是增量整改台账，不表示 648 项均已解决。最终剩余数量必须以同一个 PR 的 SonarCloud 最新分析为准。
