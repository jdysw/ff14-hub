# FF14 Hub 第三方数据许可核验与开源许可证方案（2026-10-24）

> 结论：原创程序代码建议在权利清理后采用 **MIT**，但**不得**直接以 MIT 覆盖鱼糕观测、数据挖掘源或 SQUARE ENIX 游戏素材；当前不创建有效的根目录 `LICENSE`、不修改 `package.json` 的 `UNLICENSED`。本文件为发布准备与待确认清单，不是法律授权，也不是已完成许可清理的证明。

## 1. 当前许可证状态

- 仓库根目录没有 `LICENSE` / `LICENSE.md`；根 `package.json` 当前为 `"license": "UNLICENSED"`。
- `THIRD_PARTY_NOTICES.md` 和 `third_party/*-LICENSE` 已保留多项依赖和借鉴代码的来源及许可，方向正确。
- 公开 GitHub 仓库 ≠ 自动授予开源许可。按照 [GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility) 及 [licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)，无许可证原则上保留原版权人权利。

## 2. 已核对的数据与代码来源

| 来源/资产 | 仓库中的用途及位置 | 核验结果 | 发布判断 |
| --- | --- | --- | --- |
| 项目原创 TypeScript / React / Worker 代码 | `apps/`、`worker/`、`packages/`、`scripts/` | 未发现根目录的授权文本；需核验所有贡献者的权利 | 原创部分推荐 MIT，须由版权持有人明确确认 |
| icykoneko FF14 Fish Tracker | `scripts/ops/refresh-fish-catalog.sh` 上游 `data.js`，`third_party/fish-tracker-LICENSE.txt` | GitHub 仓库许可证显示 MIT；但 FFXIV 游戏数据权利并非必然由应用 MIT 覆盖 | 保留源版本与署名，区分算法代码、作者整理成果与游戏原始数据 |
| FFXIV Teamcraft | `data/fishing-sources.json` 记录修订版本；`third_party/teamcraft-LICENSE.txt` | 上游 `package.json`、README 显示 MIT | 保留版权及许可声明；游戏资料仍独立审查 |
| node-eorzea-weather / Bootstrap Icons / Web Push | `THIRD_PARTY_NOTICES.md` 与 `third_party/` | 已有 MIT 等通知与许可文本 | 当前保留机制合理，发布前核对实际使用版本 |
| thewakingsands/ffxiv-datamining-cn | 国服 `Item`、`FishParameter`、`Weather`、`FishingSpot`、`PlaceName` CSV，经脚本转换为目录 | GitHub 项目 `license` 元数据为 `null`，未查到明确的可再分发许可；同时涉及游戏原始资料 | **待确认（阻断）**：不能因公开可下载就视为获得 MIT 或重分发许可 |
| 鱼糕 V2 / Fishcake | `data/fishing-fishcake-observations.json`（约 4.8 MB）、`data/fishing-full-crosscheck.json`（约 11.9 MB）、鱼糕版本标识 | 检索未找到可核验的鱼糕数据重分发授权；仍需判定是独立事实记录、作者原创数据结构，还是复制作品性内容 | **待确认（阻断）**：联系权利人或使用独立可验证的数据构建流程 |
| 前端鱼类公开快照 | `apps/web/public/fishing/catalog-cn.json`（约 2.7 MB）、`catalog-global.json`（约 1.5 MB） | 由上游资料与项目转换构建；开源代码许可不能自动为快照生成数据授予许可 | **待确认（阻断）**：按字段追踪数据来源与再分发范围 |
| 导航网站目录与中文介绍 | `data/navigation/catalog.json`、来源记录 `data/navigation/import-report.json` | 目录引用网址及部分由站点汇集整理的字段；记录来源并不等于拥有复制文本许可 | 审查文本和标志图片是否存在需许可的搬运 |
| SQUARE ENIX / FFXIV | 游戏内名称、图文、数据和商标 | 官方游戏素材使用政策与开源软件 MIT **不同**；存在非商业、版权标记等限制且各地区政策不完全相同 | 必须按适用地区条款执行，不应放进项目原创 MIT 授权范围 |

官方参考：

- [FFXIV North America Materials Usage Policy（2026-10-14 版）](https://support.na.square-enix.com/rule.php?id=5382&policy=update&tag=authc)；[FFXIV Europe Materials Usage Policy（2026-10-14 版）](https://support.eu.square-enix.com/rule.php?id=5383&la=2&tag=authc)。应根据用户账户及使用区域核实真正适用版本。
- [icykoneko/ff14-fish-tracker-app](https://github.com/icykoneko/ff14-fish-tracker-app)、[ffxiv-teamcraft/ffxiv-teamcraft](https://github.com/ffxiv-teamcraft/ffxiv-teamcraft)、[thewakingsands/ffxiv-datamining-cn](https://github.com/thewakingsands/ffxiv-datamining-cn)。

## 3. 确定的许可证技术方案（等待权利人批准后执行）

**推荐：原创代码 MIT + 第三方代码保留原许可证 + 第三方/游戏数据独立授权与数据声明。**

- 根目录 `LICENSE` 仅在确认版权归属和数据边界之后加入：以 MIT 授权仓库贡献者有权许可的原创程序代码；对于第三方资产，原许可优先，不能通过一句“排除”重许可别人的权利。
- 同时新增清晰的 `DATA_NOTICES.md` 或等效说明，逐项列出数据文件、上游修订 SHA、来源 URL、许可证明与授权范围；对无法确认权利的数据采取不公开、重生成或获取授权。
- `README.md` 明确项目为非官方社区工具，说明 SQUARE ENIX 商标/游戏资料的权利归属，按适用政策保留 `© SQUARE ENIX` 和其他必要标记。
- 完成后将 `package.json` 的 `license` 从 `UNLICENSED` 改为经批准的 `MIT`；不可在实际未获得开源授权时提前修改。
- `MIT` 授权本身允许商业使用，而游戏素材的许可可能禁止商业利用：必须通过单独的数据/素材权利说明防止用户误以为游戏内容也被 MIT 授权。

不推荐直接对现有仓库连同全部历史提交、鱼类 JSON 与页面快照一并贴 MIT：**根目录出现 MIT 不会清洗历史第三方版权问题**。

## 4. 发布前可执行清理方案

1. 整理每个公开数据文件的来源字段级清单，核实 Fishcake 观测中包含的哪些内容属于独立事实、哪些属于原作者有版权的编排、说明文字、提取数据库。
2. 对没有明确许可的源数据取得权利人授权（保留许可证、邮件或可归档声明），或使用有明确可再分发授权的替代数据。
3. 对历史引入的未经授权大文件，视具体权限选择**新的干净历史公共仓库**或经确认的 Git 历史改写；只删工作树文件不足以防止旧提交公开。
4. 完成数据清理、密钥全历史检查及安全验收后，让权利持有人核准原始代码的 MIT 版权声明；随后再增补根 `LICENSE`、`DATA_NOTICES.md` 和 README，并转为 public。

## 5. 当前决策

- 许可证方向：**MIT（原创代码，拟采用）**。
- 现阶段实际法律状态：**仍为 UNLICENSED**；不存在已生效的新授权。
- 数据再分发状态：**未完成清理，阻断整仓库公开**。
- 不删除数据，不清理 Git 历史，不执行仓库 visibility 变更，不轮换或读取真实密钥。
