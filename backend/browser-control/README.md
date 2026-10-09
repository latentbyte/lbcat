# Browser Control

Browser Control is a Latent Byte LLC local browser automation backend. LBCat is the browser-side companion that connects
through Native Messaging.

## Binaries

- `browser-control`: CLI
- `browser-control-daemon`: local Unix socket daemon
- `lbcat-shim`: Native Messaging shim

## Native host

Host name: `com.latentbyte.browser_control`

Runtime state lives under `$XDG_STATE_HOME/browser-control`, or `~/.local/state/browser-control` when `XDG_STATE_HOME`
is unset.

## Common commands

```sh
just browser-control-build
just browser-control-install
just browser-control-install-cli # CLI-only updates while Native Messaging is active
browser-control daemon status --json
browser-control --browser zen-01 agent-window create
browser-control --browser zen-01 agent-window status
browser-control --browser zen-01 session list
```

`browser-control-install-cli` (alias `bctl-install-cli`) builds and installs only the CLI and its `bctl` link.
It leaves the daemon, Native Messaging shim, and browser host manifests unchanged. Use the full install target when
those components also need updating.

## Same-profile agent window

Register one dedicated normal window per connected profile. `agent-window create` opens an unfocused window with a
pinned extension marker. Only tabs created through task commands become eligible in a freshly created window;
tabs inherited or replicated by the browser remain outside scope. To choose an existing window, inspect
`agent-window list` (window IDs and state only), then explicitly run `agent-window designate <window-id>`.
Designation grants access to the work tabs present at that moment, not tabs later moved into the window.
Keep personal browsing in other windows. `agent-window clear` removes registration and all leases without closing tabs.

Registration validates the marker's saved tab ID, window ID, and unique extension URL on each operation. Closing,
moving, or navigating the marker makes scope unavailable; stale numeric IDs never select a replacement window.
Browser restoration may require explicit designation again. Missing scope fails with `AGENT_WINDOW_MISSING`, and the
CLI invokes `notify.sh` once per outage to request operator setup. Successful scope validation clears the notification
latch. No command falls back to the current personal window. SDK callers receive the error without desktop notification.
Registrations predating explicit tab grants require operator re-designation to grant access to existing tabs.
All extension marker pages remain protected, including markers from earlier registrations.
`agent-window status --json` reports the connected extension's `extensionVersion` and `manifestVersion`.

For workspace placement, move the chosen macOS window to an AeroSpace workspace such as `Agents`. Browser window IDs
and AeroSpace window IDs are different; use the operator-selected OS ID with `aerospace move-node-to-workspace --window-id
<os-window-id> Agents` without `--focus-follows-window`. Workspace or title matching never grants browser access.

This is command targeting and task ownership, not a browser sandbox. Cookies and account/site state remain shared;
page JavaScript, site popups, and profile-wide userscript changes are not isolated by window registration.

## Task sessions

Pin `--browser <id>`, begin a separate session for each task/subagent, and retain explicit tab IDs:

```sh
BROWSER_CONTROL_SESSION="$(bctl --browser zen-01 session begin --label "claude: fix login")"
export BROWSER_CONTROL_SESSION
bctl --browser zen-01 tabs create https://example.com --active=false --json
bctl --browser zen-01 page content 123 --json
bctl --browser zen-01 page screenshot 123 --output /tmp/worker-1.png
bctl --browser zen-01 session end
unset BROWSER_CONTROL_SESSION
```

Use `--session <id>` instead of the environment variable when convenient. The CLI reads the environment directly;
`env.example` documents it and is not automatically loaded. `session begin --ttl 30m` sets lease duration (default 15m,
range 1s to 24h). Work tab creation and access claim exclusive ownership; activity renews the lease. `session renew`
renews before long idle periods. `session end` releases ownership and leaves tabs open. Expired sessions must be replaced.
`session list` exposes live task IDs, expiry, pause state, and owned tab IDs so an operator can `session pause <id>` before
taking over a tab and `session resume <id>` afterward. Already-running page JavaScript is not cancelled by pause.

`session begin --label <name>` (or `BROWSER_CONTROL_LABEL`) names the task for humans. Each tab a task owns shows the
label as initials on the extension's toolbar badge and as a colored page border with an "Agent: <label>" pill on
http(s) pages. The pill's Stop button only turns access off for that tab. The extension popup shows the current tab's
owner (pause, resume, release, end) and a per-tab access setting: default, off (blocks every task, even in the agent
window), allow all agents (also for personal tabs outside it), or only one live task. Grants last until the tab closes
or the browser restarts, and never bypass another task's lease.

Tab listings exclude the marker and other tasks' leased tabs. Tab event streams include registered-window work tabs
across tasks, never ordinary windows; an event does not grant access. Built-in chat/task/subagent tab tools each get an
independent scope. GM DOM calls share their service's scope, also restricted to the agent window.

For an explicitly authorized personal tab, pass `--personal-tab <tab-id>` on each operation targeting that exact ID.
This does not authorize other tabs, change window registration, or bypass another task's lease. Agents must not use
setup, resume, or override commands to defeat a restriction without the user's instruction.

Different tabs run concurrently. Native page operations on the same tab run in order. A queued `page exec` that expires before
execution does not run later; already-running JavaScript cannot be cancelled by its timeout. Tabs still share their
browser profile's cookies and website state.
An active timeout quarantines the tab: further page execution, content, and capture return `TAB_EXECUTION_PENDING`
until the original execution settles or a new top-level document commits. Authorized `page reload` remains available
for recovery. Subframe, hash, and history-state navigation do not clear quarantine. Queued work is rejected rather than
carried into the new document; retry it explicitly. Internal task scopes recover expired sessions without bypassing pause
or another task's ownership.

Screenshots select capabilities automatically: Zen/Firefox use `tabs.captureTab`, including document-region capture for
selectors and full pages; Chrome uses tab-targeted CDP when debugger permission is granted. Neither path activates tabs
or scrolls them. Without either capability, default screenshots fail with `BACKGROUND_CAPTURE_UNAVAILABLE`.
Only explicitly authorized `page screenshot --foreground` enables visible capture, serialized per window, rate-limited across windows, and
checks target focus before and after capture. The fallback restores scroll position, including after errors. External
focus changes can make fallback captures fail.
Foreground full-page capture stitches both horizontal and vertical overflow. Foreground selector capture requires the
whole element to fit in the viewport after scrolling; otherwise it fails explicitly. It leaves the target tab active.
JPEG quality applies to the final cropped or stitched image. Screenshot file output enforces `--max-pixels` against
decoded bitmap dimensions and reports saved bitmap dimensions; raw screenshot JSON retains CSS region dimensions.

Tab creation defaults inactive. `tabs focus --foreground` and `tabs create --active=true` explicitly opt into foreground
activation. Screenshot `--focus-on-error` additionally requires `--foreground` to enable caller capture recovery.
Screenshot `--timeout` defaults to `2m`. Dynamic `page exec` uses `MAIN`; `ISOLATED`
dynamic evaluation is unavailable under Manifest V3 CSP and returns an error. Script exceptions, rejected promises, and
page CSP failures return command errors, including in JSON mode; a legitimate `null` result remains successful.

Load/reload the matching extension build before using these commands. Agent CLI and SDK page/tab requests first validate
`agentWindow.status`; an older extension or malformed registration fails before the original operation is sent.

SDK subscriptions use independent connections. Cancelling one preserves commands and other subscriptions; closing the
client releases all subscriptions. Tab event registrations accumulate until the extension's native connection closes.
Daemon event queues hold at most 32 pending events per client; overflow or a socket write exceeding 2 seconds disconnects
that client so a stalled event reader cannot block unrelated responses. Event streams end on disconnection; reconnect and
subscribe again when continuous observation is needed.

## Human-operated tab switchers

For an operator listing tabs directly from the CLI:

```sh
bctl human tabs list                             # all windows in the sole connected browser
bctl --browser zen-01 human tabs list --json      # one browser, structured metadata
bctl human tabs list --all-browsers --json        # all windows in all connected browsers
```

`human tabs list` uses the switcher SDK below, without an agent window or task session.
`--browser` takes precedence over `--all-browsers`; with multiple browsers, select one or use
`--all-browsers`. JSON responses use `cmd: "switcher.tabs.list"`. This CLI entrypoint lists tab
metadata only; ordinary `tabs` and `page` commands keep their agent restrictions. Session and
personal-tab flags do not apply to human listing. Agents must not use it to bypass scope restrictions.

Human-operated applications such as combo-switcher use the explicit Go SDK constructor
`browsercontrol.NewSwitcher(ctx)`. The existing `browsercontrol.New(ctx)` keeps agent-window restrictions.
The switcher client uses `switcher.tabs.list`, `switcher.tabs.focus`, and `switcher.tabs.subscribe` to list
browser-visible tabs across windows, focus the user's chosen tab, and receive tab events without an agent
window or task session. Tab listing includes private tabs only when the browser grants the extension access.

Switcher access provides tab metadata and focus only; there are no switcher page-execution, content,
capture, or userscript commands. `switcher.tabs.event` messages are routed only to connections whose
switcher subscription succeeded for that browser. Ordinary agent event streams remain scoped to the
registered window. This is an explicit application API, not authentication of a human or a separate
operating-system trust boundary; local clients can select it. Agents must keep using the scoped API.

Deploy the matching extension and daemon before updating a consumer to `NewSwitcher`; older versions
do not support the commands or isolated event routing. `NewSwitcher` checks the daemon's `switcher-tabs`
capability and rejects older daemons before any switcher commands are sent. combo-switcher must refresh its vendored SDK
and use `NewSwitcher` for both tab loading and its event/focus clients.
