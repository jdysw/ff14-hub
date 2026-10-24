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

## 后续批次（同一个 PR）

1. **P0 安全与可靠性**：清理未完成的 High/Blocker、消息来源、路径边界及正则复杂度问题。
2. **P1 控制流与可维护性**：拆分 `S3358` 嵌套三元、`S2681` 控制流歧义；同时补充必要回归测试。
3. **P2 语义与样式**：修正 `S6819` 可访问性语义、`S4666` CSS 规则和其他风格问题。
4. **P3 全量回归与复扫**：测试、构建、SonarCloud 逐规则归零；对确实不能按建议机械修改的代码保留具体技术论证，不以批量忽略代替整改。

**进度声明**：本文件是增量整改台账，不表示 648 项均已解决。最终剩余数量必须以同一个 PR 的 SonarCloud 最新分析为准。
