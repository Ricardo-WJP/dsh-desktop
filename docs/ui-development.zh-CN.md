# DeepSeek Harness Desktop 界面修改指南

日常改界面不需要反复生成安装包。仓库根目录运行：

```powershell
npm run design
```

该命令会同时启动 Vite 和 Electron。管理中心的 React/CSS 修改会热更新；结束预览按 `Ctrl+C`，它会一并关闭本次启动的子进程。

## 界面与文件位置

| 界面 | 主要文件 | 修改后如何查看 |
| --- | --- | --- |
| 管理中心 | `src/renderer/components`、`src/renderer/routes`、`src/renderer/styles` | 保存后自动热更新 |
| 启动、报错页 | `src/pages/loading.html`、`src/pages/error.html` | 重启 `npm run design` |
| 插件管理页 | `src/pages/plugins.html`、`src/pages/plugins-page.js`、`src/pages/manager.css` | 重启 `npm run design` |
| 窗口、菜单、标题栏 | `src/window-host.js`、`src/main.js` | 重启 `npm run design` |
| Logo 与应用图标 | `assets`、`build/icon.ico`、`build/icon.png` | 页面 Logo 可刷新；系统图标需重新打包 |

实际的 Harness 工作区由内置 `@deepseek-ai/dsh` 和插件渲染，不属于管理中心 React 页面。不要直接修改 `node_modules` 或已安装目录；需要长期保留的工作区 UI 改动应放进版本化的集成插件，再由桌面端 profile 加载，这样升级和重新安装后不会丢失。

## 打包前检查

```powershell
npm run check
npm test
npm run dist:windows
```

设计迭代只用 `npm run design`；确认功能和视觉后再生成一次安装包。
