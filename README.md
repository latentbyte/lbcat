<h1 align="center">
<img src="./src/assets/logo.png"/><br/>
LBcat
</h1>

<p align="center">Browser control for coding agents, a command line for your tabs, and a userscript loop from your editor straight into the browser.</p>

LBcat is a browser extension plus a small local CLI called `bctl`. It does three jobs in the browser you already use,
with your logins:

- **Browser control for agents.** Claude Code, Codex, or any tool that can run shell commands uses `bctl` to open
  tabs, read pages, click, type, and take screenshots, inside one agent window you hand it. Your other tabs stay out
  of reach.
- **A CLI for your tabs.** `bctl human tabs` lists, focuses, and closes tabs across every window, as plain text or
  JSON, for scripts, launchers, and tab switchers.
- **Userscripts from disk.** Write scripts in TypeScript or plain JavaScript, build them to `.user.js`, and
  `bctl script watch` installs each build in the browser as soon as it is saved. No copy and paste, no install dialog.
  Updates land the same way.

LBcat is a fork of [ScriptCat](https://github.com/scriptscat/scriptcat), so it is also a full Tampermonkey-compatible
userscript manager. All three jobs need a native bridge between a local program and the extension, which upstream
ScriptCat does not include, so we added it and ship our own signed build.

Status: free and open source. macOS is supported today; the CLI builds on Linux but desktop notifications are
macOS-only for now. There is no Windows support yet.

## Why use it

- **Your real browser.** No separate profile and no logging in again. The agent sees the sites the way you do.
- **A scoped agent window.** You designate one window for agents. Commands never fall back to your personal window,
  and a personal tab is only reachable when you grant that exact tab.
- **Task sessions and tab leases.** Each task gets its own session and owns the tabs it opens, so several agents can
  share one browser without stepping on each other. You can pause a task and take a tab back at any time.
- **A real dev loop for userscripts.** `bctl script push` matches installed scripts by `@name` and `@namespace`, so
  each push updates the installed copy in place. `push-all` installs a whole folder, in one browser or all of them.
- **Firefox and Zen, not only Chromium.** Chrome, Brave, Edge, Vivaldi, Firefox, Zen, and other forks are detected.
- **Built for agents.** Output is compact text by default and JSON on request, to keep token use low.
- **Local only.** The CLI talks to the extension over a Unix socket and Native Messaging. Nothing is sent to a server.

This is command targeting and task ownership, not a sandbox. Cookies and site state are shared with your profile, so
only point agents you trust at it.

## Install

You need two parts: the extension and the local tools.

### 1. Extension

- **Firefox and Zen:** install the signed add-on from
  [the update feed](https://dl.latentbyte.com/lb/exts/lbcat-updates.json). Open the `update_link` of the newest
  version in the browser. It updates itself after that.
- **Chrome and other Chromium browsers:** a Chrome Web Store listing is on the way. Until then, build it and load
  `dist/ext` as an unpacked extension:

  ```sh
  pnpm install
  pnpm run build
  ```

### 2. CLI, daemon, and native host

```sh
brew install latentbyte/tap/lbcat
browser-control install
```

The first command installs `browser-control` (also linked as `bctl`), `browser-control-daemon`, and `lbcat-shim`. The
second registers the Native Messaging host for every browser it finds. Restart the browser afterwards.

Chromium browsers are skipped until you pass the unpacked extension's ID from `chrome://extensions`, since LBcat has no
Chrome Web Store ID yet: `browser-control install --extension-id <id>`.

To build from source instead you need Go 1.25 or newer and [just](https://github.com/casey/just):

```sh
git clone https://github.com/latentbyte/lbcat
cd lbcat
just browser-control-install
brew install terminal-notifier   # click-to-approve notifications
```

## Quick start

```sh
bctl browsers                                    # connected browsers, e.g. zen-01
bctl --browser zen agent-window create           # the window agents may use
bctl --browser zen session begin --label "demo"  # prints a handle such as zen:ab12cd34
bctl --session zen:ab12cd34 tabs create https://example.com --active=false
bctl --session zen:ab12cd34 page content <tab-id>
bctl --session zen:ab12cd34 page screenshot <tab-id> --output /tmp/page.png
bctl --session zen:ab12cd34 session end --close-tabs
```

The full command reference is in [backend/browser-control/README.md](./backend/browser-control/README.md).

## Use it from an agent

Copy [backend/browser-control/skills/browser-control](./backend/browser-control/skills/browser-control) into your
agent's skills directory, for example `~/.claude/skills/browser-control`. The skill teaches the agent the session
workflow, the stopping conditions, and how to ask you for access.

Go programs can use the SDK in `backend/browser-control/pkg/browsercontrol`.

## Userscripts

Everything ScriptCat does still works: Tampermonkey-compatible scripts, background and scheduled scripts, cloud sync,
and the built-in editor. See the [ScriptCat documentation](https://docs.scriptcat.org/) for writing scripts.

To develop scripts on disk instead of in the built-in editor, point your build at a folder and watch it:

```sh
bctl script watch ~/my-scripts                # install each .user.js as soon as it changes
bctl script push dist/my-script.user.js       # one-off create or update
bctl script push-all ~/my-scripts --all-browsers
```

## Development

See [docs/DEVELOP.md](./docs/DEVELOP.md) and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). Common commands:

```sh
just check                  # tsc and eslint
just test                   # extension tests
just browser-control-test   # Go tests
```

## License and credits

The extension is licensed under [GPLv3](./LICENSE), the same as ScriptCat, which it is built on. Thanks to the
ScriptCat authors and contributors for the userscript engine.

The Go CLI, daemon, and SDK in `backend/browser-control/` are original work licensed under
[Apache-2.0](./backend/browser-control/LICENSE).
