# DSH Desktop

DeepSeek Harness 的社区桌面客户端，非 DeepSeek 官方产品。

**源码、构建流程、问题反馈和安装包现统一维护在本仓库。** 主分支可能包含尚未发布的改动；可安装版本以 [Releases](https://github.com/Ricardo-WJP/dsh-desktop/releases) 为准。

## 功能

- 桌面窗口、主题与本地 DSH 运行时集成。
- 分别检测 DSH 运行时和桌面端版本，通过双卡片选择更新项目。
- 推荐插件按需在线安装，不将个人配置、供应商密钥或会话打包发布。
- 配合相应插件使用供应商资源展示、用量统计和文件面板。

## 下载与平台

请从 [Releases](https://github.com/Ricardo-WJP/dsh-desktop/releases) 下载，并按对应版本说明选择安装包。

- Windows：安装包与便携包以实际发布附件为准。
- macOS：原生 Intel / Apple Silicon 构建流程已纳入仓库；测试包通过验证后才发布。未公证的包会明确标注，不能视为已签名、公证的正式发行版。

源码合并不代表安装包已同步更新。当前正在进行的新版验证完成后，会单独发布新安装包与更新说明。

## 本地开发

需要 Node.js 22 或更新版本，以及 npm：

```sh
npm ci
npm test
npm run check
npm run renderer:typecheck
npm start
```

开发、测试和正式安装是不同的验证范围。请勿将测试配置、真实密钥或用户数据提交到仓库。

## 构建与发布

GitHub Actions 默认只运行测试。打包需要显式启用，并先通过当前版本的发布校验；测试未完成时不会自动生成或上传安装包。

Windows 与 macOS 由各自平台的构建机生成。构建产物与实际安装验收分开记录，保留完整性校验和系统安全提示。

## 来源与许可证

本项目基于 [liguobao/dsh-desktop](https://github.com/liguobao/dsh-desktop) 的社区桌面实现，并集成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。保留原作者贡献与许可声明。

代码许可见 [LICENSE](LICENSE)，第三方和品牌说明见 [NOTICE.md](NOTICE.md)。各插件遵循其自身许可证。
