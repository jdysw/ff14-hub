# tests/e2e —— 端到端测试（Playwright）

阶段 02（HUB-044 / HUB-050）起启用。目前有三条**真实浏览器验收链**：

| 文件 | 覆盖 |
|---|---|
| `phase02-modules.spec.ts` | 匿名目录 → 会话内存凭证 → 启用模块 → 添加实例 → 多实例配置互不串扰 → 异步错误隔离 → 停用降级 → 卸载清理实例 → 恢复保留设置；窄屏 + 纯键盘导航 + 无横向溢出 |
| `phase03-workbench.spec.ts` | 模板/新建页面 → 桌面**真实拖动 + 缩放** → 键盘替代移动/缩放 → 桌面/平板/手机断点独立布局 → 未保存提示与撤销 → 导出 → 预览 → 导入 round-trip → 两个客户端并发保存冲突保留本地草稿 → 窄屏无横向溢出 |
| `phase04-navigation.spec.ts` | 推荐目录导入 → 个人副本 → 收藏（= 用户已修改）→ 删除墓碑 → 目录升级不覆盖/不复活 → 另一浏览器上下文不复活墓碑；书签 HTML 预览（逐项跳过原因、不执行外来 HTML）→ 应用 → 导出 round-trip；导航/活动组件真实放入 → 模块停用降级 → 恢复 → 移除组件但数据保留；活动维护表单真手工录入（UTC 毫秒对照）+ 非法区间就地拒绝且零写入；manifest / Service Worker / 缓存隐私 / 离线外壳兜底；390×844 无横向溢出；Tab/Enter 键盘可达 + 搜索真实筛选 + 焦点可见；双上下文导航并发冲突不静默覆盖 + 草稿不被远程变化覆盖 + 墓碑跨设备；桌面/手机两端布局修订与坐标互不影响 |

## 怎么跑

```bash
pnpm run e2e:phase02   # 模块系统链
pnpm run e2e:phase03   # 工作台布局与备份恢复链
pnpm run e2e:phase04   # 自由导航 / 内置导航与活动模块 / PWA / 跨设备同步链
```

三个命令各自由一个编排脚本驱动（`scripts/e2e-phase02.mjs` / `scripts/e2e-phase03.mjs` /
`scripts/e2e-phase04.mjs`），它们负责：

1. 清空**专用**本地 D1 持久目录（阶段 02 用 `.wrangler/e2e-state`，阶段 03 用
   `.wrangler/e2e-phase03-state`，阶段 04 用 `.wrangler/e2e-phase04-state`；都不碰
   `.wrangler/state`，也不碰任何远程资源）；
2. 构建前端产物（Worker 通过 ASSETS 同源提供）；
3. 对专用目录应用迁移（迁移可重复应用，这是被测试保证的性质）；
4. 启动 `wrangler dev --local`，用 `--var` 注入**本次运行随机生成**的初始化密钥
   —— 因此**不写、不读、不覆盖** `.dev.vars`，也不产生任何真实长期凭证。
   阶段 04 监听 **8788**（阶段 02/03 是 8787），并把 `E2E_BASE_URL` 显式传给 Playwright；
5. 通过真实 HTTP 端点 `POST /api/v1/identity/bootstrap` 初始化单工作空间设备；
   阶段 03 额外通过 `PATCH /api/v1/me/modules/demo.basics` **真实启用**一个演示模块
   （刻意不启用 `demo.solo`，用作「模块未启用时写入应被拒绝」的真实反例）；
   阶段 04 启用真实业务模块 `ff14.navigation` 与 `ff14.events`，并通过真实 HTTP 预置
   一条个人链接（`E2E 预置链接`）与一个个人活动（`E2E 预置活动`）；
   凭证写到 `tests/e2e/.credentials.json`（阶段 02/03）或
   `tests/e2e/.credentials.phase04.json`（阶段 04），都是临时文件（已被 `.gitignore` 忽略，
   运行结束即删除）；
6. 运行 `playwright test`，随后无论成败都关闭本地服务并删除凭证文件。

CI 中会先执行 `pnpm exec playwright install --with-deps chromium`。

**三个编排脚本都会显式指定本阶段的用例文件**（例如 `playwright test phase04-navigation.spec.ts`）。
原因：`playwright.config.ts` 的 `testMatch` 会匹配本目录下所有 `*.spec.ts`，而各阶段的服务准备
条件不同——阶段 03 的脚本会预先启用 `demo.basics`，阶段 02 的用例恰恰要从「未安装」开始断言，
阶段 04 的预置数据与端口都与前两者不同。不限定文件就会互相破坏前提。

## 阶段 04 的已知未覆盖项与实现观察（如实记录，不用 test.skip 掩盖）

> **复核修复状态（已落地）**：本链首次跑通后发现的 4 个真实产品缺陷与 1 处离线能力缺口，
> 都已在产品代码里修掉（见 `docs/adr/0004-phase04-navigation.md` 的 D14），
> 本文件下面各条已同步为**修复后**的状态与各自的回归用例。

1. **导航编辑表单（改名 / 改 URL / 描述 / 标签 / 图标 / 打开方式 / 区服 / 状态 / 分组归属）**：
   曾经因为前端把**工作空间修订**当行 CAS 基数提交而恒定 409（服务端比较的是**行修订**）。
   已修复：编辑草稿记录 `link.revision`，远端变化检测也改为比较该行修订。
   A 用例现在走**真实编辑表单改名**（`nav-link-edit` → 标题 → 提交），并断言持久化、
   行修订推进与界面无冲突横幅；字段级修改同时由 `worker/test/nav-crud.spec.ts` 覆盖。
   F1 用例仍用删除路径构造并发冲突（同为行级 CAS，语义等价）。
2. **离线降级的文案与外壳**：`apps/web/src/app/pwa/PwaStatusBar.tsx` 把 `install-state.ts` 的
   `OFFLINE_DISCLOSURE` 渲染成 `data-testid="offline-notice"`，D 用例断言「离线重载后出现明确的
   降级文案 + 系统级入口仍在（不白屏）」，文案直接从 `install-state.ts` 引用（唯一来源）。
3. **目录 `source_version` 真实升级**需要直接改库，浏览器链做不到；本链用「同一条目再次
   **非显式**导入」作为等价触发路径（服务端决策与真实升级路径同一份实现），
   真实版本升级由 `worker/test/nav-catalog.spec.ts` / `worker/test/nav-import.spec.ts` 覆盖。
4. **目录条目的「你删除过」状态**：曾经在界面上不可达（快照只返回未删除行，前端正是用它推算
   目录状态）。已修复：服务端随快照返回 `catalogPlan` 投影（**含墓碑行**），前端以「本地状态优先、
   墓碑取自投影」的方式合并。A 用例现在断言刷新目录后该条目 `data-catalog-state="tombstoned"`
   且文案含「你删除过」；worker 侧回归用例见 `nav-import.spec.ts` 的 #3 用例。
5. **目录导入的分类分组归属**：曾经因为成员关系 INSERT 排在「新建分组」INSERT 之前而静默插 0 行
   （分组存在但为空）。已修复：成员关系语句排在分组 INSERT 之后入批。A 用例现在断言副本
   **真的**落在分类分组里；worker 侧回归用例见 `nav-import.spec.ts` 的 #4 用例。
6. **首访后立刻离线**：曾经因为 SW 预缓存不含带哈希的 `/assets/*` 而白屏（外壳在、JS 不在）。
   已修复：页面在受控后把当前真实加载过的同源资源清单发给 SW（`FF14_HUB_CACHE_URLS`），
   SW 逐条按同一份缓存策略过滤后补缓存；回归用例见 `apps/web/test/pwa-asset-cache.spec.ts`
   （含「页面报了私有 URL 也必须拒绝」）。D 用例仍按真实用户路径先做一次受控访问再验证离线。
7. **全跳过的目录导入**：曾经仍会推进 `workspace_nav_state.revision` 并在响应里 +1。
   已修复：只有真的写入时才推进水位。A 用例现在断言响应 `revision` 与工作空间水位都**不变**；
   worker 侧回归用例见 `nav-import.spec.ts` 的 #6 用例。
8. **`@ff14-hub/shared` 的解析**：仓库根 `node_modules` 没有该包的链接（只有 `apps/web` 与
   `worker` 各自有），因此 spec 里用**相对路径**引用 `packages/shared/src/*`，断言用的仍是同一份
   共享实现（`parseNavExportDocument` / `navCatalogEntryState` / `EVENTS_MESSAGES`）。

## 约束（不得违反）

1. 测试对象是**本地** `wrangler dev`（同源），不是预览或生产环境。
2. 测试使用的凭证在运行时随机生成，只存在于临时 D1 与临时文件；**不得**写入真实密钥。
3. 本地需要浏览器：CI 使用 Playwright 自带 chromium；本地可用
   `E2E_BROWSER_CHANNEL=msedge`（或 `chrome`）复用系统已安装的浏览器。
4. 一旦在此目录加入用例，必须在 `.github/workflows/ci.yml` 有对应 job，
   且**不得**使用 `continue-on-error`。
5. 不得在 E2E 中做任何 Cloudflare 远程操作（部署、创建 D1、绑定域名、注册 Cron）。
