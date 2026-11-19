<p align="right">
<a href="./README_zh-CN.md">中文</a> <a href="../README.md">English</a> <a href="./README_zh-TW.md">繁體中文</a> <a href="./README_ja.md">日本語</a> <a href="./README_RU.md">Русский</a>
</p>

<h1 align="center">
<img src="../src/assets/logo.png"/><br/>
LBcat
</h1>

<p align="center">面向编码代理的浏览器控制、面向标签页的命令行,以及从编辑器直达浏览器的用户脚本开发循环。</p>

LBcat 是一个浏览器扩展,加上一个名为 `bctl` 的本地命令行工具。它在你日常使用的浏览器里、带着你的登录状态完成三件事:

- **面向代理的浏览器控制。** Claude Code、Codex 或任何能运行 shell 命令的工具,都可以用 `bctl` 在你交给它的一个代理窗口里打开标签页、读取页面、点击、输入和截图。你的其他标签页不会被触及。
- **标签页命令行。** `bctl human tabs` 可跨所有窗口列出、聚焦和关闭标签页,输出纯文本或 JSON,适合脚本、启动器和标签切换器。
- **从磁盘加载用户脚本。** 用 TypeScript 或纯 JavaScript 编写脚本,构建为 `.user.js`,`bctl script watch` 会在保存后立即把每次构建安装到浏览器。无需复制粘贴,也没有安装对话框,更新同样如此。

LBcat 是 [ScriptCat](https://github.com/scriptscat/scriptcat) 的分支,因此它同时是一个完整的、兼容 Tampermonkey 的用户脚本管理器。这三件事都需要本地程序与扩展之间的原生桥接,上游 ScriptCat 不包含这部分,所以我们自行添加,并发布自己签名的构建。

状态:免费开源。已在 macOS 上测试。Linux 理论上可用:工具可以从源码构建和安装,但我们还没有在 Linux 上测试过,桌面通知目前仅支持 macOS。暂不支持 Windows。

## 为什么用它

- **你真实的浏览器。** 不需要单独的配置文件,也不用重新登录。代理看到的站点和你看到的一样。
- **限定范围的代理窗口。** 你指定一个窗口给代理使用。命令不会回退到你的个人窗口,只有在你授权具体某个标签页时,才能访问个人标签页。
- **任务会话与标签页租约。** 每个任务有自己的会话,并拥有它打开的标签页,多个代理可以共用一个浏览器而互不干扰。你可以随时暂停任务并收回标签页。
- **真正的用户脚本开发循环。** `bctl script push` 按 `@name` 和 `@namespace` 匹配已安装的脚本,每次推送都原地更新。`push-all` 可安装整个文件夹,可面向一个或所有浏览器。
- **不止 Chromium,还支持 Firefox 和 Zen。** 可检测 Chrome、Brave、Edge、Vivaldi、Firefox、Zen 及其他衍生浏览器。
- **为代理而设计。** 默认输出紧凑文本,按需输出 JSON,以降低 token 消耗。
- **仅本地。** 命令行通过 Unix socket 和 Native Messaging 与扩展通信,不会向任何服务器发送数据。

这是命令定位与任务归属,不是沙箱。Cookie 和站点状态与你的浏览器配置文件共享,请只让你信任的代理使用。

## 安装

需要两部分:扩展和本地工具。

### 1. 扩展

- **Firefox 和 Zen:** 从 [Firefox 附加组件商店安装 LBcat](https://addons.mozilla.org/firefox/addon/lbcat/)。
- **Chrome 和其他 Chromium 浏览器:** Chrome 网上应用店的上架正在准备中。在此之前,请自行构建并将 `dist/ext/chrome` 作为已解压的扩展程序加载:

  ```sh
pnpm install
pnpm run build
```

### 2. 命令行、守护进程和原生宿主

在 macOS 上:

```sh
brew install latentbyte/tap/lbcat
browser-control install
```

第一条命令安装 `browser-control`(也链接为 `bctl`)、`browser-control-daemon` 和 `lbcat-shim`。第二条为它发现的每个浏览器注册 Native Messaging 宿主。完成后请重启浏览器。

Chromium 浏览器信任 LBcat 的 Chrome 应用店 ID。使用未打包的构建时,请传入 `chrome://extensions` 中显示的 ID:`browser-control install --extension-id <id>`。

在 Linux 上,或在 macOS 上从源码构建,需要 Go 1.25 或更高版本以及 [just](https://github.com/casey/just)。以下命令会把工具放入 `~/.local/bin`(请将其加入 `PATH`)并注册 Native Messaging 宿主:

```sh
git clone https://github.com/latentbyte/lbcat
cd lbcat
just browser-control-install
brew install terminal-notifier   # macOS only
```

## 快速开始

```sh
bctl browsers
bctl --browser zen agent-window create
bctl --browser zen session begin --label "demo"
bctl --session zen:ab12cd34 tabs create https://example.com --active=false
bctl --session zen:ab12cd34 page content <tab-id>
bctl --session zen:ab12cd34 page screenshot <tab-id> --output /tmp/page.png
bctl --session zen:ab12cd34 session end --close-tabs
```

完整的命令参考见 [backend/browser-control/README.md](../backend/browser-control/README.md)。

## 在代理中使用

把 [backend/browser-control/skills/browser-control](../backend/browser-control/skills/browser-control) 复制到代理的 skills 目录,例如 `~/.claude/skills/browser-control`。该 skill 会教代理会话流程、停止条件,以及如何向你申请访问权限。

Go 程序可以使用 `backend/browser-control/pkg/browsercontrol` 中的 SDK。

## 用户脚本

ScriptCat 的所有功能依然可用:兼容 Tampermonkey 的脚本、后台和定时脚本、云同步以及内置编辑器。编写脚本请参阅 [ScriptCat 文档](https://docs.scriptcat.org/)。

如果想在磁盘上而不是内置编辑器里开发脚本,把构建输出指向一个文件夹并监听它:

```sh
bctl script watch ~/my-scripts
bctl script push dist/my-script.user.js
bctl script push-all ~/my-scripts --all-browsers
```

## 开发

参见 [DEVELOP.md](./DEVELOP.md) 和 [ARCHITECTURE.md](./ARCHITECTURE.md)。常用命令:

```sh
just check
just test
just browser-control-test
```

## 许可与致谢

扩展采用 [GPLv3](../LICENSE) 许可,与其所基于的 ScriptCat 相同。感谢 ScriptCat 的作者和贡献者提供用户脚本引擎。

`backend/browser-control/` 中的 Go 命令行、守护进程和 SDK 是原创作品,采用 [Apache-2.0](../backend/browser-control/LICENSE) 许可。
