# Go 推理能力与预检隔离：已部署基础修复

## 已确认根因

当前活动候选为 `plugin-a2aec7a3-08b3-4919-8121-d99cad8dcd13`，DSH 0.1.2-rc.1。新 Go 模型的目录补全使用 `reasoning:false`，后续同步沿用旧值，未读取能力数据。DeepSeek V4 Flash Vision Exp 因而没有推理控件。

模型名称/API 列表不包含完整推理能力。新增匿名读取固定 `https://models.dev/api.json` 的 Go 专属能力信息：8 秒上限、16 MiB 流式上限、禁止重定向、白名单字段，不发送任何用户凭据，不接受该源提供的新模型、路由或账号配置。

仅按官方可用 IDs 和路由已确认的模型补全能力。可调强度映射到原生 pi-ai 的 `thinkingLevelMap`，不支持的档位显式排除；修正 Vision Exp 的图像输入、上下文/输出限制和 DeepSeek 请求格式。只有 toggle/budget 而无明确 effort 的模型暂保留原生处理，不伪造多个强度。

来源：

- https://opencode.ai/docs/models/
- https://github.com/anomalyco/models.dev/blob/dev/providers/opencode-go/models/deepseek-v4-flash-vision-exp.toml
- https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode-go/models/qwen3.8-max.toml

## 验证及测试脚本错误说明

`scripts/verify-go-reasoning-wire.mjs` 使用实际安装的 pi-ai 序列化器和本地注入 fetch；不请求真实模型。最初合成 assistant 夹具缺少 usage，随后缺少 thinkingSignature，分别触发异常和 replay 断言失败。夹具补齐后验证通过：

- Off → `thinking.type=disabled`，不发 reasoning_effort。
- Low/High/Max → `thinking.type=enabled`，准确发送对应 reasoning_effort。
- 历史推理内容经 reasoning_content 完整保留。

证据：`output/go-reasoning-wire/report.json`。这证明真实原生请求构造正确，不等价于远端推理成功；本轮推理请求为 0。

## 未完成稳定性任务的本轮进展

- 清理期间正确关闭 Electron asar 虚拟解释，重叠清理采用计数保护；停服失败时保留临时目录，返回明确清理状态。
- 预检只继承必要 OS 与代理变量，隔离 HOME/USERPROFILE、Doctor、Mnemon、缓存和临时目录，移除继承密钥、NODE_OPTIONS，并使用独立工作目录。
- 这只是环境和工作目录隔离，不是 OS 沙箱：插件硬编码的绝对数据路径和远端连接尚不能保证隔离。真实数据迁移尚未开始。
- 实际原生 Host 正常插件启动通过，正常路径临时目录清理完成；故意损坏的插件按预期被拒绝，但快速退出后的进程身份清理仍触发 fail-closed。没有放宽 PID 安全检查或删除可能仍在使用的目录。
- 故障注入报告脚本已改为分别输出 startupChecksPassed 与 cleanupVerified；不能用“坏插件被拒绝”掩盖清理未完成。新报告格式尚待下一次运行验证，旧 `output/preflight-environment-proof/report.json` 的顶层 ok 只代表启动正反例，不能解释为全部清理通过。

全量测试：740 项，737 通过、0 失败、3 跳过。

## 部署边界与后续

本轮修改只在源码，尚未部署或打包。当前客户端停在设置编辑窗口，存在保存/放弃操作；为避免丢失用户编辑，未关闭弹窗、未保存或放弃用户设置、未重启。

需用户完成该窗口的编辑后，再同步自有模块并通过原有候选验证/回退流程重启，实际检查推理滑块及档位持久化。进一步的数据分离、数据/程序回退区分、完整功能级发布门禁仍待实施。

备份：`C:\Users\1\.codex\backups\auto-config-upgrades\2026-09-05-go-reasoning-continuation`。恢复时只撤销本轮对应文件，不覆盖用户后续配置、凭据、会话、记忆或其他 dirty 改动。

## 2026-09-06 续接部署与验收

用户完成设置编辑并要求继续后，已备份并同步 6 个自有模块到安装目录，未打包、未改版本号。安装前文件备份：`C:\Users\1\.codex\backups\auto-config-upgrades\2026-09-05-232356`。原始源码备份仍保留。

- 当前激活候选为 `plugin-b7d09a3e-7b95-4a19-977e-35e9cb39110f`，active 与 last-known-good 一致，pending 已清除。Go 凭据引用与旧候选一致，未输出值。
- DSH 正常退出后重启，经过原有候选准备、验证和观察流程完成切换；未强制结束任何进程。
- 实际工作区 GPT 5.6 Luna 推理滑块恢复，大肥鱼和轨道动效可见。实测 Medium → Max，重载工作区后仍为 Max；随后恢复为 Medium。
- 原生 pi-ai 本地请求捕获验证：Luna 的 Off/Low/Medium/High/Xhigh/Max 分别映射到 none/low/medium/high/xhigh/max；Vision Exp 的四档及历史 reasoning_content 回传验证也通过。只使用合成消息和本地 fetch，远端推理请求为 0。
- 定向部署检查 74 项通过、0 失败、无跳过；上一轮全量 740 项中 737 通过、0 失败、3 跳过。
- 实际 Electron 预检临时目录 `dsh-candidate-gate-IOXt82` 及其本轮 pending-delete 路径均已消失，正常路径清理完成。未删除旧的未知占用目录。
- 窗口控制工具曾出现定位/截图缓存错误，重新绑定后使用最新窗口位置完成验证；错误未通过强杀进程绕过。

仍未完成：坏插件快速退出后子进程身份未知的清理路径、正式数据分离、程序/数据回退的进一步解耦和完整功能级发布门禁。Luna 的只读安全建议见 `output/process-cleanup-safety.patch`；这是审查提案，尚未应用，不能宣称清理问题已经全部解决。
