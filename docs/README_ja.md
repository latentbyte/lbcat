<p align="right">
<a href="./README_zh-CN.md">中文</a> <a href="../README.md">English</a> <a href="./README_zh-TW.md">繁體中文</a> <a href="./README_ja.md">日本語</a> <a href="./README_RU.md">Русский</a>
</p>

<h1 align="center">
<img src="../src/assets/logo.png"/><br/>
LBcat
</h1>

<p align="center">コーディングエージェント向けのブラウザー操作、タブのためのコマンドライン、そしてエディターからブラウザーへ直接つながるユーザースクリプト開発ループ。</p>

LBcat は、ブラウザー拡張機能と、`bctl` という小さなローカル CLI の組み合わせです。普段使っているブラウザーで、ログイン状態のまま次の 3 つを行います。

- **エージェント向けのブラウザー操作。** Claude Code、Codex など、シェルコマンドを実行できるツールが `bctl` を使い、あなたが渡した 1 つのエージェント用ウィンドウの中で、タブを開く、ページを読む、クリックする、入力する、スクリーンショットを撮る、といった操作ができます。ほかのタブには触れません。
- **タブのための CLI。** `bctl human tabs` は、すべてのウィンドウのタブを一覧表示、フォーカス、閉じる操作ができ、出力はプレーンテキストまたは JSON です。スクリプト、ランチャー、タブスイッチャー向けです。
- **ディスクからのユーザースクリプト。** TypeScript または JavaScript でスクリプトを書き、`.user.js` にビルドすると、`bctl script watch` が保存と同時にブラウザーへインストールします。コピー＆ペーストもインストールダイアログも不要で、更新も同じ流れです。

LBcat は [ScriptCat](https://github.com/scriptscat/scriptcat) のフォークで、Tampermonkey 互換のユーザースクリプトマネージャーとしてもそのまま使えます。この 3 つにはローカルプログラムと拡張機能をつなぐネイティブブリッジが必要ですが、上流の ScriptCat には含まれていません。そのため私たちが追加し、署名済みビルドを独自に配布しています。

状況：無料のオープンソースです。macOS で動作確認しています。Linux でも動くはずで、ソースからビルドとインストールはできますが、まだ Linux では検証しておらず、デスクトップ通知は今のところ macOS のみです。Windows は未対応です。

## 特長

- **普段のブラウザーをそのまま使えます。** 別プロファイルも再ログインも不要で、エージェントはあなたと同じようにサイトを見ます。
- **範囲を限定したエージェントウィンドウ。** エージェント用に 1 つのウィンドウを指定します。コマンドが個人のウィンドウに切り替わることはなく、個人のタブは、そのタブを明示的に許可した場合にのみ操作できます。
- **タスクセッションとタブのリース。** 各タスクは専用のセッションを持ち、自分が開いたタブを所有します。複数のエージェントが 1 つのブラウザーを干渉なく共有できます。タスクの一時停止やタブの取り戻しはいつでも可能です。
- **本格的なユーザースクリプト開発ループ。** `bctl script push` は `@name` と `@namespace` でインストール済みスクリプトを照合し、push のたびにその場で更新します。`push-all` はフォルダー全体を、1 つまたはすべてのブラウザーにインストールします。
- **Chromium だけでなく Firefox と Zen にも対応。** Chrome、Brave、Edge、Vivaldi、Firefox、Zen などのフォークを検出します。
- **エージェント向けの設計。** 出力は既定でコンパクトなテキスト、必要に応じて JSON で、トークン消費を抑えます。
- **ローカルのみ。** CLI は Unix ソケットと Native Messaging で拡張機能と通信します。サーバーには何も送信されません。

これはコマンドの対象指定とタスクの所有権であり、サンドボックスではありません。Cookie やサイトの状態はプロファイルと共有されるため、信頼できるエージェントにのみ使わせてください。

## インストール

拡張機能とローカルツールの 2 つが必要です。

### 1. 拡張機能

- **Firefox と Zen：** [Firefox アドオンの LBcat](https://addons.mozilla.org/firefox/addon/lbcat/) をインストールします。
- **Chrome とその他の Chromium 系ブラウザー：** Chrome ウェブストアでの公開を準備中です。それまでは、ビルドして `dist/ext/chrome` をパッケージ化されていない拡張機能として読み込んでください。

  ```sh
pnpm install
pnpm run build
```

### 2. CLI、デーモン、ネイティブホスト

macOS の場合：

```sh
brew install latentbyte/tap/lbcat
browser-control install
```

1 つ目のコマンドで `browser-control`（`bctl` としてもリンクされます）、`browser-control-daemon`、`lbcat-shim` をインストールします。2 つ目のコマンドは、見つかったすべてのブラウザーに Native Messaging ホストを登録します。その後、ブラウザーを再起動してください。

Chromium 系ブラウザーは LBcat の Chrome ウェブストア ID を信頼します。パッケージ化されていないビルドでは、`chrome://extensions` に表示される ID を渡します：`browser-control install --extension-id <id>`。

Linux、または macOS でソースからビルドする場合は、Go 1.25 以降と [just](https://github.com/casey/just) が必要です。次のコマンドでツールを `~/.local/bin`（`PATH` に追加してください）に置き、Native Messaging ホストを登録します。

```sh
git clone https://github.com/latentbyte/lbcat
cd lbcat
just browser-control-install
brew install terminal-notifier   # macOS only
```

## クイックスタート

```sh
bctl browsers
bctl --browser zen agent-window create
bctl --browser zen session begin --label "demo"
bctl --session zen:ab12cd34 tabs create https://example.com --active=false
bctl --session zen:ab12cd34 page content <tab-id>
bctl --session zen:ab12cd34 page screenshot <tab-id> --output /tmp/page.png
bctl --session zen:ab12cd34 session end --close-tabs
```

コマンドの完全なリファレンスは [backend/browser-control/README.md](../backend/browser-control/README.md) にあります。

## エージェントから使う

[backend/browser-control/skills/browser-control](../backend/browser-control/skills/browser-control) をエージェントの skills ディレクトリ（例：`~/.claude/skills/browser-control`）にコピーします。この skill は、エージェントにセッションの流れ、停止条件、アクセスの依頼方法を教えます。

Go プログラムからは `backend/browser-control/pkg/browsercontrol` の SDK を使えます。

## ユーザースクリプト

ScriptCat の機能はすべてそのまま使えます。Tampermonkey 互換スクリプト、バックグラウンドスクリプトとスケジュールスクリプト、クラウド同期、内蔵エディターです。スクリプトの書き方は [ScriptCat のドキュメント](https://docs.scriptcat.org/) を参照してください。

内蔵エディターではなくディスク上でスクリプトを開発するには、ビルド出力先をフォルダーに向けて監視します。

```sh
bctl script watch ~/my-scripts
bctl script push dist/my-script.user.js
bctl script push-all ~/my-scripts --all-browsers
```

## 開発

[DEVELOP.md](./DEVELOP.md) と [ARCHITECTURE.md](./ARCHITECTURE.md) を参照してください。主なコマンド：

```sh
just check
just test
just browser-control-test
```

## ライセンスとクレジット

拡張機能は、ベースにした ScriptCat と同じ [GPLv3](../LICENSE) でライセンスされています。ユーザースクリプトエンジンを作った ScriptCat の作者とコントリビューターに感謝します。

`backend/browser-control/` の Go CLI、デーモン、SDK は独自の成果物で、[Apache-2.0](../backend/browser-control/LICENSE) でライセンスされています。
