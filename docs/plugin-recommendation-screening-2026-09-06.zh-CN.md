# 首次启动插件推荐筛选记录（2026-09-06）

## 结论

普通 base 和 suite 推荐页都只显示以下 3 项，顺序也是页面顺序：

1. `dshmarket`（npm）
2. `dsh-better-sidebar`（npm）
3. `dsh-notification`（GitHub：`omdsh-dev/dsh-notification`）

三项仍然是可选项；base 页不全选，suite 保留原先的预选行为但只预选这三项。读取推荐页不改写已安装状态、用户配置或 onboarding marker。`onboardingInstallSources` 对两种版本都只接受本页推荐 ID；suite 通过筛选后才委托给套件来源解析器，保持既有锁定来源。

`src/plugin-suite.js` 的 26 项库存、锁定来源和安装器不属于本次筛选范围，保持独立不变。

## 选择理由

| 条目 | 官方用途与筛选结论 |
| --- | --- |
| [`dshmarket`](https://www.npmjs.com/package/dshmarket) | DSH 内浏览、搜索、安装、更新和管理社区插件，是首次进入后继续发现插件的基础入口；纳入。官方仓库：[dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)。 |
| [`dsh-better-sidebar`](https://www.npmjs.com/package/dsh-better-sidebar) | 提供文件、编辑、终端、Git、浏览器和可扩展 Tab 的侧边工作台；它是工作区增强而不是另一套完整聊天渲染器，按“sidebar 优先”纳入。官方仓库：[omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)。 |
| [`dsh-notification`](https://github.com/omdsh-dev/dsh-notification) | 回合完成的桌面通知；官方说明其不增加模型工具、提示词或 token 成本，属于低侵入的完成反馈，纳入。需用户授予浏览器通知权限；官方安装说明使用 GitHub tag `v0.1.4`。 |
| [`dsh-context`](https://www.npmjs.com/package/dsh-context) | 提供更完整的上下文生命周期面板，但与 DSH 原生上下文占用/模型可见性能力有重叠；官方 npm README 的兼容说明也没有替代本仓库的实际兼容验收，因此不作为普遍默认推荐。需要该面板时可从市场按需安装。 |
| [`dsh-cost-meter`](https://www.npmjs.com/package/dsh-cost-meter) | 成本、预算、余额和历史统计属于使用场景与计费信息相关的可选能力，不是首次启动必需项；不默认推荐。 |
| [`dsh-reasoning-effort`](https://github.com/HanaAyane/dsh-reasoning-effort) | 面向支持推理强度的特定模型增加控制面板；模型依赖明显，且与 DSH 原生模型入口存在重叠；不默认推荐。 |
| [`dsh-mnemon`](https://www.npmjs.com/package/dsh-mnemon) | 本地优先的持久记忆系统，但官方 README 要求另行准备 Mnemon CLI，并按需配置 provider；属于明确记忆工作流的用户需求，不放入普通 base 首次推荐。它仍保留在 suite 的 26 项库存中。 |

## 2026-09-06 官方元数据只读检查

检查使用本机 `127.0.0.1:7892` 代理，仅读取 npm registry 与 GitHub 官方仓库/标签信息，没有执行安装、更新或真实 DSH 启动。观察到的版本/维护状态如下；“最新”只表示检查时官方元数据返回的最新版本，不代表本项目已验证兼容，也不代表安装成功。

| 候选 | 官方最新版本（检查时） | 官方维护信号 | 作为 base 默认 |
| --- | --- | --- | --- |
| `dshmarket` | npm `1.44.0`，2026-09-05 发布；GitHub `v1.44.0` | 仓库未归档，2026-09-05 有推送 | 是 |
| `dsh-better-sidebar` | npm `0.18.0`，2026-09-03 发布；GitHub `v0.18.0` | 仓库未归档，2026-09-05 有推送 | 是 |
| `dsh-notification` | GitHub tag `v0.1.4`，提交 `675aab9b43d5011738feb6185281596c0365ccba` | 仓库未归档，2026-09-01 有推送；GitHub `releases/latest` 未返回发布条目 | 是 |
| `dsh-context` | npm `0.43.0`，2026-09-05 发布；GitHub `v0.43.0` | 仓库未归档，2026-09-06 有推送 | 否：重叠/兼容性待验 |
| `dsh-cost-meter` | npm `1.7.10`，2026-09-03 发布；GitHub `v1.7.10` | 仓库未归档，2026-09-03 有推送 | 否：非首次必需 |
| `dsh-reasoning-effort` | GitHub `v0.7.0` | 仓库未归档，2026-09-01 有推送 | 否：模型特定 |
| `dsh-mnemon` | npm `0.5.2`，2026-09-05 发布；GitHub `v0.5.2` | 仓库未归档，2026-09-06 有推送 | 否：需额外本地记忆运行时 |

官方来源：[`dshmarket`](https://github.com/dsh-market/dsh-market)、[`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar)、[`dsh-context`](https://github.com/bowenliang123/dsh-context)、[`dsh-cost-meter`](https://github.com/Han-1413141/dsh-cost-meter)、[`dsh-notification`](https://github.com/omdsh-dev/dsh-notification)、[`dsh-reasoning-effort`](https://github.com/HanaAyane/dsh-reasoning-effort)、[`dsh-mnemon`](https://github.com/omdsh-dev/dsh-mnemon)。

## 本次变更与边界

- 修改 `src/onboarding.js`：base 从 6 项收窄为上述 3 项，suite 推荐页从完整库存中取同样的精选三项；完整库存和显式全套安装函数不变。
- 修改 `test/onboarding.test.js`：覆盖 base 精选列表、用户选择与非推荐 ID 拒绝、已有安装状态、suite 26 项库存/来源、以及读取/安装推荐不强制重置 marker。
- `src/pages/plugins-onboarding.html` 只将 suite 的“完整套件”文案改为“推荐插件”及对应说明；没有修改 CSS、DOM 布局、选择交互或安装反馈。
- 未修改已安装插件、用户配置、onboarding marker、`src/plugin-suite.js` 或真实 DSH 运行环境。
- 修改前备份：`backups/onboarding-recommendations-20260906-200121/`。
- suite 筛选与文案追加修改的备份：`C:\Users\1\.codex\backups\auto-config-upgrades\2026-09-06-200853-onboarding-scope`。
