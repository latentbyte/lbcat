# Browser Control

Browser Control is a Latent Byte LLC local browser automation backend. LBCat is the browser-side companion that connects
through Native Messaging.

Licensed under Apache-2.0 (see `LICENSE` and `NOTICE`). The agent skill that teaches coding agents this CLI is in
`skills/browser-control/`; copy that directory into your agent's skills path.

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
Browser restoration may require explicit designation again. Missing scope fails with `AGENT_WINDOW_MISSING`; the message names the cause
(never registered, marker closed or moved, or marker gone after an extension reload/update or browser restart). The
CLI sends one desktop notification per outage to request operator setup (`notify.sh` when installed, otherwise
`terminal-notifier`). Successful scope validation clears the notification
latch. `agent-window create --ask` lets an agent recover with approval: it returns a live registration unchanged,
otherwise sends a click-to-allow notification (clicks need `terminal-notifier`) and creates the window only after the
click; no click within `--timeout` (default 9m) fails with `AGENT_WINDOW_APPROVAL_TIMEOUT`. No command falls back to the current personal window. SDK callers receive the error without desktop notification.
Registrations predating explicit tab grants require operator re-designation to grant access to existing tabs.
All extension marker pages remain protected, including markers from earlier registrations.
`agent-window status --json` reports the connected extension's `extensionVersion` and `manifestVersion`.

For workspace placement, move the chosen macOS window to an AeroSpace workspace such as `Agents`. Browser window IDs
and AeroSpace window IDs are different; use the operator-selected OS ID with `aerospace move-node-to-workspace --window-id
<os-window-id> Agents` without `--focus-follows-window`. Workspace or title matching never grants browser access.

This is command targeting and task ownership, not a browser sandbox. Cookies and account/site state remain shared;
page JavaScript, site popups, and profile-wide userscript changes are not isolated by window registration.

## Task sessions

Begin a separate session for each task/subagent and retain explicit tab IDs. `session begin` prints a handle such as
`zen:ab12cd34` (browser name, colon, session ID); later commands route to that browser, so `--browser` is only needed
for `session begin` when several browsers are connected:

```sh
bctl --browser zen session begin --label "claude: fix login"   # prints zen:ab12cd34
bctl --session zen:ab12cd34 tabs create https://example.com --active=false --json
bctl --session zen:ab12cd34 page content 123 --json
bctl --session zen:ab12cd34 page screenshot 123 --output /tmp/worker-1.png
bctl --session zen:ab12cd34 session end --close-tabs
```

`--browser` (or `BROWSER_CONTROL_BROWSER`) accepts an exact connection ID (`zen-01`) or a browser name (`zen`) that
resolves to the only connected browser of that name; IDs renumber across reconnects, names do not. Several connections
with the same name fail and list the IDs; pass the exact ID with `--browser`. An explicit `--browser` or
`BROWSER_CONTROL_BROWSER` overrides the handle's browser, and bare session IDs (no prefix) still work.
`BROWSER_CONTROL_SESSION` can replace `--session` in shells that keep exports between commands (agent harnesses
usually do not). The CLI reads the environment directly; `env.example` documents it and is not automatically loaded.
`session begin --ttl 30m` sets lease duration (default 15m, range 1s to 24h). Work tab creation and access claim exclusive ownership; activity renews the lease. `session renew`
renews before long idle periods. `session end` releases ownership and leaves tabs open; `session end --close-tabs`
also closes the task's agent-window work tabs and reports `closedTabIds`/`keptTabIds` (personal tabs, and every tab of a
paused task, stay open). Expired sessions must be replaced.
`tabs close <tab-id>...` closes agent-window work tabs owned by the task or unowned; personal tabs (even when granted),
other tasks' tabs, and the marker are refused.
`session list` exposes live task IDs, expiry, pause state, and owned tab IDs so an operator can `session pause <id>` before
taking over a tab and `session resume <id>` afterward. Already-running page JavaScript is not cancelled by pause.
It needs no session. Next to `tabIds`, each session carries `tabs: [{"id": 762, "origin": "https://voice.google.com"}]`
(empty sessions encode `[]`). `origin` is `scheme://host[:port]` of the tab's current (or pending) URL, or `null` for
non-http(s) or vanished tabs; paths, queries, and titles of other tasks' tabs are never exposed. Use it to check whether
another task already holds a tab on a given site. Available since LBcat 4.23.0.

`session begin --label <name>` (or `BROWSER_CONTROL_LABEL`) names the task for humans. Each tab a task owns shows the
label as initials on the extension's toolbar badge and as a colored page border with an "Agent: <label>" pill on
http(s) pages. The pill's Stop button only turns access off for that tab. The extension popup shows the current tab's
owner (pause, resume, release, end) and a per-tab access setting: default, off (blocks every task, even in the agent
window), allow all agents (also for personal tabs outside it), or only one live task. Grants last until the tab closes
or the browser restarts, and never bypass another task's lease.

### Notes for the human operator

Tasks can leave page-level notes on tabs they may access. Notes are keyed by the page URL without its hash, survive
tab close and browser restart, and expire 7 days after their last change (200 notes max).

```sh
NOTE="$(bctl --browser zen-01 note add 123 --kind needs-human "Solve the captcha, then reply 'done'")"
bctl --browser zen-01 note wait "$NOTE" --timeout 15m   # prints the note once acknowledged, replied to, or resolved
bctl --browser zen-01 note resolve "$NOTE"
bctl --browser zen-01 note list --status open
```

Kinds are `info`, `needs-human`, and `done`. Status starts `open`; the human can acknowledge, reply (which also
acknowledges), resolve, or delete from the popup, which lists the current page's notes. Open notes show their count on
the tab's toolbar badge. `note list` returns the current session's notes, or all notes without a session; `note get`
and `note wait` work by note ID after the session ends. Notes are plain text up to 2000 characters, visible to
anyone using the profile; never put secrets in them.

Tab listings exclude the marker and other tasks' leased tabs. Tab event streams include registered-window work tabs
across tasks, never ordinary windows; an event does not grant access. Built-in chat/task/subagent tab tools each get an
independent scope. GM DOM calls share their service's scope, also restricted to the agent window.

For an explicitly authorized personal tab, pass `--personal-tab <tab-id>` on each operation targeting that exact ID.
This does not authorize other tabs, change window registration, or bypass another task's lease. Agents must not use
setup, resume, or override commands to defeat a restriction without the user's instruction.

Different tabs run concurrently. Native page operations on the same tab run in order, and each one (exec, content,
snapshot, fetch, wait, actions, navigation, screenshot) carries an extension-side timeout that fires before the CLI gives
up. A queued operation that expires before it starts does not run later; already-running work cannot be cancelled by
its timeout. Tabs still share their browser profile's cookies and website state.
An active timeout quarantines the tab: further page operations return `TAB_EXECUTION_PENDING` until the original
operation settles or a new top-level document commits. Authorized `page reload` bypasses the quarantined queue for
recovery. A hung in-page read (exec, content, snapshot, fetch, wait) is also released by any top-level reload. Subframe, hash, and history-state navigation do not clear quarantine. Queued work is rejected rather than
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
decoded bitmap dimensions and reports saved bitmap and CSS dimensions; raw screenshot JSON retains CSS region dimensions.
With `--output`, `--json` prints only `{path, width, height, bytes, cssWidth, cssHeight}`; base64 is printed only for
`--json` without `--output`.
`--region x,y,width,height` captures a viewport rectangle (CSS pixels, origin top left, the same space as
`page click --at`) at full device resolution, so a small region is not downscaled the way a whole viewport is: use it to
read small text or controls. The region must lie inside the viewport (it never scrolls) and cannot be combined with
`--selector` or `--full-page`. To map an image pixel back to `--at` coordinates, scale by CSS size / bitmap size and add
the region origin. `page content --selector` fails with `SELECTOR_NOT_FOUND` when nothing matches.
`page content --format markdown` returns visible content as Markdown (headings, lists, links with absolute URLs, tables,
code); hidden elements, scripts, and styles are dropped. `--max-chars N` truncates any format and appends
`[truncated: N of M characters; ...]`. `script push --reload-tabs` reloads session-accessible tabs whose URL matches
the script's `@match`/`@include` rules (waiting for load unless `--wait none`) and reports their IDs. `browsers --json` returns
`{cmd: "browsers", data: [ids]}` like other commands.

Tab creation defaults inactive. Browsers pause rendering (`requestAnimationFrame`) in tabs that are not selected in their
window and clamp their timers to about 1s, while the page may still report `visibilityState: "visible"`; canvas apps such
as Flutter web never finish loading there. `tabs focus <id>` selects a work tab inside the agent window without focusing
the window (`TAB_BUSY` if the window is showing another task's tab; tabs outside the agent window need `--foreground`).
`WAIT_TIMEOUT` and `LOAD_TIMEOUT` on an unselected tab say so. `tabs focus --foreground` and `tabs create --active=true`
explicitly opt into foreground activation. Screenshot `--focus-on-error` additionally requires `--foreground` to enable caller capture recovery.
Screenshot `--timeout` defaults to `2m`. Dynamic `page exec` uses `MAIN`; `ISOLATED`
dynamic evaluation is unavailable under Manifest V3 CSP and returns an error. Script exceptions and rejected promises fail
with `SCRIPT_ERROR`, including in JSON mode. When page CSP or Trusted Types forbid eval, the code is injected as source
through `userScripts.execute` (Chrome 135+ with user scripts allowed; page CSP does not apply) and still runs in `MAIN`;
there, statements need `return` for a value. Without that API the error is `CSP_BLOCKED`. A legitimate `null` result
remains successful. A single expression returns its value and may use `await` (`{a: 1}` is an object, not a block);
statements return the last expression's value, and top-level `return`/`await` work too. Promises inside a returned
object or array are awaited; `undefined` becomes `null`; Map/Set become objects/arrays. DOM nodes, functions, and
circular values fail with `RESULT_NOT_SERIALIZABLE` naming the offending key. `--max-chars N` truncates the result
(strings by characters, other values as JSON text) and adds `truncated`/`totalLength`.

Load/reload the matching extension build before using these commands. Agent CLI and SDK page/tab requests first validate
`agentWindow.status`; an older extension or malformed registration fails before the original operation is sent.

SDK subscriptions use independent connections. Cancelling one preserves commands and other subscriptions; closing the
client releases all subscriptions. Tab event registrations accumulate until the extension's native connection closes.
Daemon event queues hold at most 32 pending events per client; overflow or a socket write exceeding 2 seconds disconnects
that client so a stalled event reader cannot block unrelated responses. Event streams end on disconnection; reconnect and
subscribe again when continuous observation is needed.

### Tab links for the human operator

```sh
bctl --session zen:ab12cd34 tabs link 123   # prints lbcat://tab/zen-01/123
```

Agents put these links in chat so the human can jump to a tab instead of hunting through browsers, windows, and
workspaces. Opening one runs `bctl human tabs focus <link>`: the browser focuses the tab, then the OS raises its
window. On macOS, `browser-control install` registers `~/Applications/LBcat Links.app` as the `lbcat://` handler;
`uninstall` removes it. A link carries the browser's connection ID. If that browser has since reconnected under a new
ID, the link goes to the connected browser of the same name that has the tab. Tab IDs do not survive a browser
restart.

Window raising lives in `internal/raise`. Each `Raiser` tries to bring the tab's OS window forward and the first one
that succeeds wins: AeroSpace (`aerospace focus --window-id`, matching the window by app and active tab title, which
also switches workspace), then macOS `open -a <browser>`. To support another OS or window manager, add a `Raiser`
and list it in `raise.Default`. With none available, only the browser's own window focus happens.

## Page actions and waiting

Prefer these over `page exec` + `sleep`; each returns what happened instead of `null`:

```sh
bctl page click 123 --text "Sign in"          # or a CSS selector: page click 123 'button[type=submit]'
bctl page click 123 --at 640,380              # viewport CSS pixels, for canvas/map/editor surfaces
bctl page fill 123 --text Email --value a@b.c # label, aria-label, placeholder, or name
bctl page select 123 '#country' --value Canada
bctl page press 123 Enter '#search'           # no selector: the focused element
bctl page wait 123 --text "Welcome" --timeout 15s
bctl page wait 123 --selector .spinner --state gone
bctl page goto 123 https://example.com/next   # also page back|forward
```

`page snapshot <tab> [--selector S] [--max N]` lists visible links, buttons, fields, and headings one per line
(`@e3 textbox "Email" = "a@b.c"`, password values masked); pass a ref to any action (`page click 123 @e3`). Refs stay
stable for the same element across snapshots and fail with `REF_NOT_FOUND` once the element is gone or the page
navigates. `--json` returns `{url, title, elements, total, truncated}`.

Locators: a ref, a CSS selector (open shadow roots included), `--text` (visible text or field label, case-insensitive, exact
match before substring), or both. Only visible elements count. Several matches fail with `AMBIGUOUS_MATCH` listing up to
five candidates; pick one with `--nth N`. No match fails with `SELECTOR_NOT_FOUND`. Text clicks target the closest
clickable ancestor. `fill` uses the native value setter and fires `input`/`change`, so React/Vue inputs update.
`press` accepts modifiers (`Control+a`); Enter in a form field submits the form.

`click --at x,y` targets whatever is at that viewport point (CSS pixels, origin top left), entering open shadow roots
and same-origin iframes, and dispatches pointer/mouse events carrying those coordinates; editable or clickable targets
are focused as a real click would. Points inside cross-origin frames fail with `CROSS_ORIGIN_FRAME`, points outside the viewport
with `NO_ELEMENT_AT_POINT`. Prefer refs: coordinates are for surfaces without elements to target.

Actions (`click`, `fill`, `select`, `press`, `upload`) report what they changed, saving a separate `page snapshot`
round trip. `--snapshot diff` (default) prints snapshot lines the action added (`+`), removed (`-`), or changed (`~`,
with the new state), or `snapshot unchanged`; it compares the whole page before and after the action, so it only covers
links, buttons, fields, and headings, not plain text. When the action loads a new document, or the diff would be at
least as long as the page, the full snapshot is printed instead. `--snapshot full` always prints the full snapshot;
`--snapshot none` skips it. Output is capped at 150 lines. A snapshot that fails after the action succeeded is reported
as `snapshot unavailable: ...` without failing the command, so the action is not retried. JSON adds `changes: {added,
removed, changed, total, truncated?, count?}`, `snapshot`, or `snapshotError`. In `page run` only the last step observes
by default (a final action reports its diff); earlier steps take a snapshot only when asked.

Actions and `goto`/`back`/`forward`/`reload` default to `--wait load`: if the action starts a navigation (including
SPA URL changes), the command returns after it finishes loading (`LOAD_TIMEOUT` after `--timeout`, default 30s);
otherwise it returns after a short settle window. The result is `{matched, navigated, url, title}`. `--wait none`
returns immediately. `tabs create` also waits for load by default. `page wait` checks `--load`, then `--url <regex>`,
then `--selector`/`--text` (`--state visible|attached|gone`), sharing one `--timeout` (default 10s) and failing with
`WAIT_TIMEOUT`. Tab JSON includes `status` (`loading` or `complete`).

`page fetch <tab> <url>` requests a URL (relative to the page or absolute) with the page's origin and cookies, replacing
in-page `fetch` via `page exec`. Flags: `--method`, repeatable `--header 'Name: value'`, `--body` / `--body-file`
(JSON-looking bodies default to `Content-Type: application/json`), `--max-chars`, `--timeout` (30s). Plain output is the
body; non-2xx statuses still print it and exit non-zero. `--json` returns `{status, ok, url, contentType, body}`.
Network/CORS failures return `FETCH_FAILED`, timeouts `FETCH_TIMEOUT`. Firefox/Zen use `content.fetch` so requests
carry the page's identity rather than the extension's.

`page upload <tab> [selector|@ref] --file PATH` sets local files on an `<input type=file>` and fires input/change,
without the file picker or a debugger. `--text` matches the input's label or the label/button that opens it; a
selector or ref may point at a container or label holding the input (hidden inputs are fine); with no locator the
page's only file input is used. Repeat `--file` for `multiple` inputs. Contents travel base64-encoded in 512 KB
`page.upload.chunk` frames (native messaging caps frames at 1 MB), about 48 MB per file. Errors: `NOT_FILE_INPUT`,
`UPLOAD_TOO_LARGE`, `UPLOAD_NOT_FOUND` (chunks expire after 2 minutes).

`page run <tab> 'step' ...` runs steps in order over one connection and stops at the first failure with a non-zero
exit. Each quoted argument is one step written like its single command without the tab ID, e.g. `page run 12 'fill @e2
--value "a@b.c"' 'click --text "Sign in"'`; steps split into words like a shell (quotes, backslash escapes) without
expansion, and take the single commands' flags. `-f steps.json` takes a JSON array instead (`{"action": "click", "text":
"Save"}`; other keys are the extension's argument names, camelCase, e.g. `maxChars`; `click` takes `x`/`y` for `--at`;
`timeout` takes a duration; refs accept `@e3`; `-f -` reads stdin). Actions: `goto back forward reload click fill select
press wait content snapshot exec fetch viewport`. Navigating actions wait for load unless `"wait": "none"`. A final
`click`/`fill`/`select`/`press` reports its snapshot diff like the single command (`--snapshot none` skips it); earlier
steps observe only when asked. `--json` returns `{steps: [{action, data}], failed?: {step, action, error}}`.

`page monitor start|read|stop <tab>` captures failed requests (HTTP >= 400 and network errors, via `webRequest`,
persisting across navigations) plus console errors/warnings, uncaught errors, unhandled rejections, and dialogs (hooked
in the page's main world and re-attached after each navigation; reload after `start` to catch load-time output).
`read` prints entries since the last read (`--keep` leaves them); `stop` prints the rest. `start --dialogs
accept|dismiss` answers alert/confirm/prompt without showing them (default `pass` shows them, which blocks the page and
later commands). Buffers hold 500 entries per tab; monitors end when the extension background restarts
(`MONITOR_NOT_STARTED`). No debugger is attached, so Chrome shows no debugging banner.

`page viewport <tab> [--width W] [--height H] [--reset]` sets the page viewport to W x H CSS pixels (one flag keeps
the other dimension); `--reset` undoes it; with no flags it prints the current viewport. Only the size changes: no
touch, device pixel ratio, or user agent emulation. Tabs outside the agent window are refused
(`VIEWPORT_WINDOW_DENIED`). The response's `scope` says what changed:

- `tab` (Chrome): CDP `Emulation.setDeviceMetricsOverride` on that tab only, at any width. The debugger stays
  attached, so Chrome shows its debugging banner, until `--reset`, the tab closes, or the user cancels the banner.
- `window` (Firefox, which has no emulation API): the agent window is un-maximized and resized, affecting all its
  tabs, and its title gets the `titleMarker` prefix (`[bctl <windowId>] `). When `aerospace` is on `PATH`, the CLI
  floats that window so tiling does not undo the resize, and tiles it again on `--reset`, which also restores the
  window's original size. Firefox windows stop near 500px wide.

The reached size is reported with `exact: false` when it differs. Firefox does not lay out a window on a hidden
workspace: the window is resized, but the page keeps its old size until the window is shown, reported as
`deferred: true` with that old size.

## Walkthrough mode

`guide` lets an agent coach a human through a page instead of acting. Each step draws a card with instructions and
amber marks around elements, then blocks until the human responds in the browser:

```sh
bctl page snapshot 123                         # find refs for the step
bctl guide step 123 --text "Copy the API key, then tick both boxes." \
  --mark '@e4|copy this' --mark '#webhooks' --mark 'text=Send receipts'
bctl guide wait 123                            # after a timeout or --no-wait
bctl guide clear 123                           # remove the card when done
```

`--mark 'LOCATOR|label'` takes a ref, `text=...`, or a CSS selector; the label follows the last `|` (unlabeled marks
are numbered), so a selector containing `|` needs a label. Every mark must resolve to exactly one visible element,
otherwise the step fails (`SELECTOR_NOT_FOUND`, `AMBIGUOUS_MATCH`) before anything is drawn. Marks follow scrolling,
resizes, and DOM changes; the page scrolls to the first mark when it is off-screen. The card has an optional reply
box and four buttons: `No, let's talk`, `Send` (reply only), `Do it for me`, and `Got it, next`. It sits in a closed shadow root,
so page scripts cannot press its buttons. The human can drag the card by its title bar (the spot sticks for later steps on that
page) and fold it to the title bar with `-` / `+`; each new step opens unfolded.

`--text` renders a Markdown subset: paragraphs, `#` headings, `-` / `1.` lists, `**bold**`, `*italic*`, and
`` `code` ``. HTML and `_` emphasis stay literal, so `snake_case` names are safe. Long text scrolls inside the card.
A ```` ``` ```` fenced block renders as a copy box with a clipboard button, for text the human pastes into the page
(a URL, key, or snippet); the button copies the block verbatim. Fences may be indented under a list item.

`guide step` (unless `--no-wait`) and `guide wait` print `{tabId, step, action, reply?, url, title, interactions}` (no `url`/`title` when `closed`):

| action | meaning |
| --- | --- |
| `next` | the human did the step; `reply` carries an optional note |
| `reply` | the human sent a message; the card stays, so revise it with another `guide step` |
| `talk` | the human wants to discuss; stop calling tools and end the turn |
| `delegate` | the human asks the agent to do this step itself (`reply` may narrow it); do it, then continue with the next `guide step` |
| `navigated` | the main frame navigated (`url`); returns once the new page loads (up to 10s), and the card shows "preparing the next step" there |
| `closed` | the tab closed, the guide was cleared, or agent access ended |
| `timeout` | no response within `--timeout` (default 9m, under agent shell limits); the card stays up |

`interactions` lists trusted clicks and inputs on marked elements since the last result (`{ref, label, event}`,
`event` is `click` or `input`; toggling a checkbox or radio is one `click`). Responses that arrive between waits are
queued, so nothing is lost after a timeout. Guides work on tabs the session can access (the agent window, or a
personal tab with `--personal-tab`). They end when the tab closes, the session that drew them ends (`session end` or
the popup), the human turns off agent access to the tab (Stop or the popup), or the extension background restarts. A
session shows one guide at a time: a `guide step` on another tab ends the session's guide on its earlier tabs, and
their cards point to the new tab with a "Go to that tab" button. When the step's window is showing one of the session's own tabs,
`guide step` also switches that window to the step's tab; it never takes over a personal or other task's tab and never
focuses the window. Every `guide step` makes the CLI send a desktop notification
with the card title and the step's first line, so the human knows a new instruction is waiting. The step that opens a
session's guide returns `started: true` and pings "Agent guide started"; later steps ping "Agent guide: new step". Clicking the notification runs
`bctl --browser <id> human tabs focus <tab-id>` to bring the guided tab forward.

## Human-operated tab switchers

For an operator listing or closing tabs directly from the CLI:

```sh
bctl human tabs list                             # all windows in the sole connected browser
bctl --browser zen-01 human tabs list --json      # one browser, structured metadata
bctl human tabs list --all-browsers --json        # all windows in all connected browsers
bctl human tabs focus 123                         # focus a tab and raise its window
bctl human tabs focus lbcat://tab/zen-01/123      # same, from a tab link
bctl human tabs close 123 456                     # close tabs in any window
```

`human tabs list`, `human tabs focus`, and `human tabs close` use the switcher SDK below, without an agent window or task session.
`human tabs close` refuses only the agent window marker.
`--browser` takes precedence over `--all-browsers`; with multiple browsers, select one or use
`--all-browsers`. JSON responses use `cmd: "switcher.tabs.list"`. These CLI entrypoints give no page
access; ordinary `tabs` and `page` commands keep their agent restrictions. Session and
personal-tab flags do not apply to human commands. Agents must not use them to bypass scope restrictions.

Human-operated applications such as combo-switcher use the explicit Go SDK constructor
`browsercontrol.NewSwitcher(ctx)`. The existing `browsercontrol.New(ctx)` keeps agent-window restrictions.
The switcher client uses `switcher.tabs.list`, `switcher.tabs.focus`, `switcher.tabs.close`, and
`switcher.tabs.subscribe` to list browser-visible tabs across windows, focus or close the user's chosen tab
(`CloseTab`), and receive tab events without an agent
window or task session. Tab listing includes private tabs only when the browser grants the extension access.

Switcher tab listings and `switcher.tabs.event` tabs carry `agent` (`model.Tab.Agent`) when Browser Control
manages the tab, so a switcher can filter or badge those tabs without anything visible to the page:
`{"role": "marker" | "work" | "granted", "label"?, "paused"?}`. `marker` is the agent window's pinned marker,
`work` a work tab in the registered agent window, `granted` a personal tab the user allowed agents to use.
`label` and `paused` come from the live task that owns the tab. Tabs with agent access switched off, and every
tab after a browser restart until the agent window is confirmed again, have no `agent`. Agent-scoped `tabs`
listings and events never carry it. Available since LBcat 4.33.0.

Switcher access provides tab metadata, focus, and close only; there are no switcher page-execution, content,
capture, or userscript commands. `switcher.tabs.event` messages are routed only to connections whose
switcher subscription succeeded for that browser. Ordinary agent event streams remain scoped to the
registered window. This is an explicit application API, not authentication of a human or a separate
operating-system trust boundary; local clients can select it. Agents must keep using the scoped API.

`tab-focused` events carry `source`: `user` for a switch the user made in the browser UI, `switcher` when the
focus came from `switcher.tabs.focus`, and `agent` when the extension focused the tab for an agent command
(`tabs focus`, `tabs create --active`, a foreground capture, a guide hand-off). A consumer recording a human's
browsing history should treat `switcher` as a human choice and decide for itself whether `agent` counts.

Subscribing to `tab-focused` also reports browser window switches: when a window gains focus, its active tab is
reported as `tab-focused`, because no tab was activated and the browser raises no activation of its own. The
`source` rules above apply. Returning to the browser from another app reports the same tab again.

Deploy the matching extension and daemon before updating a consumer to `NewSwitcher`; older versions
do not support the commands or isolated event routing. `NewSwitcher` checks the daemon's `switcher-tabs`
capability and rejects older daemons before any switcher commands are sent. combo-switcher must refresh its vendored SDK
and use `NewSwitcher` for both tab loading and its event/focus clients.

## Releasing the CLI

`just dist <url-base>` (from this directory) builds `lbcat-<version>-darwin-{arm64,amd64}.tar.gz` and a rendered
Homebrew formula into `bin/dist/`, using the version in the root `package.json`. Publish in this order:

1. Tag `v<version>` and create a GitHub release on `latentbyte/lbcat` with both tarballs.
2. Copy `bin/dist/lbcat.rb` to `Formula/lbcat.rb` in `latentbyte/homebrew-tap`.

`<url-base>` is the release download URL, `https://github.com/latentbyte/lbcat/releases/download/v<version>`. Without
it the formula points at local `file://` tarballs for testing in a throwaway tap.
