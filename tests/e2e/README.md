# tests/e2e —— 端到端测试（Playwright）

阶段 02（HUB-044 / HUB-050）起启用。目前有两条**真实浏览器验收链**：

| 文件 | 覆盖 |
|---|---|
| `phase02-modules.spec.ts` | 匿名目录 → 会话内存凭证 → 启用模块 → 添加实例 → 多实例配置互不串扰 → 异步错误隔离 → 停用降级 → 卸载清理实例 → 恢复保留设置；窄屏 + 纯键盘导航 + 无横向溢出 |
| `phase03-workbench.spec.ts` | 模板/新建页面 → 桌面**真实拖动 + 缩放** → 键盘替代移动/缩放 → 桌面/平板/手机断点独立布局 → 未保存提示与撤销 → 导出 → 预览 → 导入 round-trip → 两个客户端并发保存冲突保留本地草稿 → 窄屏无横向溢出 |

## 怎么跑

```bash
pnpm run e2e:phase02   # 模块系统链
pnpm run e2e:phase03   # 工作台布局与备份恢复链
```

两个命令各自由一个编排脚本驱动（`scripts/e2e-phase02.mjs` / `scripts/e2e-phase03.mjs`），它们负责：

1. 清空**专用**本地 D1 持久目录（阶段 02 用 `.wrangler/e2e-state`，阶段 03 用
   `.wrangler/e2e-phase03-state`；都不碰 `.wrangler/state`，也不碰任何远程资源）；
2. 构建前端产物（Worker 通过 ASSETS 同源提供）；
3. 对专用目录应用迁移（迁移可重复应用，这是被测试保证的性质）；
4. 启动 `wrangler dev --local`，用 `--var` 注入**本次运行随机生成**的初始化密钥
   —— 因此**不写、不读、不覆盖** `.dev.vars`，也不产生任何真实长期凭证；
5. 通过真实 HTTP 端点 `POST /api/v1/identity/bootstrap` 初始化单工作空间设备；
   阶段 03 额外通过 `PATCH /api/v1/me/modules/demo.basics` **真实启用**一个演示模块
   （刻意不启用 `demo.solo`，用作「模块未启用时写入应被拒绝」的真实反例），
   把一次性测试凭证写到 `tests/e2e/.credentials.json`（已被 `.gitignore` 忽略，运行结束即删除）；
6. 运行 `playwright test`，随后无论成败都关闭本地服务并删除凭证文件。

CI 中会先执行 `pnpm exec playwright install --with-deps chromium`。

**两个编排脚本都会显式指定本阶段的用例文件**（例如 `playwright test phase03-workbench.spec.ts`）。
原因：`playwright.config.ts` 的 `testMatch` 会匹配本目录下所有 `*.spec.ts`，而两个阶段的服务准备
条件不同——阶段 03 的脚本会预先启用 `demo.basics`，阶段 02 的用例恰恰要从「未安装」开始断言。
不限定文件就会互相破坏前提。


## 约束（不得违反）

1. 测试对象是**本地** `wrangler dev`（同源），不是预览或生产环境。
2. 测试使用的凭证在运行时随机生成，只存在于临时 D1 与临时文件；**不得**写入真实密钥。
3. 本地需要浏览器：CI 使用 Playwright 自带 chromium；本地可用
   `E2E_BROWSER_CHANNEL=msedge`（或 `chrome`）复用系统已安装的浏览器。
4. 一旦在此目录加入用例，必须在 `.github/workflows/ci.yml` 有对应 job，
   且**不得**使用 `continue-on-error`。
5. 不得在 E2E 中做任何 Cloudflare 远程操作（部署、创建 D1、绑定域名、注册 Cron）。
