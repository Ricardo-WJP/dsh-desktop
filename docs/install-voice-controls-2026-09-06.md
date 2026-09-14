# 插件安装、语音与按钮修复

- 截图错误属于会话 agent 直接修改候选 profile 后执行 pnpm，不是市场安装失败日志。NO_TTY 和备份拒绝不能用清空依赖绕过。当前清单没有该次未完成的 dsh-agy-link 项。补强 DSH 动态系统提示词，要求使用市场事务、禁止直接修改运行中清单、备份失败必须停止；没有实际安装新插件。
- DSH 原生主题全局设置 `corner-shape: superellipse(1.5)`。对输入框、紧凑侧栏和设置中的普通小按钮显式 round；纯图标等宽高、文字胶囊；不更改大卡片、开关语义或动效。模拟全局 squircle 的 composer 8 个场景通过。
- 用户当前引擎为浏览器识别。已证实旧桌面语音补丁会丢弃 interim，且吞掉 network 错误重试。V2 保留临时文字并显示网络/空结果错误，原 setDraft API 不变；按已知 SHA 校验升级旧补丁，未知内容不写入。95 个相关测试通过，含停止后保留临时文字、保留草稿、网络错误与无结果状态。
- 真实麦克风到识别服务的可用性尚待用户试说验证；模拟回调不是实际录音成功。未配置语音服务、读取密钥或上传音频。
- 备份：`C:\Users\1\.codex\backups\auto-config-upgrades\2026-09-06-install-voice-controls`。部署了 app-owned integration、运行时修复器、已校验的 STT client 和管理页 CSS。重启范围仅核实的 DSH 进程树。
