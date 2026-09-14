# DSH Desktop 0.1.57 联网版验收记录

本轮按“允许隔离尝试重构/升级，但保留已确认视觉与功能”的约束执行。生产安装版未自动替换；源码与依赖已经同步至主项目。没有发布新的 GitHub Release 或 npm 包。

## 采用的改动

- 桌面包版本：0.1.56 → 0.1.57，属于本项目自己的版本。
- Electron：43.4.0 → 44.2.0。
- Koffi：3.1.6 → 3.2.1。
- semver：7.7.3 → 7.8.5。
- @types/react-dom：19.2.4 → 19.2.7。
- @vitejs/plugin-react：6.1.0 → 6.1.1。
- 间接依赖 fast-uri：3.1.5 → 3.1.7；qs：6.15.3 → 6.16.0。生产依赖 npm audit 结果为 0 项已知漏洞，不代表覆盖全部第三方插件或不存在未知漏洞。相关公告：[fast-uri](https://github.com/advisories/GHSA-5jgf-p345-68v8)、[qs](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)。
- Windows 子进程适配层把 spawn/spawnSync/fork 的重复参数分派合并为一个内部函数。107 行/4505 字节 → 104 行/4174 字节，减少 331 字节。保持 this、overload 参数个数、函数 name/length、冻结 options、windowsHide 强制策略、promisify 及非 Windows 行为。没有宣称内存或速度百分比改善。
- 安装包采用 normal 压缩；不启用 ASAR，保留原生模块、目录选择器和插件的既有文件路径。

## Signal 不再内置

已核实公开源：[GitHub v0.6.12](https://github.com/Ricardo-WJP/dsh-signal/tree/v0.6.12)、[npm dsh-signal](https://www.npmjs.com/package/dsh-signal)。GitHub 提交为 `a05694c80d559e4fa9745872c01a5d80c6f1f462`。

最终采用 npm `dsh-signal@0.6.12`，通过联网首次配置安装。基础推荐仍为 3 项，完整清单含 Signal 共 27 项。分享清单固定版本；后续通过插件市场检查更新。

下载 npm 包的 SHA-512 与 registry 一致：

`sha512-r77NZzhXY+CCMqXR8D2czaqApizmiIU8h5+nBHnIdKrC7xWoku/uWHN2jbBvpyuVDAtg+VJsSgS3X8ruU5mnYA==`

npm 包、GitHub 发布内容、本机 Signal 0.6.12 的 `lib/client.js` SHA-256 一致：

`9b92907d88d1b7dfc5a245f003aeaa5d352ae88019b16c3b8ac7893af49ffd79`

打包规则显式排除 `build/plugin-suite/plugins/dsh-signal/**/*`。桌面原生桥接适配器必须保留，它不是 Signal 插件。既有用户 profile 中的 Signal 不会被删除；移除的只是新分发包中的本地副本。

最终产物额外排除了旧 `dsh-signal.source.json` 来源说明，两个路径均已在 win-unpacked 中确认不存在。标准构建退出码 0，日志为隔离目录 `output/build-clean-0157.log`。

交付目录：`dist/release-0.1.57`。setup 为 125101019 字节，SHA-256 `2027057f9270d48c2bc6765b10b62b76e7d0f2f12860b5c88feb4d8fe3a910f7`；portable 为 124864737 字节，SHA-256 `8fbdcbaee9f00a2fd1b31d4637a0d29e606ef421dc4d10c077e25a0f5ba2fefa`。两者实际 Authenticode 状态均为 NotSigned；不依据构建日志中的 signing 字样声称已签名。

## 尝试后未采用

- DSH bootstrap 依赖的整包 0.1.2 替换：目录选择器补丁和历史兼容性证据不一致；已撤回该试验，恢复原 bootstrap 0.1.1-rc.2 与补丁。此处不等于降级用户正在运行的托管 DSH 0.1.2。联网候选准备仍可解析并验证托管 0.1.2，独立测试已验证此流程。
- Codex UI 0.2.113：包含分组样式、空状态字号/文案及接口变化。虽通过实验性候选安装启动，最终正式清单保留当前 0.2.110。
- IM Connect 0.1.38：与上述接口迁移配套，最终保留当前 0.1.37。
- Skills Manager 0.1.43：改变默认展开状态，保留当前 0.1.42。
- 没有对现有 CSS 做删除、重排、压缩、全局覆盖或重新设计。

## 验证与边界

- 主项目全套测试：800 项，797 通过、0 失败、3 项因 Windows 文件符号链接权限 EPERM 跳过。详见 `output/release-0157-tests.tap`。
- 类型检查、构建、三组已确认样式 SHA-256 回归通过。
- 控制中心生成的 JS 与 CSS 和上一版逐字节一致。JS SHA-256：`c6500ac1999f74376f7360fb7d9672dbbb2e129eb4b323ba6049084aa704ee77`。
- 新 Electron 44.2.0 的隐藏真实 BrowserWindow 验证：1040×740 窗口与内容区一致、resizable=true、DWM 圆角偏好=2、Acrylic backdrop=3。证据 `output/electron44-frame-verification.json`；这是原生窗口/程序化缩放检查，不冒充实际鼠标拖拽或所有平台视觉验收。
- 重构增加了与旧实现逐项对比的差分测试，以及真实 Windows Node 冻结 options / execFileSync / promisify 验证。差分基线放在 test/fixtures，不依赖开发机固定目录。
- 隔离联网流程完成 27 项来源解析、安装、静态门禁、运行门禁、候选切换与实际启动。实验目录：`C:\Users\1\AppData\Local\Temp\dsh-plugin-suite-smoke-63KWnc`；候选：`plugin-ffd5457b-9da9-4d9e-92cd-a13ef237d617`。该试验含较新的 UI/IM 组合；正式清单随后回退这两项到已经在当前安装版使用的版本，不把实验组合冒充最终组合的完整视觉 E2E。
- 修复隔离测试脚本占用生产 3080 的问题：只对测试注入独立端口分配器，不更改产品默认端口。早期测试失败及日志保留，不影响当前安装版。
- 打包继续执行原发布/native-data 验收门禁，没有绕过失败检查。隔离 Electron fixture 是模拟 UI 验收，不冒充真实账号、模型调用或录音识别验证。
- 没有在 macOS、Linux 或同学的机器实测；本次只交付 Windows x64 构建。

## 位置与回滚

- 主项目：`C:\DSH\ricardo-dsh-desktop`。
- 隔离发布目录：`C:\DSH\release-lab\dsh-desktop-0.1.57-20260908`。
- 本轮源码/清单及旧 node_modules 备份：`C:\Users\1\.codex\backups\auto-config-upgrades\2026-09-08-191747-release-0157`。
- 当前安装版保持原状，可继续使用。安装新版本之前建议正常退出客户端。源码回滚应按备份中的受影响文件恢复，不要 reset 或整目录覆盖其他工作；旧 node_modules 也已保留。
- 分享包只包含公开插件版本和允许导出的外观选项，不复制账号、凭据、会话、记忆或本机项目目录。
