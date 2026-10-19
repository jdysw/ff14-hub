# 钓鱼中心：界面、数据复用与发布说明（2026-10-19）

## 当前功能与界面入口

- 系统「设置 → 钓鱼手账」及首页钓鱼入口：**无需连接工作空间**即可查询公开鱼类目录与天气窗口；工作空间仅用于个人钓获、收藏及数据同步。
- 若当前工作空间已启用钓鱼手账模块，可直接使用现有 `caught`（钓获）、`pinned`（收藏）、`alarm`（提醒偏好）字段级持久化与既有鱼糕导入/导出。其他场景仅只读，页面不尝试写入。
- 区服默认国服，但国服与国际服的真实数据仍须独立导入、校验；空目录有明确提示，不以测试鱼伪装真实规则。
- 筛选：鱼王/鱼皇/普通鱼、鱼名、24/72/168 小时、当前进行中、未来 24 小时即将开放、进度状态；排序优先进行中，其次按本页近期窗口。
- 展示：实时 ET、窗口距离开放/结束、当地时间与 ET 对照、天气链及候选状态、规则详情与原始来源链接。
- **精确性边界**：后端保持每页 30 条，窗口计算只针对本页；「当前/即将」统计和进度筛选明确限制在当前页。不能将候选窗口表示为已保证钓获。

## 复用已有开源项目（不复制一套客户端）

| 项目 | 复用方式 | 注意 |
|---|---|---|
| [node-eorzea-weather](https://github.com/eorzea-weather/node-eorzea-weather) | 仓库现有 MIT 改写的天气目标算法，继续沿用 | 保留 `THIRD_PARTY_NOTICES.md` 署名 |
| [FFX\|V Fish Tracker](https://github.com/icykoneko/ff14-fish-tracker-app) | 借鉴窗口排序/条件字段；**新增离线数据转换器**处理其 `js/app/data.js` | 不嵌入整站或运行上游 JS；代码 MIT 不自动授予游戏数据再分发权限 |
| [FFXIV Teamcraft](https://github.com/ffxiv-teamcraft/ffxiv-teamcraft) | 参考鱼类记录和用户状态分离 | 不引入 Angular / NGRX 运行时 |
| [AquaTrace](https://aquatrace.ojigure.net/) | 参考「NOW / 即将开放 / 未完成」的浏览层级 | 不复制界面素材 |
| [鱼糕](https://fish.ffmomola.com/#/fishing) | 保留既有鱼糕三集合与 WebDAV 客户端同步设计 | 不抓取私有 WebDAV 密钥；国服鱼类事实必须另行核验 |

## 新增：国服候选数据接入及发布（2026-10-19）

- `scripts/ops/refresh-fish-catalog.sh` 自动下载指定 Git 提交对应的国际服 Fish Tracker 数据和国服 datamining 的 `Item`、`FishParameter`、`Weather`、`FishingSpot`、`PlaceName` CSV。
- `prepare-fish-tracker-import.mjs` 转换原始规则；`prepare-fish-cn-import.mjs` 按真实物品 ID 与国服鱼类表求交集，翻译鱼名和天候/钓场。找不到映射的记录会被跳过，不会拿国际服鱼冒充国服鱼。
- 国服规则来源是 **国服物品身份数据 + 国际服社区时间/天气规则**。由于社区规则尚未逐条与国服验证，记录为 `unverified` 且列出跨服来源，页面只能称为「候选窗口」，不能视为百分百准确。
- CI 先执行无凭证 dry-run 的双方数据适配和完整 Schema 校验；主分支通过 CI 且真正部署后才由发布流水线分批 Upsert 两区服 D1 目录，保留已有用户的钓获/收藏/闹钟字段。**不会从浏览器收集任何 WebDAV 凭证**。
- CI 使用上游具体 commit SHA 防止构建过程中源文件不一致。数据授权仍然标为 `unverified`；如第三方的授权限制不允许再分发，应立即停止对应数据自动导入并改为用户侧授权获取。

## 国际服：本地准备可导入的数据

下面是**构建期离线操作**，不会自动抓取网站或自动部署生产数据库。

1. 到 [上游 GitHub](https://github.com/icykoneko/ff14-fish-tracker-app) 确定一个 commit，并下载该 commit 对应的 `js/app/data.js`。校验来源与版本。
2. 将该文件在项目本机执行转换（将 `<sha>` 换成实际 commit SHA，不要将占位符原样执行）：

   ```bash
   node scripts/prepare-fish-tracker-import.mjs ./data.js global <sha> ./fish-global.json
   node --experimental-strip-types scripts/prepare-fish-import.mjs ./fish-global.json ./fish-global.sql
   ```

3. **先审查** `fish-global.json` 中每个来源版本、天气链、钓点、条件及遗漏统计，再决定是否导入测试 D1：

   ```bash
   pnpm run db:migrate:local
   pnpm exec wrangler d1 execute DB --local --file ./fish-global.sql
   ```

4. 通过公开 `GET /api/v1/fish?region=global&category=rare` 和 `GET /api/v1/fish/windows?region=global&hours=24&fishId=...` 回归校验；核对历史鱼窗以后，再审议生产迁移。

转换器仅提取具有可映射鱼名、钓点与完整天气概率的鱼类；跳过缺少依赖字段的记录并打印数量。它不会执行数据文件中的代码，不增加运行时第三方依赖。对于 `bestCatchPath`、鱼识、传承录、前置鱼等特殊条件，保留结构化说明；因为尚未逐条核验，全量转换默认 `unverified` / `incomplete`、`authorizationStatus: unverified`，所有窗口是**候选**。上游 `bigFish` 只映射为「鱼王」，没有可靠定义的「鱼皇」不会擅自猜测。

**禁止把国际服源 JSON 改 region 字段后灌入国服。** 国服需要匹配其补丁版本、游戏内 ID、中文鱼名及天气规则的独立来源。国服可继续使用既有 `fishDataBundleSchema` 和 `prepare-fish-import.mjs` 流程导入经过核验的数据。游戏数据再分发授权状态不明确的情况下，不把完整源数据复制进仓库或自动部署生产。

## 已有能力保持不变

- 服务端窗口引擎、天气算法和 168 小时计算上限；
- D1 区服隔离、个人进度修订/幂等写入、模块开关；
- 既有鱼糕文件导入/导出与提醒管理模块（设置提醒偏好与实际通知投递是不同动作）。

## 尚待完成（不可误报已完成）

- 国服鱼王/鱼皇规则的逐条核验、完整覆盖与真实窗口历史验证（现阶段仅自动产生候选规则）；
- 鱼糕油猴脚本与 WebDAV 实时自动双向同步的端到端联调；
- 进一步实现跨页的全目录可钓排序和全局进度筛选；
- 国际服数据授权核实、生产环境导入和上线验证。

测试：`pnpm run typecheck && pnpm run test && pnpm run test:ops && pnpm run build`。实际结果以 CI 为准。
