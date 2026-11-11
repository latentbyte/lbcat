<h1 align="center">
<img src="./src/assets/logo.png"/><br/>
LBcat
</h1>

<p align="center">Let coding agents drive your real, signed-in browser, inside a window you hand them.</p>

LBcat is a browser extension plus a small local CLI called `bctl`. An agent such as Claude Code, Codex, or any tool
that can run shell commands uses `bctl` to open tabs, read pages, click, type, and take screenshots in the browser you
already use, with your logins. It works in one designated agent window and leaves your other tabs alone.

LBcat is a fork of [ScriptCat](https://github.com/scriptscat/scriptcat), so it is also a full
Tampermonkey-compatible userscript manager.

Status: free and open source. macOS is supported today; the CLI builds on Linux but desktop notifications are
macOS-only for now. There is no Windows support yet.

## Why use it

- **Your real browser.** No separate profile and no logging in again. The agent sees the sites the way you do.
- **A scoped agent window.** You designate one window for agents. Commands never fall back to your personal window,
  and a personal tab is only reachable when you grant that exact tab.
- **Task sessions and tab leases.** Each task gets its own session and owns the tabs it opens, so several agents can
  share one browser without stepping on each other. You can pause a task and take a tab back at any time.
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

With an unpacked Chromium build, pass its ID from `chrome://extensions` so the host accepts it:
`browser-control install --extension-id <id>`.

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
