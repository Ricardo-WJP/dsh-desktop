# Desktop 0.1.56 修复与更新验收

## 修复

- 快照排除路径：运行时为独立 user-data 的父目录时，不加入 `..`。保留 SnapshotStore 路径安全校验。新增父目录/同目录/子目录判断，以及真实临时文件的创建快照→修改→恢复验证。
- Windows 隐藏子进程：spawn/spawnSync 的 null options 同样转换为 windowsHide:true；相关专属测试 20 项通过。应用主动打开的 GUI、未受管第三方进程主动创建的窗口不在 Node 该选项的保证范围内。
- 桌面端版本从 0.1.55 到 0.1.56，package/lock 同步；不将桌面版本冒充 DSH 核心版本。
- 更新本地化测试，认可用户已确认的 SVG DeepSeek Harness Logo。

## 已验证

- 全量测试 788 项：785 通过、0 失败、3 跳过。日志 output/0.1.56-tests-final.log。
- 发布流程隔离模拟验收通过，不等于真实安装验收。
- 实际市场暂存更新恢复成功。活动及 last-known-good 均为 plugin-52544c97-082e-4a60-b4d6-f14666ad9304；pending 与 plugin-candidate 日志已清除，previous 保留。工作区实际打开并完成两分钟健康观察。
- 更新项：automation 0.1.32、codex-ui 0.2.106、codex-connect 0.1.0-alpha.4.28、context 0.44.0、easyrewrite 2.4.0、mnemon 0.5.3、prompt-polish c87e6e22。市场 1.44.0、侧栏 0.18.0 保持。
- 未为了测试额外安装未指定插件。安装/失败恢复路径由回归与隔离发布验收覆盖；不承诺任意第三方插件永不失败。

## 安装包与本机安装

- 已生成 Windows x64 setup 与 portable，SHA256 见 dist/SHA256-0.1.56.txt。
- setup 静默安装退出码 0；安装后的可执行文件 FileVersion=0.1.56，ProductVersion=0.1.56.0。
- 安装后 controller/hidden-child-process 文件哈希与仓库验证版本一致。
- 安装后再次正常启动，日志 complete(100%)，工作区实际可见；未认证 HTTP 访问返回预期 401。活动插件仍为已通过观察的新版候选。
- 本次未额外更新 DSH 核心；当前运行时版本与桌面版本分别管理。

## 回滚位置

主备份：C:\Users\1\.codex\backups\auto-config-upgrades\2026-09-07-020424。
隐藏执行 helper 备份：C:\Users\1\.codex\backups\auto-config-upgrades\2026-09-07-20260907-020546。
切换前数据快照：pre-switch-a8602b66-3fa0-4465-9b8d-c63d2ae85b28。
应用版本回退使用 previous/恢复入口，不手改活动指针，不清空依赖或用户数据。
