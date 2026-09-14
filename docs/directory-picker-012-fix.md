# DSH 0.1.2-rc.1 文件夹选择器修复

原因：worker 使用 koffi.view 创建 Electron 不支持的 external buffer，读取选择结果时原生崩溃。旧修复仅适用于 0.1.1-rc.2。

新增精确校验的 0.1.2-rc.1 picker 规则：使用 koffi.decode.string16，显式 Electron Node worker 模式。接入候选构建、封装和活动版本修复审计，不关闭完整性验证；此版本规则不带入旧规则的模型路由默认值。

验证：90 项相关测试通过。隔离真实 Windows 对话框两次：取消返回 done/null，选择中文文件夹返回 done/完整路径，退出码均为 0。测试不更改客户端项目目录。

应用通过新候选 plugin-aee38529-66b0-43ef-a8ae-f65a4fa1c16a 迁移，旧候选保留。备份目录：C:\Users\1\.codex\backups\auto-config-upgrades\2026-09-07-024917。

联网分享包仍在制作，此修复会纳入后续构建；不能把此前的 0.1.56 安装包称作已包含本修复。
