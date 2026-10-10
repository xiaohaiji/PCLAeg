# PCLAeg · Aegisub Launcher

面向 Windows 的 Aegisub 启动器：管理多个版本，为每个实例独立保存配置和插件，把下载、依赖检查与同步放在一个界面里。

独立项目，与 Aegisub、PCL2 无隶属关系。

## 下载与使用

**[下载 Windows x64 便携版 0.2.1](https://github.com/xiaohaiji/PCLAeg/releases/download/v0.2.1/Aegisub-Launcher-0.2.1-Windows-x64.zip)** · [全部发布版本](https://github.com/xiaohaiji/PCLAeg/releases)

1. 解压 ZIP 到有写入权限的文件夹，运行 `AegisubLauncher/Aegisub Launcher.exe`，无需安装 Node.js。
2. 在“下载”中安装 Aegisub，或在“版本管理”中导入完整便携目录 / ZIP。也能扫描本机安装，选择后复制为独立实例。
3. 选择实例，点击“启动 Aegisub”。在“插件中心”管理这个实例的插件。

请保留 EXE 旁的程序文件，迁移时移动整个文件夹。下载包包含启动器和插件资源，Aegisub 程序通过下载或导入获得。

## 功能

- **版本管理**：官方、arch1t3cht 与自定义 GitHub Releases；Windows x64 便携 ZIP 筛选、下载重试与取消。支持 feature / migration 版本、导入、克隆和启动文件选择。
- **实例隔离**：各自的配置、快捷键、自动保存和插件。删除版本会在确认后彻底删除该实例的程序、配置、插件及相关恢复点，释放空间。
- **插件中心**：初始目录 64 项（内置脚本与在线精选条目合并去重，并非 64 项都可离线安装）。支持本地 Lua / MoonScript、GitHub 仓库或子目录、Gist、脚本直链、JSON 列表及 DependencyControl 源。
- **源互相发现**：解析 `knownFeeds` / `knownfeed` 等字段，展示候选源供用户添加。
- **依赖管理**：解析 DC 默认频道、文件与哈希、版本范围、间接依赖和模块别名；安装前预览、依赖关系图、缺失和重复模块检查；阻止移除其他插件仍在使用的模块。
- **跨实例同步**：选择配置、快捷键与插件，预览差异及冲突处理方式。失败自动回滚，也可从“设置”的恢复点手动恢复。
- **外观与系统集成**：浅色 / 深色 / 跟随系统；选择默认打开 ASS / SSA 的实例，并注册 Windows 文件关联。

![深色模式下的插件依赖视图（演示数据）](docs/images/dependencies-dark.png)

## 常见问题

### 为什么保留导入来源？

导入通过复制建立独立实例，原目录不参与后续管理，方便核对或迁移。确认导入完整后可自行处理原目录。“删除版本”删除启动器管理的实例，不删除导入来源。

### 没有自动识别到主程序怎么办？

下载或导入时，如果程序名称无法自动识别，启动器会打开文件选择器。请选择当前实例目录内的 Aegisub 主程序（`.exe`），不要选择安装器、服务端或辅助工具。选择结果会保存，重启启动器和克隆实例后仍会使用该文件。取消选择会撤销本次安装并清理临时文件，原有实例不受影响。

“启动文件”操作在无法自动识别时也可手动选择，文件必须与当前主程序位于同一目录，以保持配置和插件目录一致。

### 如何升级？

从 0.2.1 开始，可在“设置 → 检查更新”后点击“一键更新”。更新使用官方稳定版 ZIP，验证 SHA-256 和文件清单，退出后只替换启动器程序并自动重启，保留实例、配置、插件与数据目录设置。替换失败自动恢复旧程序，旧程序备份和结果记录在 `cache/launcher-updates/`。请先关闭正在运行的 Aegisub。仅支持 Windows x64 目录版；开发模式与自解压单文件版请手动升级。

0.2.0 首次升级到 0.2.1 需要手动覆盖一次，之后才能使用一键更新。

关闭启动器和运行中的 Aegisub，备份整个文件夹，再将新包的程序文件覆盖到原文件夹。保留 `versions/`、`cache/`、`state.json` 和自定义 `launcher-paths.json`。不要删除整个旧文件夹后再解压，否则会丢失实例数据。

### 数据保存在哪里？

默认在 EXE 所在文件夹：`versions/` 保存实例，`state.json` 保存索引和设置，`cache/` 保存下载缓存和恢复点。“设置”可打开数据目录。可在 EXE 旁创建 `launcher-paths.json`，例如 `{"dataRoot":"D:/AegisubWorkspace"}`，指定其他目录。

### ASS 默认打开为什么还要在 Windows 中选择？

注册文件关联后，需要在 Windows 默认应用中选择 Aegisub Launcher。启动器不覆盖 Windows 的用户选择。打开文件会转交设置中选定的 Aegisub 实例。

可在版本列表点击“设为默认打开实例”，或在设置中选择“跟随当前选择的实例”。设置页分别显示 ASS、SSA 的系统关联状态；移动启动器后若注册路径失效，请重新注册。删除固定默认实例后自动改为跟随当前选择，并显示提示。

### 依赖检查能保证所有插件兼容吗？

安装前检查声明的依赖及可识别的静态引用。动态加载的依赖仍由 Aegisub / DependencyControl 在运行时检查；不同 Aegisub 版本仍可能存在兼容差异。建议通过启动器启动实例，以便跟踪进程占用。

在线下载与源发现需要访问对应站点；已有实例和内置脚本可离线管理。

## 开发与构建

Windows，Node.js 22 或更新版本：

```powershell
npm.cmd ci
npm.cmd test
npm.cmd start
npm.cmd run build:dir
npm.cmd run package:zip
```

构建目录在 `dist/win-unpacked`；ZIP 与 SHA-256 校验文件输出到 `dist/`，排除实例、缓存和测试数据。`build:portable` 可选生成单文件自解压 EXE，本项目发布采用目录 ZIP。

技术栈：Electron + HTML / CSS / JavaScript。文件操作在主进程执行，渲染进程使用隔离的 preload 接口。

GitHub Actions 在推送主分支或提交 PR 时运行测试、构建与打包验证。发布时更新 `package.json`、`package-lock.json` 和 CHANGELOG，提交后推送对应 `v版本号` 标签（例如 `v0.2.1`），工作流自动生成 ZIP 和校验文件，全部上传完成后公开发布。标签必须与包版本一致。无需手动上传下载包。

单元测试覆盖版本识别、存储隔离、插件源、DC 解析、依赖与同步回滚。`tests/` 另有打包 UI 和网络测试，建立独立测试目录；网络测试可能下载、启动测试用 Aegisub。

## 开源与来源

启动器原创代码采用 [MIT](LICENSE)。第三方脚本、模块和运行时保留各自版权与许可，不由本项目重新授权，见 [第三方说明](THIRD_PARTY_NOTICES.md)。

- [Aegisub](https://github.com/TypesettingTools/Aegisub)
- [arch1t3cht 分支](https://github.com/arch1t3cht/Aegisub)
- [DependencyControl](https://github.com/TypesettingTools/DependencyControl)
- [unanimated 脚本](https://github.com/TypesettingTools/unanimated-Aegisub-Scripts)

变更记录见 [CHANGELOG](CHANGELOG.md)。反馈问题请提供启动器版本、Aegisub 版本、插件源与复现步骤；日志提交前检查个人路径和信息。

感谢 [WenHe233](https://github.com/WenHe233) 的深色模式与启动文件选择修复（[PR #1](https://github.com/xiaohaiji/PCLAeg/pull/1)、[PR #2](https://github.com/xiaohaiji/PCLAeg/pull/2)）。
