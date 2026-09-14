# 0.1.54：原生插件兼容与更新恢复

本轮以现有 DSH Web UI 为界面基准。桌面端负责进程、窗口、候选安装与恢复；插件布局变化本身不再等同于启动失败。

## 对照项目

2026-09-05 通过 GitHub API 按 star 排序查阅，数量为当时快照，非质量保证。仅参考架构与行为边界，未复制其版本号或替换本项目发布来源。

| 项目 | stars | 核对提交与实现 | 本项目取舍 |
|---|---:|---|---|
| [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) | 23,696 | [安装边界](https://github.com/anywhere-labs/dsh-desktop/blob/5d482fd76d5434f90028f3925de900d31d7e7862/dsh-community-market/docs/install-and-uninstall.md)、[启动恢复控制器](https://github.com/anywhere-labs/dsh-desktop/blob/5d482fd76d5434f90028f3925de900d31d7e7862/dsh-plugin-desktop/src/startup-recovery-controller.ts) | 包身份由 Host 验证，恢复操作绑定明确版本；不把目录当作已安装状态的唯一来源。其市场不负责自动回滚，我们继续保留用户要求的候选验证与回退。 |
| [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) | 4,211 | [generation 安装器](https://github.com/dataelement/dsh-desktop/blob/8b018c991fe88abdb61939b280c3dbea020acfc8/packages/dsh-desktop-market-installer/generations/installer.mjs)、[插件机制说明](https://github.com/dataelement/dsh-desktop/blob/8b018c991fe88abdb61939b280c3dbea020acfc8/docs/plugin-management.zh.md) | 参考独立暂存、验证后发布、原生 Profile 投影。其对旧自动回滚策略的反思支持我们修正重复快照还原，避免覆盖回退后新写的数据。 |
| [dsh-tauri-desk/deepseek-harness-desktop](https://github.com/dsh-tauri-desk/deepseek-harness-desktop) | 1,681 | [单插件更新实现](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/blob/c94f18255e814e16df5b800aa5bf894c331d21b2/src-tauri/src/service/plugin/install/single.rs) | 参考原生 CLI 的包操作、更新后产物检查和可见错误反馈；没有照搬其自动卸载策略。 |

## 实际修改

- 新增统一原生兼容策略。专用适配器未识别新版本时，记录原生 fallback 提示并继续候选验证。显式强制能力、路径、完整性和引擎约束仍会拒绝非法候选。
- 冷启动只审计已发布插件，专用补丁仅在候选准备阶段应用。先完成全量只读适配审计，防止某个适配器识别失败时留下部分修改。
- 安装入口支持直接 npm 包和公共 HTTPS GitHub 地址。GitHub 包名来自锁定提交的 package.json；可以安装未被内置目录收录的包。元数据请求有超时、大小和来源限制。
- 并发“全部更新”共享一次事务；重复安装点击合并。单批上限统一为 256，超限明确报错。启用失败有可见反馈及重试入口。
- 成功回退后清除 pending，保留快照；未完成恢复不能被下一次切换覆盖。
- Windows 隐藏执行包装保留省略参数时的 cwd/env/signal 等选项，以及 promisify 的 stdout/stderr/child 合约。
- 静态插件检查支持条件 exports、同一路径归一去重；不能从文本扫描确定的 ModuleLoader 冲突交给实际运行验证。
- 语音、优化、设置按钮使用原生主题颜色与圆形 28px 控件，通过模型插槽定位。去掉逐帧位置修正，窄窗口允许换行，设置弹层根据锚点上方空间滚动。
- 恢复页显示兼容提示，错误页处理 IPC 拒绝与异常；控制中心使用更接近工作区的中性色，并提高次要文字对比度。

## 验证与边界

全量测试：696 项，693 通过、0 失败、3 跳过。3 项均因当前 Windows 不允许创建文件符号链接（EPERM）；目录 junction 越界检查另有实际通过的覆盖，未将跳过计为通过。更新/恢复故障注入、并发批量更新、未收录来源、路径越界、Windows 包装合约均覆盖。后续适配审计调整已通过定向回归。

真实 DSH 0.1.2-rc.1 隔离测试：正常临时插件启动通过，故意抛错的临时插件被阻止，正式 active 记录保持不变。负例同时保留了 Windows 快速退出后的清理身份诊断；没有据此放宽进程所有权校验。

UI：1400、1000、840 像素工具栏无交叠；提示词设置可打开且不越出窗口；空闲工具栏 800ms 内仅 1 次 class/style 变更。收缩侧栏下的设置、市场和图标检查通过；语音/提示词增强控件、Mnemon 设置及市场 API 检查通过。

没有承诺第三方插件永远兼容：其自身 API 变化、原生扩展、系统权限、外部账号和语音识别服务仍有各自要求。窗口隐藏包装覆盖 Node 子进程 API，不等于控制任意外部程序自行产生的窗口。语音验证覆盖控件、API 和权限可用性，未将其表述为实际语音转录验收。没有修改用户动效偏好。

备份：`C:\Users\1\.codex\backups\auto-config-upgrades\2026-09-05-164107-dsh-native-hardening`。包含修改前 src/test/scripts/compatibility、包版本文件与 release-state。回退代码时应只撤销本轮补丁；不使用整仓 reset，也不将旧 release-state 覆盖当前新增的数据。

## 安装版验收

Windows x64 安装包与便携版均生成，覆盖安装到原目录完成。安装版状态 API 回读：桌面 `0.1.54`、DSH `0.1.2-rc.1`、工作区就绪、26 个插件、兼容提示为空。关键源码与安装目录 8 个文件哈希逐一一致。安装版三种宽度工具栏复测通过，恢复页无横向溢出，DSH 更新 API 能返回当前版本与最新版本。

安装包：`dist/DSH-Desktop-v0.1.54-windows-x64-setup.exe`，545,828,321 字节。

SHA-256：`11575BDBE850C3F8FD33504D6BCF696AB84A42AECA9E01F9A72936201225A757`。

最终已重新启动不带调试参数的安装版；启动日志完成耗时 7,481ms，Doctor API 200，active 与 last-known-good 一致，pending 不存在，9230 调试端口关闭。
