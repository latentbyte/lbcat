<p align="right">
<a href="./README_zh-CN.md">中文</a> <a href="../README.md">English</a> <a href="./README_zh-TW.md">繁體中文</a> <a href="./README_ja.md">日本語</a> <a href="./README_RU.md">Русский</a>
</p>

<h1 align="center">
<img src="../src/assets/logo.png"/><br/>
LBcat
</h1>

<p align="center">為程式碼代理提供的瀏覽器控制、針對分頁的命令列,以及從編輯器直達瀏覽器的使用者腳本開發循環。</p>

LBcat 是一個瀏覽器擴充功能,加上一個名為 `bctl` 的本機命令列工具。它在你日常使用的瀏覽器中、帶著你的登入狀態完成三件事:

- **為代理提供的瀏覽器控制。** Claude Code、Codex 或任何能執行 shell 指令的工具,都可以用 `bctl` 在你交給它的一個代理視窗裡開啟分頁、讀取頁面、點擊、輸入和截圖。你的其他分頁不會被觸及。
- **分頁命令列。** `bctl human tabs` 可跨所有視窗列出、聚焦和關閉分頁,輸出純文字或 JSON,適合腳本、啟動器和分頁切換器。
- **從磁碟載入使用者腳本。** 用 TypeScript 或純 JavaScript 撰寫腳本,建置成 `.user.js`,`bctl script watch` 會在儲存後立即把每次建置安裝到瀏覽器。不需要複製貼上,也沒有安裝對話框,更新同樣如此。

LBcat 是 [ScriptCat](https://github.com/scriptscat/scriptcat) 的分支,因此它同時是一個完整的、相容 Tampermonkey 的使用者腳本管理器。這三件事都需要本機程式與擴充功能之間的原生橋接,上游 ScriptCat 並未包含這部分,所以我們自行加入,並發布自己簽署的建置。

狀態:免費開源。已在 macOS 上測試。Linux 理論上可用:工具可以從原始碼建置與安裝,但我們尚未在 Linux 上測試過,桌面通知目前僅支援 macOS。暫不支援 Windows。

## 為什麼用它

- **你真實的瀏覽器。** 不需要另外的設定檔,也不用重新登入。代理看到的網站和你看到的一樣。
- **限定範圍的代理視窗。** 你指定一個視窗給代理使用。指令不會退回到你的個人視窗,只有在你授權特定分頁時,才能存取個人分頁。
- **任務工作階段與分頁租約。** 每個任務有自己的工作階段,並擁有它開啟的分頁,多個代理可以共用一個瀏覽器而互不干擾。你可以隨時暫停任務並收回分頁。
- **真正的使用者腳本開發循環。** `bctl script push` 依 `@name` 和 `@namespace` 比對已安裝的腳本,每次推送都就地更新。`push-all` 可安裝整個資料夾,可針對一個或所有瀏覽器。
- **不只 Chromium,也支援 Firefox 和 Zen。** 可偵測 Chrome、Brave、Edge、Vivaldi、Firefox、Zen 及其他衍生瀏覽器。
- **為代理而設計。** 預設輸出精簡文字,需要時輸出 JSON,以降低 token 用量。
- **僅限本機。** 命令列透過 Unix socket 和 Native Messaging 與擴充功能通訊,不會向任何伺服器傳送資料。

這是指令定位與任務歸屬,不是沙箱。Cookie 和網站狀態與你的瀏覽器設定檔共用,請只讓你信任的代理使用。

## 安裝

需要兩個部分:擴充功能和本機工具。

### 1. 擴充功能

- **Firefox 和 Zen:** 從 [Firefox 附加元件商店安裝 LBcat](https://addons.mozilla.org/firefox/addon/lbcat/)。
- **Chrome 和其他 Chromium 瀏覽器:** Chrome 線上應用程式商店的上架正在準備中。在此之前,請自行建置並將 `dist/ext/chrome` 以未封裝擴充功能載入:

  ```sh
pnpm install
pnpm run build
```

### 2. 命令列、常駐程式和原生宿主

在 macOS 上:

```sh
brew install latentbyte/tap/lbcat
browser-control install
```

第一個指令安裝 `browser-control`(也連結為 `bctl`)、`browser-control-daemon` 和 `lbcat-shim`。第二個指令為它找到的每個瀏覽器註冊 Native Messaging 宿主。完成後請重新啟動瀏覽器。

Chromium 瀏覽器信任 LBcat 的 Chrome 線上應用程式商店 ID。使用未封裝的建置時,請傳入 `chrome://extensions` 中顯示的 ID:`browser-control install --extension-id <id>`。

在 Linux 上,或在 macOS 上從原始碼建置,需要 Go 1.25 或更新版本以及 [just](https://github.com/casey/just)。以下指令會把工具放入 `~/.local/bin`(請將其加入 `PATH`)並註冊 Native Messaging 宿主:

```sh
git clone https://github.com/latentbyte/lbcat
cd lbcat
just browser-control-install
brew install terminal-notifier   # macOS only
```

## 快速開始

```sh
bctl browsers
bctl --browser zen agent-window create
bctl --browser zen session begin --label "demo"
bctl --session zen:ab12cd34 tabs create https://example.com --active=false
bctl --session zen:ab12cd34 page content <tab-id>
bctl --session zen:ab12cd34 page screenshot <tab-id> --output /tmp/page.png
bctl --session zen:ab12cd34 session end --close-tabs
```

完整的指令參考見 [backend/browser-control/README.md](../backend/browser-control/README.md)。

## 在代理中使用

把 [backend/browser-control/skills/browser-control](../backend/browser-control/skills/browser-control) 複製到代理的 skills 目錄,例如 `~/.claude/skills/browser-control`。該 skill 會教代理工作階段流程、停止條件,以及如何向你申請存取權限。

Go 程式可以使用 `backend/browser-control/pkg/browsercontrol` 中的 SDK。

## 使用者腳本

ScriptCat 的所有功能依然可用:相容 Tampermonkey 的腳本、背景與排程腳本、雲端同步以及內建編輯器。撰寫腳本請參閱 [ScriptCat 文件](https://docs.scriptcat.org/)。

如果想在磁碟上而不是內建編輯器裡開發腳本,把建置輸出指向一個資料夾並監看它:

```sh
bctl script watch ~/my-scripts
bctl script push dist/my-script.user.js
bctl script push-all ~/my-scripts --all-browsers
```

## 開發

參見 [DEVELOP.md](./DEVELOP.md) 和 [ARCHITECTURE.md](./ARCHITECTURE.md)。常用指令:

```sh
just check
just test
just browser-control-test
```

## 授權與致謝

擴充功能採用 [GPLv3](../LICENSE) 授權,與其所基於的 ScriptCat 相同。感謝 ScriptCat 的作者與貢獻者提供使用者腳本引擎。

`backend/browser-control/` 中的 Go 命令列、常駐程式和 SDK 是原創作品,採用 [Apache-2.0](../backend/browser-control/LICENSE) 授權。
