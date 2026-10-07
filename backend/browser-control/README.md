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
browser-control daemon status --json
browser-control tabs list --all-browsers --json
browser-control tabs focus --browser chrome-01 123 --json
browser-control events --json --type tab-focused,tab-removed,browser-connected,browser-disconnected
```

## Concurrent agents

Pin `--browser <id>` and use explicit tab IDs. Create each worker's tab in the background:

```sh
bctl --browser zen-01 tabs create https://example.com --active=false --json
bctl --browser zen-01 page content 123 --json
bctl --browser zen-01 page screenshot 123 --output /tmp/worker-1.png
```

Different tabs run concurrently. Page operations on the same tab run in order. A queued `page exec` that expires before
execution does not run later; already-running JavaScript cannot be cancelled by its timeout. Tabs still share their
browser profile's cookies and website state.

Screenshots select capabilities automatically: Zen/Firefox use `tabs.captureTab`, including document-region capture for
selectors and full pages; Chrome uses tab-targeted CDP when debugger permission is granted. Neither path activates tabs
or scrolls them. Without either capability, visible capture is serialized per window, rate-limited across windows, and
checks target focus before and after capture. The fallback restores scroll position, including after errors. External
focus changes can make fallback captures fail.

Screenshot failures return errors without focusing the browser. `--focus-on-error` explicitly enables the old focus
recovery for a caller's OS capture. Screenshot `--timeout` defaults to `2m`. Dynamic `page exec` uses `MAIN`; `ISOLATED`
dynamic evaluation is unavailable under Manifest V3 CSP and returns an error. Script exceptions, rejected promises, and
page CSP failures return command errors, including in JSON mode; a legitimate `null` result remains successful.

SDK subscriptions use independent connections. Cancelling one preserves commands and other subscriptions; closing the
client releases all subscriptions. Tab event registrations accumulate until the extension's native connection closes.
Daemon event queues hold at most 32 pending events per client; overflow or a socket write exceeding 2 seconds disconnects
that client so a stalled event reader cannot block unrelated responses. Event streams end on disconnection; reconnect and
subscribe again when continuous observation is needed.
