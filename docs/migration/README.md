# Task 14：旁路迁移演练

旁路迁移脚本只接受显式绝对路径，且必须明确选择 `dry-run` 或 `execute`。源 `DSH_HOME` 与源 `profiles/web` 只读；脚本不会改名、写入、删除或停止旧 Host，也不会执行 live cutover。

## 运行

```powershell
node scripts/prepare-side-by-side-migration.mjs `
  --mode dry-run `
  --dsh-home C:\path\to\.dsh `
  --web-profile C:\path\to\.dsh\profiles\web `
  --output-root C:\path\to\dsh-side-by-side-dry-run `
  --id rehearsal-001
```

确认演练结果后，才可以在另一个全新的或空的输出根目录执行复制。`dry-run` 已写入报告，因此不能把它的输出目录直接复用于 `execute`：

```powershell
node scripts/prepare-side-by-side-migration.mjs `
  --mode execute `
  --dsh-home C:\path\to\.dsh `
  --web-profile C:\path\to\.dsh\profiles\web `
  --output-root C:\path\to\dsh-side-by-side `
  --id rehearsal-001
```

输出布局为：

```text
<output-root>/
  side-by-side-metadata.json
  migration-report.json
  data/ricardo-stable-<id>/
    dsh-home/                         # 一致复制的 DSH_HOME
      profiles/web/                   # 源 web 的只读副本
      profiles/ricardo-stable-<id>/  # 导入后的物理候选 profile
```

每个文件都执行 SHA-256 校验。易变文件使用“读哈希—复制—读哈希”有界重试；无法得到逐文件一致快照时，结果为 `failed`，不会被标记为可切换候选。源前后清单和 web profile 前后清单都会进入报告，报告只记录存在性、文件路径和哈希，不记录文件内容、设置值、会话值、工作区内容、环境变量或进程命令行。

旧 DSH 自动生成的 `profiles/node_modules` 依赖链接目录固定排除，不跟随、不复制；新客户端会从受信 release/profile 配方重建它。该排除项会写入迁移报告。除此之外，源目录中的任何符号链接或 Windows 重解析点仍会让迁移失败关闭。

报告中的 `legacyHost.takeOwnershipRequired` 仅表示只读探测到引用同一 `DSH_HOME` 的旧 Host。报告会列出安全的 PID/端口证据，但不会结束进程；`cutover.switched` 永远为 `false`，真实所有权切换仍需单独确认。
