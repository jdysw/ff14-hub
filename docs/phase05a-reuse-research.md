# 阶段 05A 复用调研：先检索、再决定是否复用（HUB-013～019、HUB-035）

- **状态**：调研完成（**只记录结论，不含实现**）
- **范围**：HUB-013 游戏数据 Adapter / HUB-014 ET+天气核心 / HUB-015 鱼类规则 Schema /
  HUB-016 未来窗口 API / HUB-017 钓鱼 Widget / HUB-018 三字段进度 / HUB-019 历史案例校验 / HUB-035 区服隔离
- **不在范围**：提醒规则、任务生成、Cron、Web Push、WebDAV（阶段 05B/06）；不部署、不创建远程资源
- **核实日期**：2026-10-18（所有「维护状态」以此日为准）
- **本仓库许可**：`package.json` 中 `"license": "UNLICENSED"`（私有仓库）→ 任何 copyleft 代码都**不能**引入

## 0. 核实方法与已核实的限制（诚实声明）

- 许可证一律**在仓库里核实**：通过 GitHub 仓库 API（`/repos/{owner}/{repo}`）读取 GitHub 依据仓库内 `LICENSE` 文件做出的 SPDX 判定，
  并在本机通过 `raw.githubusercontent.com` 抓取 `LICENSE` / `LICENSE.txt` **原文首行与版权行**（脚本化核对，未在本文件粘贴第三方代码）。
- 维护状态依据：`pushed_at`（最近提交）、`/releases/latest`（最近发布）、`archived` 标志，均来自仓库自身的 API 响应。
- **限制 1**：`cdn.jsdelivr.net` 与 GitHub 的 HTML blob 页面在本环境不可用（拉取失败/仅返回导航框架），因此许可证文本统一走 `raw.githubusercontent.com`。
- **限制 2**：`xivapi/ffxiv-datamining` 的 `csv/cn` 是 git submodule（`mode: 160000`），我**没有**直接解析 `.gitmodules` 确认其远端 URL，
  只确认了 `csv/` 下存在 `cn/de/en/fr/ja/ko/tc` 分语言目录；CN 数据源独立核实见 §3.2。
- **限制 3**：站点（非仓库）条款、Square Enix 的数据再分发授权**没有**可核对的公开声明 → 见 §4，一律标 `unverified`。
- 凡是我没有真实打开核对的项，本文件标 `unverified`，不写「已验证」。

---

## 1. 候选总表（逐条可核对）

| # | 仓库 / 站点 | 许可证（仓库内核实） | 维护状态（2026-10-18） | 语言/运行时 | 数据来源 | 可复用范围 | 建议 |
|---|---|---|---|---|---|---|---|
| 1 | [icykoneko/ff14-fish-tracker-app](https://github.com/icykoneko/ff14-fish-tracker-app)（站点 <https://ff14fish.carbuncleplushy.com>） | **MIT**（`LICENSE`：`Copyright (c) 2019 icykoneko`） | 活跃：last push 2026-10-12；无 release（API 404）；未 archived | 浏览器 JS（rollup + rxjs），无构建期依赖负担 | SaintCoinach/datamining 抽取 + Fish'cord 社区人工维护（见其 `README.md` 数据更新步骤） | ET/天气算法、鱼类规则字段模型、窗口 UI 思路（整套前端不可直接用） | **直接适配**（MIT，需保留版权与许可声明） |
| 2 | [ffxiv-teamcraft/ffxiv-teamcraft](https://github.com/ffxiv-teamcraft/ffxiv-teamcraft) | **MIT**（`LICENSE`：`Copyright (c) 2017 Flavien Normand`） | 活跃：v11.4.32（2026-10-13），last push 2026-10-16；未 archived | TypeScript（Angular/NGRX/Electron，体量大） | 自有数据管线 + datamining + 社区 | 钓鱼状态/规则建模（`apps/client/src/app/modules/fish-train/*`、`fishing-bait`、`eorzea`）、过滤 UI 思路 | **直接适配（算法/建模）+ 参考规格（结构）** |
| 3 | [eorzea-weather/node-eorzea-weather](https://github.com/eorzea-weather/node-eorzea-weather) | **MIT**（`LICENSE`：`Copyright (c) 2018 Lily Cartelet`） | last push 2026-10-16（仍提交）；最近 release v3.2.0（2021-05-27）；未 archived | TypeScript（npm 包） | 游戏内天气规则 + 手工整理的 `chances.ts`/`zones.ts` | ET↔地球时间、天气周期与概率表、`src/__tests__` 少量测试 | **直接适配**（ET/天气核心）；测试向量偏少需自建 |
| 4 | [Asvel/ffxiv-weather](https://github.com/Asvel/ffxiv-weather)（站点 <https://asvel.github.io/ffxiv-weather/>） | **MIT**，但文件名为 `LICENSE.txt`（GitHub 检测 MIT；`LICENSE` 本身 404，已核实变体） | last push 2026-07-28；未 archived | TypeScript（前端） | 游戏内天气规则 | 天气查询/预报实现与 UI 结构 | **参考规格** |
| 5 | [ClassicRagu/xivweather](https://github.com/ClassicRagu/xivweather)（npm `xivweather`） | **仓库无 LICENSE 文件（404）**；npm `package.json` 元数据声明 `"license": "MIT"`（[registry 元数据](https://registry.npmjs.org/xivweather)） | last push 2026-07-18；无 release（404）；未 archived | TypeScript（npm 包，依赖 eorzea-weather） | 基于 eorzea-weather + 自生成天气文件（`ClassicRagu/WeatherGenerator`） | `getETWindow` / `findWeatherWindows` 等窗口枚举 API 设计 | **仅参考规格**（无仓库内许可证，不得直接拷贝代码） |
| 6 | [ufx/GarlandTools](https://github.com/ufx/GarlandTools)（站点 <https://garlandtools.org>） | **MIT**（`LICENSE`：`Copyright (c) 2018 Chris Faulhaber`） | **偏旧**：last push 2023-10-18；未 archived | JavaScript（前端 + 数据） | 自有数据管线（Clorifex） | 数据结构与“物品/鱼类详情”信息架构 | **仅数据源参考** |
| 7 | [ClayLivince/GarlandTools-CN](https://github.com/ClayLivince/GarlandTools-CN)（站点 <https://ffxiv.cyanclay.xyz/>）；旧 fork [Small-Miao/GarlandTools-CN](https://github.com/Small-Miao/GarlandTools-CN) | **MIT**（GitHub 检测 MIT；fork 自 ufx） | CN fork 活跃：last push 2026-05-31；Small-Miao fork 停在 2022-04 | JavaScript | 国服玩家维护的中文数据 | CN 名称/术语对照思路 | **仅数据源参考**（CN 命名来源线索） |
| 8 | [xivapi/SaintCoinach](https://github.com/xivapi/SaintCoinach) | **WTFPL**（`LICENSE`：`DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE, Version 2`） | last push 2025-10-27；最近 release tag `0b22b78`（2025-10-27）；未 archived | C# / .NET（离线工具链） | 客户端 EXD/EXH 解析（datamining 事实标准） | 数据抽取规格（哪些表、字段含义）；**不适合**当运行时依赖 | **参考规格 / 离线工具** |
| 9 | [xivapi/ffxiv-datamining](https://github.com/xivapi/ffxiv-datamining) | **未声明**：仓库无 `LICENSE`（404），GitHub `license: null` | 活跃：last push 2026-10-13；未 archived | 数据仓库（CSV） | 由 [XIVData Oxidizer](https://github.com/mattantonelli/xiv-data-oxidizer) 从游戏客户端抽取；`ex/` 归档各补丁 `ex.json` | 字段/表结构参考、补丁差异追踪方式 | **仅数据源参考**（见 §4） |
| 10 | [thewakingsands/ffxiv-datamining-cn](https://github.com/thewakingsands/ffxiv-datamining-cn) | **未声明**：无 `LICENSE`（404），GitHub `license: null` | 活跃：last push 2026-10-13；未 archived；首页指向仓库 wiki | 数据仓库（CSV，根目录平铺） | 国服客户端 EXD 导出（README/描述称自 4.45 起） | CN 表数据（**已核实存在** [`FishParameter.csv`](https://github.com/thewakingsands/ffxiv-datamining-cn/blob/master/FishParameter.csv)，约 380 KB，`Text` 列为中文） | **仅数据源参考**（CN 主数据源候选，条款 `unverified`） |
| 11 | [thewakingsands/cafemaker](https://github.com/thewakingsands/cafemaker) | **未声明**（`license: null`） | **已 archived**，描述明写 “NO LONGER MAINTAINED … SEE boilmaster” | PHP | CN 版 XIVAPI fork | 无（已被替代） | **不采用** |
| 12 | [ackwell/boilmaster](https://github.com/ackwell/boilmaster)（<https://v2.xivapi.com>）；CN fork [thewakingsands/boilmaster](https://github.com/thewakingsands/boilmaster)（branch `cn`） | **AGPL-3.0**（`LICENSE` 原文首行核实） | 均活跃（2026-10-14 / 2026-10-07）；未 archived | Rust | 服务端数据服务 | 仅作为**外部 HTTP 数据源**思路；代码受 AGPL 约束 | **不采用（不能拷入）** |
| 13 | [Natsukage/Fishers-Intuition](https://github.com/Natsukage/Fishers-Intuition) | **MIT**（`LICENSE`：`Copyright (c) 2022 Natsukage`） | 活跃：release v1.401（2025-12-18），last push 2025-12-18；未 archived | C#（Dalamud 插件，游戏内） | 国服/国际服钓鱼计时经验 | **CN 场景行为基准**（何时该提醒、窗口怎么显示） | **参考规格**（CN 差异佐证） |
| 14 | [NotNite/DistantSeas](https://github.com/NotNite/DistantSeas) | **AGPL-3.0** | last push 2026-05-04；未 archived | C#（Dalamud 插件） | 海钓表格（社区） | 海钓窗口/路线思路 | **不采用（不能拷入）** |
| 15 | [fae-industries/ffxiv-collect](https://github.com/fae-industries/ffxiv-collect)（原 `mattantonelli/ffxiv-collect`，站点 <https://ffxivcollect.com>） | **MIT**（`LICENSE`：`Copyright (c) 2019 Matt Antonelli`） | 活跃：last push 2026-10-05；未 archived | Ruby / Rails | 自有 + datamining | 收集度（含鱼类）展示与进度 UI 建模 | **参考规格** |
| 16 | [okuRaku/ff14-fish-tracker-app-data](https://github.com/okuRaku/ff14-fish-tracker-app-data) | **未声明**（`license: null`） | 停滞：last push 2025-08-12；未 archived | 数据仓库（JS/JSON） | 疑似 #1 的中文化数据 | CN 鱼名/字段对照线索 | **仅数据源参考**（许可证缺失，`unverified`） |
| 17 | [Latihas/LatihasExport](https://github.com/Latihas/LatihasExport) | **未声明**（`LICENSE` 404） | last push 2026-07-19；未 archived | C#（Dalamud 插件） | 读取游戏内钓鱼笔记 | 「导出到鱼糕」的三集合语义佐证（`completed`/`pinned`/`alarmFish`） | **仅数据源参考**（HUB-018 语义交叉验证） |

---

## 2. 检索不到可信来源的部分（不编造）

- **独立的「未来鱼类窗口 HTTP API」开源服务**：未找到可信来源。现有项目都把窗口计算放在**客户端**（#1 浏览器端、#2 Angular 客户端、#5 npm 包），没有可直接复用的服务端窗口 API 契约。
  → HUB-016 需自建契约（可借鉴 #5 的 `findWeatherWindows(start, end, consecutive, zone, weathers, nightOnly)` 函数形态，作为**规格**而非代码）。
- **官方 CN 鱼类规则数据集（含许可）**：未找到。CN 方向只有无许可证声明的 datamining 导出（#10、#16）与 AGPL 服务（#12）。
- **可再分发的历史窗口记录数据集**：未找到。社区窗口记录主要在论坛/群（如 Fish'cord，见 #1 README）与站点，**没有**明确的再分发许可 → HUB-019 的向量必须自建或标注 `unverified`（见 §6）。
- **Square Enix 关于 datamining 数据再分发的书面授权**：未找到（`unverified`）。#9 的 README 只说明抽取流程与感谢名单，**没有**任何授权语句。
- **#1 的自动化测试**：该仓库文件树（`git/trees?recursive=1`）中**没有**测试目录/测试文件（仅有 `.github/FUNDING.yml`，无 CI 工作流）→ 不能把它的实现当作「已验证」。

---

## 3. 按方向的结论

### 3.1 ET / 天气 / 窗口计算（HUB-014、HUB-016）

- **ET 换算**：#1 的 [`js/app/time.js`](https://github.com/icykoneko/ff14-fish-tracker-app/blob/master/js/app/time.js) 使用常量 `3600/175`（约 20.571 倍）在「地球毫秒 ↔ ET」之间换算；这是社区共识公式，MIT 下可直接改写。
- **天气周期**：#1 的 [`js/app/weather.js`](https://github.com/icykoneko/ff14-fish-tracker-app/blob/master/js/app/weather.js) 以 **8 ET 小时**为一个天气时段（以 UTC 小时对齐）、按区域的 `WEATHER_RATES` 概率区间取天气；
  #3 以 [`src/EorzeaWeather.ts`](https://github.com/eorzea-weather/node-eorzea-weather/blob/main/src/EorzeaWeather.ts) + `src/chances.ts` + `src/zones.ts` 实现同一族规则（MIT）。
- **结论**：ET/天气核心（HUB-014）**建议直接适配 MIT 实现并重写为 Workers 兼容的纯函数**（不得依赖 rxjs/Angular/DOM）；
  「未来窗口」枚举（HUB-016）按 #5 的函数形态自建，天气链（前置天气 + 当前天气）必须显式建模，不能只做「单点天气匹配」。

### 3.2 游戏数据抽取与版本记录（HUB-013）

- **国际服**：#9（无许可证）提供 CSV 与按补丁归档的 `ex.json`（补丁差异可 diff）；#8（WTFPL）是抽取工具事实标准。
- **国服**：#10（无许可证）是当前唯一活跃、包含**中文** `FishParameter.csv` 的公开国服表数据（已核实文件存在）。
  `xivapi/ffxiv-datamining` 的 `csv/` 下 `cn`/`ko`/`tc` 为 **submodule**（`mode: 160000`），说明国服/韩服/繁中数据由外部仓库提供——这与 #10 的角色一致。
- **结论（HUB-013）**：Adapter 必须记录 `source_url` / `source_version`（补丁号或仓库 commit）/ `fetched_at` / `verification_status` / `region`，
  并且**优先「构建期生成 + 记录出处」**而不是把整包游戏 CSV 提交进仓库（理由见 §4）。国际服与国服各自独立版本，**禁止混用**（HUB-035）。

### 3.3 鱼类规则与条件建模（HUB-015）

#1 的字段模型（[`private/fishDataTemplate.yaml`](https://github.com/icykoneko/ff14-fish-tracker-app/blob/master/private/fishDataTemplate.yaml) 与 `private/fishData.yaml`）是一份现成、可核对的**条件字段清单**：

`name` / `location` / `startHour` / `endHour` / `previousWeatherSet` / `weatherSet` / `bestCatchPath`（钓饵链路） /
`predators`（前置鱼）/ `tug` / `hookset` / `snagging` / `gig` / `folklore` / `fishEyes` / `patch` / `dataMissing`

- 统计核对（该文件内）：约 799 条带 `weatherSet`、667 条带 `previousWeatherSet`、659 条带 `predators`，且 **115 条 `dataMissing: true`**。
  → 直接支撑本项目的「无法验证的规则必须 `unverified`/`incomplete`」要求：**完整性本身就是数据的一部分**。
- #2 的 [`apps/client/src/app/modules/fish-train`](https://github.com/ffxiv-teamcraft/ffxiv-teamcraft/tree/staging/apps/client/src/app/modules/fish-train)（`fish-train.reducer.ts` / `.facade.ts` / `.effects.ts` / `.selectors.ts` / `get-fish-train-status.ts`）与 `fishing-bait` 模块展示了**状态与规则分离**的建模方式（参考规格，不移植 NGRX）。
- 结论：Schema 采用「**版本化 JSON 规则 + 显式条件枚举 + 缺失即标注**」，而不是把条件写成不可读的字符串；每条规则带 `source_version`、`validation_status`。

### 3.4 Widget / 页面（HUB-017）

- #1（`index.html` / `fishtrain.html` / `js/app/viewmodel.js`，MIT）与 #2（Angular 页面/组件，MIT）都提供「按窗口 + 条件过滤」的交互参考；
  #15（MIT）提供收集度展示结构。**本项目按既有 `component-registry` 静态映射自建**，不复用其 UI 代码（技术栈不同，收益低、改动面大）。

### 3.5 三字段进度（HUB-018）

- 语义交叉验证：规划 §8.1 的三集合（`completed` / `pinned` / `alarmFish`）与 #17（LatihasExport，导出到鱼糕）以及 #1 的追踪器状态模型一致；
  #17 **无许可证**，只能作为**语义证据**（术语与集合划分），不得拷代码。
- 结论：三字段各自独立持久化 + 独立 `revision`（与阶段 03/04 的字段级修订一致），不接受「并集即合并」。

### 3.6 区服隔离（HUB-035）

- CN 侧的独立证据：#13（Fishers-Intuition，MIT，CN 钓鱼计时器，last push 2025-12-18）与 #7（GarlandTools-CN，MIT）说明国服在**数据版本与术语**上独立；
  #12（boilmaster，branch `cn`，AGPL）说明 CN 数据服务是**独立分支/独立版本**，不是同一份数据。
- 结论：`region` 必须作为数据层一级维度（`fish_rules.region`、`data_sources.region`），窗口计算入口必须显式传入 region，默认值禁止猜测；跨区读取直接报错。

---

## 4. 数据授权（与代码许可证分开写）

**关键区分：代码的 MIT/WTFPL 不覆盖游戏数据。** 鱼名、图标、坐标、天候表、物品表等属于 **Square Enix** 的权利范围，datamining 仓库只是社区抽取结果。

| 事项 | 结论 | 依据（可核对） |
|---|---|---|
| #9 / #10 的数据是否可再分发 | **`unverified`**：仓库**没有**任何许可证或授权声明 | 两仓库 `LICENSE` 均 404，GitHub `license: null`；#9 的 README 仅描述抽取流程与致谢名单 |
| 游戏内数据（鱼名/天候/图标/坐标） | 属 Square Enix 权利范围；本项目**不做**「已获授权」的声明 | 同上；无官方授权文本可引用 |
| 站点数据（Teamcraft / Garland Tools / ffxivcollect 站点） | 站点数据的单独条款**未核实**（代码 MIT ≠ 站点数据可再分发） | 仓库许可证只覆盖代码；站点条款本环境无法核对 |
| #1 的 `fishData.yaml` 来源 | 社区手工维护（其 README 明确要求从 “Fish'cord” 收集新鱼条件）+ SaintCoinach 抽取 | [`README.md`](https://github.com/icykoneko/ff14-fish-tracker-app/blob/master/README.md)「Step-by-step Instructions for Updating Data」 |
| #16（CN 数据） | `unverified`，无许可证且长期未更新 | GitHub API `license: null`，last push 2025-08-12 |

**因此，05A 必须遵守的仓库内标注规则（建议写进实现与迁移注释）：**

1. 任何外部游戏数据表**必须**带：`source_url`、`source_version`（补丁号或 commit）、`fetched_at`（UTC ms）、`verification_status`（`verified` / `unverified` / `incomplete`）、`region`。
2. 数据**不**作为「我们的源码资产」提交：优先构建期/脚本生成为可重现产物，并在 `data/` 或迁移中只保留**最小必要子集**（本项目 05A 只需要鱼类与天候相关字段）。
3. 「来源记录」表就是 `data_sources`；任何界面展示必须能回答「这条规则来自哪里、什么时候抓的、验证到什么程度」。
4. 未核实即 `unverified`，界面不得显示「准确」「已确认」等措辞（沿用阶段 04 的诚实原则）。
5. 若将来需要署名：在 `docs/` 下单独维护第三方来源与许可清单（**本轮不创建该文件**，因为本任务只允许新建一份文档）。

---

## 5. 推荐复用清单（按处理方式分组）

### A. 直接适配（MIT / WTFPL 等宽松许可；**需在仓库保留版权与许可声明**）

| 来源 | 复用什么 | 一句话理由 |
|---|---|---|
| #1 icykoneko/ff14-fish-tracker-app（MIT） | ET 换算常量与天气时段算法（`js/app/time.js`、`js/app/weather.js`）、规则字段模型 | MIT + 与该领域规则最贴近的公开实现，改写成本最低 |
| #3 eorzea-weather/node-eorzea-weather（MIT） | ET/天气纯函数与区域/概率表结构，参考其 `src/__tests__` | MIT、TS 原生、结构干净，适合搬进 `packages/fish-engine` |
| #2 ffxiv-teamcraft（MIT） | 规则与状态分离的建模方式、`fish-train`/`fishing-bait`/`eorzea` 的行为语义 | MIT 且是最大规模的同类实现，可校准我们的语义边界 |
| #4 Asvel/ffxiv-weather（MIT，`LICENSE.txt`） | 天气预报/查询实现细节 | MIT 且仍在维护，可作为 #3 的交叉验证来源 |
| #7 ClayLivince/GarlandTools-CN（MIT） | CN 术语/名称对照思路 | CN 命名来源线索且许可宽松 |
| #13 Natsukage/Fishers-Intuition（MIT） | CN 场景的窗口/提醒**行为基准**（不是代码） | CN 用户实际使用的计时器行为，可作验收参照 |
| #15 fae-industries/ffxiv-collect（MIT） | 收集度（含鱼类）进度展示建模 | MIT，进度语义可直接对照 HUB-018 |

### B. 参考规格、重写实现（只读思路；不拷贝代码）

| 来源 | 参考什么 | 理由 |
|---|---|---|
| #2 Teamcraft 客户端结构 | 组件/状态组织 | Angular/NGRX/Electron 与本仓库（React + Workers）不兼容，只借语义 |
| #5 ClassicRagu/xivweather | `findWeatherWindows` 等窗口 API 形态 | **仓库内无 LICENSE 文件**（npm 元数据声称 MIT），不得直接拷代码 |
| #8 xivapi/SaintCoinach | EXD 表结构/字段含义、补丁差异机制 | C#/.NET 离线工具，不能作为 Workers 运行时依赖 |
| #15 / #1 的 UI | 过滤、排序、日历导出的交互 | 技术栈不同，重写更省 |
| #17 LatihasExport | `completed`/`pinned`/`alarmFish` 三集合语义 | 无许可证，只作语义证据 |

### C. 仅数据源参考（只引用来源与结构，不引入其代码）

| 来源 | 用途 | 理由 |
|---|---|---|
| #9 xivapi/ffxiv-datamining（无许可证） | 国际服表结构与补丁 diff 思路 | 无许可证 + 数据属 SE；只记录来源与版本 |
| #10 thewakingsands/ffxiv-datamining-cn（无许可证） | 国服中文鱼名/表数据（`FishParameter.csv` 已核实存在） | CN 唯一活跃公开来源；条款 `unverified` |
| #16 okuRaku/ff14-fish-tracker-app-data（无许可证） | CN 字段对照线索 | 许可证缺失且停滞，仅作参照 |
| #6 ufx/GarlandTools（MIT，代码） | 物品/鱼类详情的信息架构 | 活跃度低（2023-10 起停更），价值在结构不在代码 |

### D. 不采用

| 来源 | 原因 |
|---|---|
| #12 ackwell/boilmaster 与 thewakingsands/boilmaster | **AGPL-3.0**：与本仓库 UNLICENSED 私有属性冲突，不能拷入；即使只用 API 也需评估服务条款 |
| #14 NotNite/DistantSeas | **AGPL-3.0**，不能拷入（海钓也不在 05A 范围） |
| #11 thewakingsands/cafemaker | 已 archived 且明确不再维护、无许可证 |
| 「把游戏 CSV 整包提交进仓库」的做法 | 数据授权 `unverified` + 体积与许可风险，改用生成 + 出处记录 |

---

## 6. 有边界的 05A 实现建议（可直接交给 GPT 验收后下发）

> 下述全部是**边界建议**，不是实现；与本仓库既有约定（迁移编号、`workspace_id` 作用域、幂等 ledger、墓碑/水位、诚实状态）保持一致。

### 6.1 模块边界

- `packages/fish-engine/`：**纯函数**，零 DOM/零网络/零 D1/零日期库依赖（不要引入 rxjs/Angular/dayjs）。
  - `et.ts`：ET↔UTC 互转、天气时段边界（8 ET 小时）；
  - `weather.ts`：区域天气概率表 + 天气链（前置/当前）；
  - `rules.ts`：规则 Schema（Zod）与判定（时间窗、天气集合、前置鱼/鱼识、`fishEyes`、`folklore`）；
  - `windows.ts`：窗口枚举（有序、含 `occurrenceKey`），可传时间范围上限；
  - `types.ts`：`FishRule` / `WindowQuery` / `FishWindow` / `ValidationStatus`（`verified` / `unverified` / `incomplete`）。
- `worker/modules/fish/`：service/tx/adapter；只做「读规则 → 调 fish-engine → 写状态」。
  - `adapter/`：**唯一**接触外部数据源的地方，产出「带 `source_version` + `verification_status` 的规范化记录」，绝不把原始 CSV 直接落库。
- `packages/shared/src/fish-api.ts`：请求/响应契约 + 错误码（与 `nav-api.ts`/`events-api.ts` 同风格），供 Worker 与前端共用（前端不重复实现过滤）。
- 前端 `apps/web/src/features/fishing/` + 静态注册的 Widget（`ff14.fishing`），遵循阶段 02/04 的 Module Registry 与 `ModuleDataPort`，**不硬编码**组件。

### 6.2 迁移（建议 `0012_fish.sql`，仅本阶段 P0 子集）

- `data_sources(id, region, source_url, source_version, fetched_at, last_success_at, status, verification_status, note)` —— HUB-013 的版本与校验状态。
- `fish(id INTEGER PK, region, name_zh, name_en, fish_type, icon_id, source_version, verification_status)`。
- `fish_rules(id, fish_id FK, region, rule_json, source_version, validation_status, updated_at)`；`rule_json` 带 `schemaVersion`。
- `fish_state_fields(workspace_id, fish_id, field_name, value, revision, updated_at, updated_by_device)`，`field_name ∈ {caught, pinned, alarm}`（HUB-018 三字段独立）；PK `(workspace_id, fish_id, field_name)`。
- 所有表带 `region` 显式列 + 索引；私有表带 `workspace_id`；**不迁移** `reminder_rules` / `notification_jobs` / `push_subscriptions`（05B/06）。

### 6.3 窗口 API 的 P0 子集（HUB-016）

- `GET /api/v1/fish?region=cn|global&…`：分页列出鱼类 + 当前规则版本与验证状态。
- `GET /api/v1/fish/windows?region=…&hours=72`：**仅**返回接下来 N 小时的窗口（默认 72，硬上限例如 168）；30–60 天稀有窗口**不在 P0**。
- `GET /me/fish-progress`、`PUT /me/fish-progress/:fishId/:field`（带 `baseRevision` + `operationId`，复用阶段 03/04 的幂等与 CAS）。
- 每个窗口必须带：`occurrenceKey`（由 `region + fishId + ruleVersion + 窗口起点` 生成，**不用展示文案做键**）、`startsAtUtcMs` / `endsAtUtcMs`、`weatherChain`、`validationStatus`。
- 规则不完整（如缺 `weatherSet` 或 `predators` 未建模）→ 返回 `incomplete` 且**不**生成「确定可钓」的窗口；禁止用「猜测」补全。
- 计算必须有**成本上限**（时间范围 + 区域 + 鱼类数量），超限返回结构化 422，而不是拖垮 Worker。

### 6.4 CN / Global 显式分区（HUB-035）

- `region` 为枚举（至少 `cn` / `global`），**必填、无默认猜测**；CN 默认时区 `Asia/Shanghai` 仅影响展示，不影响 ET 计算。
- 规则行按 `region` 隔离；查询端点强制 `region` 过滤；跨区读取（例如 global 规则 + cn 鱼 ID）返回 422/404，并写测试断言。
- 数据源也分区域：`data_sources.region` 独立，版本号不共享。

### 6.5 无法验证的规则必须 `unverified` / `incomplete`

- 每个 `fish_rules` 行、每个 `data_sources` 行都有 `validation_status`；默认 `unverified`，只有人工核对或历史向量通过后才升为 `verified`。
- 判据（建议）：① 有 `source_url` + `source_version`；② 有至少一个通过的测试向量；③ 规则字段完整（无 `dataMissing` 语义）。
- 前端必须显示验证状态；`unverified` 不得出现「已确认/准确」措辞（沿用阶段 04 D4/D9 的诚实原则）。

### 6.6 测试向量来源与保存方式（HUB-014 / HUB-019）

- **自建（主）**：由公式直接推导的固定向量（ET↔UTC 边界、8 ET 小时时段边界、跨日/跨年、`Asia/Shanghai` 展示与 ET 无关）；
  对拍可参考 #3 的 `src/__tests__/EorzeaWeather.ts`（MIT）与 #1 的实现**作为交叉验证**，但向量值必须由我们自己的推导/独立来源确认。
- **历史案例（辅）**：只收录「公开可见、可引用 URL」的复杂天气链案例；无法确认来源的记录写进向量文件时标 `"verification": "unverified"`，并且**不放宽**断言——未验证的案例只做「不回归」观察，不计入通过标准。
- **保存方式（建议）**：
  - `packages/fish-engine/test/vectors/et-weather.json`（纯数字/时间戳/区域 ID，无游戏文本）；
  - `packages/fish-engine/test/vectors/windows-<region>.json`（含 `ruleVersion`、`source`、`verification` 字段）；
  - 向量文件头部注释必须写 `source` / `fetched_at` / `verification`，以便验收时逐条回溯。
- **禁止**：把从第三方仓库整段拷来的数据文件当作「测试基线」直接提交（授权未核实 + 无法解释来源）。

### 6.7 明确不做（05A 边界）

- 不做提醒规则/任务生成/Cron/Web Push/WebDAV（05B/06）；
- 不做部署、不创建任何远程 Cloudflare 资源、不抓取运行时外部站点（05A 的适配器**只**处理离线/构建期数据导入路径）；
- 不做 30–60 天稀有窗口的全量枚举、不做海钓（Ocean Fishing）规则；
- 不复用任何 AGPL 代码；不在没有版权/许可声明的情况下拷贝 MIT 源码。

---

## 7. 待办与未完成项

1. **许可证声明落地**：若采用 §5-A 的 MIT 来源，需在本仓库加入第三方许可/版权声明（本轮**未创建**该文件——本任务只允许新建本文档）。
2. **CN 数据条款**：#10 的 wiki 与国服数据再分发口径**未核实**；若 05A 真要内置 CN 鱼名数据，需先确认条款或改为「用户本地导入」。
3. **#1 的数据文件（`fishData.yaml`）是否可直接引用**：其**代码**是 MIT，但文件中包含游戏派生数据 → 按 §4 处理（记录来源与版本，不整包内联）。
4. **`xivapi/ffxiv-datamining` 的 `csv/cn` submodule 远端 URL**：未逐一确认（`mode: 160000`）。
5. **窗口历史向量**：无公开可再分发数据集，需自建（§6.6）。
6. 「未来窗口 API」不存在可直接复用的服务端实现，契约需自建。
