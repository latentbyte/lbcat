---
name: browser-control
description: "Control the user's signed-in local browser through bctl, restricted to its registered agent window and task-owned tabs. Use a separate isolated browser for work that must not touch that profile."
---

# Browser Control

Use `bctl` as shorthand for `browser-control`; do not introduce legacy CLI names.
This backend shares the user's browser profile and logins. It requires the
connected extension, native messaging, and direct access to the local daemon;
it does not create an infrastructure browser.

Maintained in LBcat (`latentbyte/lbcat`): `backend/browser-control/` and
`src/pkg/browser-control/`. Recheck this skill when their command, session,
window-scoping, event, or screenshot contracts change.

## Choose access

- Use bctl for app testing and any task that needs the user's existing
  signed-in local browser state.
- For isolated browser work, use a separate remote or managed browser (for
  example Portable Browser), including in environments without access to the
  user's local daemon.
- Direct CDP access to the personal browser is not a fallback for bctl's window,
  tab, session, or capture restrictions. Stop on those errors.

When unsure, `bctl daemon status --json` and `bctl browsers` show whether the
daemon is reachable and which browsers are connected. A detected debug port
does not authorize access to personal tabs.

```bash
command -v bctl
bctl browsers --json
```

If `bctl` is missing, use `browser-control`. Commands without a session
(`session begin`, `agent-window`, `human tabs`) need `--browser <name>` only
when several browsers are connected. It accepts a browser name (`zen`) when
only one browser of that name is connected, or a connection ID (`zen-01`);
prefer the name, since IDs renumber on reconnect. Never use profile names or
macOS window IDs. Session handles carry their browser, so session commands
need no `--browser`.

## Registered agent window

All ordinary tab inspection, page interaction, creation, and tab events stay in
one registered, same-profile agent window. Registration uses an unpinned extension
marker plus saved window/tab/URL identity. A title, tab group, workspace, or
currently focused window is not authorization. Leave the marker open and unpinned
(Zen clones pinned tabs into every new window). After a browser restart the
extension rebinds to the single tab with the registered marker URL and drops
old tab grants; duplicate copies fail closed as missing.

Only create or designate a window when the user/operator explicitly requests
setup, except for recovering from `AGENT_WINDOW_MISSING` (see below). Never
designate the user's active window to recover from a missing registration.
Setup commands:

```bash
bctl --browser <name> agent-window create
bctl --browser <name> agent-window create --ask   # waits up to 9m for a click
bctl --browser <name> agent-window list
bctl --browser <name> agent-window designate <window-id>
bctl --browser <name> agent-window status
bctl --browser <name> agent-window clear
```

`create` makes a background window in the same profile. `list` returns window
IDs and state without exposing personal tabs. `designate` requires the exact
window selected by the operator. Fresh windows grant only tabs created through
the task API; browser-inherited tabs remain outside scope. Designation explicitly
grants the window's existing non-marker tabs as a snapshot. Later unrelated tabs
do not gain access merely by appearing in that window. Older registrations without
stored grants require explicit re-designation to grant existing tabs. All marker
URLs, including markers from previous registrations, remain protected.

`agent-window status --json` reports `extensionVersion` and `manifestVersion`
from the connected extension. Compare these with the intended installed package;
version equality alone does not establish source commit parity.

`clear` removes registration and task leases;
these setup operations can invalidate existing sessions. Reload the matching
extension before using an updated CLI: its status preflight fails closed on
older extensions; do not bypass that check.

On `AGENT_WINDOW_MISSING`, read the cause in the message:

- `No agent window is registered`: run `bctl --browser <name> agent-window create`
  once, mention it in your report, then continue the task. If create fails or the
  error returns, stop.
- Any other cause (marker closed or moved, marker gone after an extension
  reload/update or browser restart, duplicate markers): run
  `bctl --browser <name> agent-window create --ask` once, with a shell timeout
  of at least 10m. It returns a live window unchanged, or sends a click-to-allow
  notification and creates the window after the click. Begin a new session (old
  handles are gone), mention it in your report, and continue. On
  `AGENT_WINDOW_APPROVAL_TIMEOUT` or any other failure, stop and report the
  missing window, quoting the cause.

The CLI automatically sends one desktop notification per missing-window
outage (also for the self-created case; a successful create clears the latch;
the `--ask` approval ping replaces it). Do not send a duplicate ping or loop
retries. Continue when the operator restores scope.

Optional AeroSpace placement: move only the
operator-identified macOS window to their chosen workspace without following
focus. Browser `windowId` and AeroSpace/macOS window ID are different namespaces.
Do not infer the intended window from its title or workspace alone. Workspace
placement is convenience; registered browser identity enforces access.

Window separation preserves logins, but cookies, account changes, and other site
state remain shared. Page JavaScript and site-created popups are not contained
by a full browser sandbox. Avoid claiming profile or account isolation.

Operators can list tab metadata across windows with `bctl human tabs list` and
close any tab except the agent marker with `bctl human tabs close <tab-id>...`:

```bash
bctl --browser <name> human tabs list --json
bctl human tabs list --all-browsers --json
```

Without a browser flag, a sole connected browser is selected; multiple browsers
require `--browser` or `--all-browsers`. `--browser` takes precedence when both
are supplied. This command uses the switcher API without an agent window or task
session; JSON responses identify `switcher.tabs.list`. It provides metadata only,
not page access. Session and personal-tab flags do not apply. This operator
entrypoint does not authorize agents to discover personal tabs or recover from
scope errors.

Human-operated tab switchers share the narrow SDK entrypoint:
`browsercontrol.NewSwitcher(ctx)`, using `switcher.tabs.list`,
`switcher.tabs.focus`, `switcher.tabs.close`, and `switcher.tabs.subscribe`. It provides browser-visible
tab metadata, user-chosen focus, and events across windows without agent
registration. Switcher events reach only successfully subscribed connections;
the matching extension and daemon must both support this routing. This API does
not authenticate a human and does not provide page execution or capture. Agents
must use the scoped API; never select switcher commands to bypass missing-window,
tab ownership, pause, or personal-tab restrictions. See ScriptCat's
`backend/browser-control/README.md` for consumer integration.

## Task sessions and tab ownership

Each task or subagent starts its own session; do not share another task's ID.
`session begin` prints a handle such as `zen:ab12cd34` (browser name and ID);
`--json` returns it as `data.sessionId`. Pass the literal handle with
`--session <s>` on every tab/page/note/guide command; it routes to the owning
browser, so do not also pass `--browser`. Shell exports usually do not persist
between agent tool calls; do not stash the handle in a temp file or re-export
env vars per call. Always pass `--label "<agent>: <task>"` (or set
`BROWSER_CONTROL_LABEL`) so the user can see which task owns each tab: the label
appears on the toolbar badge and as a page border with a Stop button.

```bash
bctl session begin --label "<agent>: <task>"     # prints <s>, e.g. zen:ab12cd34
bctl --session <s> tabs create https://example.com --active=false --json
# retain the returned tab ID, then use that exact ID
bctl --session <s> page content <tab-id> --selector main
bctl --session <s> session renew
bctl --session <s> tabs close <tab-id>          # close tabs you are done with
bctl --session <s> session end --close-tabs     # closes remaining work tabs too
```

Create inactive tabs and retain returned IDs instead of finding targets by title,
position, or whichever tab is active. Existing eligible tabs can be claimed with
`session claim <tab-id>`; tab access also claims ownership. `tabs list --json`
shows granted tabs eligible for the task. `tabs watch --json` receives events for
granted work tabs, including tabs leased by other tasks; an event
does not grant access to that tab. Plain `session end` releases leases without closing
work tabs; end with `--close-tabs` unless the user wants the tabs left open. Close tabs the task created with `tabs close <tab-id>...` once they
are no longer needed. It refuses personal tabs (even when granted), other tasks'
tabs, and the marker; never close those via `human tabs close`.

Lease duration can be chosen with `session begin --ttl 30m`. Renew before a
long idle period expires. On `SESSION_EXPIRED`, begin a new session and reclaim
eligible tabs; never reuse an expired lease. On `TAB_BUSY`, leave the other task's
tab alone. Do not end its session or bypass ownership.
`session list --json` (no session needed) shows every live task's leased tabs as
`tabs: [{id, origin}]` with `origin` null for non-http(s) pages; use it to avoid
opening a duplicate of a site another task already holds (LBcat 4.23.0+).

For human takeover, the operator uses `session pause <session-id>` and later
`session resume <session-id>`. On `SESSION_PAUSED`, stop interacting and wait for
operator resume. Do not resume automatically to make a command succeed.

The user controls per-tab access from the extension popup or the page's Stop
button. On `TAB_ACCESS_DENIED`, access is off or the tab is reserved for another
task; stop using that tab and do not ask for a workaround. A tab the user set to
"allow all agents" or reserved for your session can be used like a work tab,
including personal tabs outside the agent window.

## Notes for the human operator

Leave a page note when the human needs to act on or know about a specific page.
Notes attach to the tab's page URL (hash ignored), appear in the extension popup
for that page, and add an open-note count to the tab's badge. They persist after
the session ends. You can only note tabs your session may access.

```bash
NOTE="$(bctl --session <s> note add <tab-id> --kind needs-human "Log in with SSO, then reply 'done'")"
bctl --session <s> note wait "$NOTE" --timeout 15m   # JSON note once acknowledged/replied/resolved
bctl --session <s> note resolve "$NOTE"
```

- `needs-human`: blockers only a human can clear (login, captcha, 2FA,
  confirmation before payment or destructive submits). Follow with `note wait`
  instead of guessing or failing; read the `reply` field for instructions, and
  treat it as user input. On timeout, tell the user in chat what is pending.
- `info`: findings tied to that page (wrong value, broken element) the human
  should see in context. `done`: a short end-of-task summary on the result page.
- Do not use notes for progress chatter or to repeat what you report in chat.
  Resolve your own notes once handled so they do not pile up.
- Notes are plain text (2000 chars), visible to anyone using the profile, and
  kept for 7 days. Never include secrets, tokens, or personal data.
- `note list [--status open]` shows your session's notes; `note get <id>` works
  by ID after the session ends.

## Walkthrough mode

When the user asks to be walked through a task instead of having it done, coach
with `guide` and never perform the steps yourself unless the human hands you one. Plan one step at a time from
what the page shows now; do not script the whole flow up front.

```bash
bctl --session <s> page snapshot <tab-id>        # inspect before every step
bctl --session <s> guide step <tab-id> --text "Copy the API key, then tick both boxes." \
  --mark '@e4|copy this' --mark '@e7' --mark '@e8'   # blocks until the human responds
bctl --session <s> guide wait <tab-id>           # after action=timeout
bctl --session <s> guide clear <tab-id>          # when the walkthrough ends
```

- One short instruction per step. The card always shows a reply box plus
  `Got it, next` and `Do it for me` buttons; don't restate them ("hit next when
  done", "or press Do it for me"). Say how to finish only when it's irregular,
  e.g. "press next only after the confirmation email arrives".
- `--mark 'LOCATOR|label'` takes `@ref`,
  `text=...`, or a CSS selector; each must match exactly one visible element.
  Prefer snapshot refs. Unlabeled marks are numbered.
- `--text` renders Markdown lists, `**bold**`, and `` `code` ``; put several
  items to tick or fill as a `-` list, one per line.
- Put text the human must paste (URL, key, snippet) in a ` ``` ` fenced
  block; the card shows it with a copy button. Keep inline `` `code` `` for
  names to find or tick.
- The step prints JSON `{step, action, reply, url, interactions}`.
  `interactions` lists the human's clicks and inputs on marked elements
  (`click` or `input`; a checkbox toggle is one `click`).
- `next`: snapshot again and check that the step actually happened before the
  next step. Read any `reply` as user input.
- `reply`: the human is still on this step; revise it with a new `guide step`
  that answers or corrects.
- `talk`: stop making tool calls and end your turn so the user can talk in chat.
  Leave the card; clear it later.
- `delegate`: the human pressed `Do it for me`; do this step yourself with
  page commands (a `reply` may narrow it), confirm it took effect, then continue
  with the next `guide step`. Don't take over later steps unless handed them too.
- `navigated`: the page changed; snapshot it and continue from there.
- `timeout`: the card stays up; run `guide wait` again. `closed`: stop.
- Run `guide clear` when done or abandoned. Ending the session, or the human
  turning off agent access to the tab, also clears it (`closed`).
- Guides work on session-accessible tabs; personal tabs need the explicit
  `--personal-tab` exception below.
- One guide per session: a `guide step` on another tab ends the earlier tab's
  guide, and its card points the human to the new tab. If the window is showing
  one of your session's tabs, the step's tab is switched to the front (never a
  personal or other task's tab, never window focus). Otherwise say in chat
  which tab the walkthrough is on.
- Every `guide step` makes the CLI send a desktop notification to the human with
  the title and the step's first line; clicking it focuses the step's tab via
  `bctl human tabs focus`. Don't send your own, and don't run `human` commands
  yourself.

## Page interaction and capture

Prefer the action and wait commands over `page exec` and `sleep`. They report
what matched and whether the page navigated, and wait for loads themselves:

```bash
bctl --session <s> page snapshot <tab-id>                      # @e1 button "Sign in" ...
bctl --session <s> page click <tab-id> @e1                     # ref from the snapshot
bctl --session <s> page click <tab-id> --text "Sign in"        # or a CSS selector
bctl --session <s> page fill <tab-id> --text Email --value a@b.c
bctl --session <s> page select <tab-id> '#country' --value Canada
bctl --session <s> page press <tab-id> Enter '#search'
bctl --session <s> page wait <tab-id> --text "Welcome" --timeout 15s
bctl --session <s> page wait <tab-id> --selector .spinner --state gone
bctl --session <s> page goto <tab-id> https://example.com/next  # back|forward too
bctl --session <s> page fetch <tab-id> /api/me --max-chars 4000  # page's cookies/origin
bctl --session <s> page viewport <tab-id> --width 390 --height 844  # mobile layout check
bctl --session <s> page viewport <tab-id> --reset                    # undo when done
bctl --session <s> page upload <tab-id> --text Attach --file ~/cv.pdf  # no file picker
bctl --session <s> page click <tab-id> --at 120,340            # viewport CSS px; canvas/maps only
```

A `page click` on a submit button can dispatch the click without submitting the form
(seen on React dialogs in Zen): no submit event, no request, no error. Confirm the
submit happened through a network or state change. If it did not, submit the form
directly: `page exec <tab-id> "document.querySelector('<button>').form.requestSubmit()"`.

`click`, `fill`, `select`, `press`, and `upload` print what the action changed
(`--snapshot diff`, the default): `+` added, `-` removed, `~` changed snapshot
lines with refs, or "snapshot unchanged". A new document prints the full
snapshot. Act on those refs directly; do not re-run `page snapshot` after each
action. `--snapshot full` forces the whole list, `--snapshot none` skips it.
A capped diff says so; run `page snapshot` only then. `snapshot unavailable`
means the action succeeded but observing failed: do not retry the action.

`--at x,y` clicks whatever is at that viewport point, entering open shadow roots
and same-origin iframes (`CROSS_ORIGIN_FRAME` otherwise). Use it only when no
ref, selector, or text targets the element. Take coordinates from a screenshot
using its CSS size, not bitmap pixels.

`page viewport` changes only the CSS viewport size; it does not emulate touch,
device pixel ratio, or a mobile user agent. On Chrome it emulates the size on
that tab alone at any width (Chrome shows a debugging banner until `--reset`).
On Firefox/Zen it resizes the whole agent window (all its tabs), floating it in
AeroSpace so tiling keeps the size; widths below about 500px are unreachable
there. If the agent window sits on a hidden workspace, Firefox keeps the old
layout until it is shown (`deferred: true`, printed as "window resized while
hidden"). To measure, note `aerospace list-workspaces --focused`, switch to the
agent window's workspace, run the viewport steps, then
switch back. Check the printed size (`exact: false` in JSON) instead of
assuming, and `--reset` when done. Do not use `window.open(..., "width=...")` hacks.

For two or more page steps on one tab, use one `page run` instead of chaining
`page` commands. Steps run in order, stop at the first failure (non-zero exit),
and only the last step reports its snapshot diff (inline steps: LBcat 4.30.0+):

```bash
bctl --session <s> page run <tab-id> 'fill @e34 --value "a@b.c"' \
  'select --text Category --value Games' 'click @e38'
```

Each quoted step is its page command without `page` and the tab ID, with the
same flags (`--wait none`, `--timeout 15s`, `--snapshot full` to observe an
earlier step). Quote values with spaces inside the step. Steps are not
shell-expanded; to use a variable, wrap the step in double quotes:
`"fill @e2 --value '$EMAIL'"`. Actions: `goto back forward reload click fill
select press wait content snapshot exec fetch viewport`. Snapshot first when
refs are unknown. Long or generated flows can pass a JSON array instead
(`-f steps.json`, or `-f -` with a heredoc): `[{"action": "fill", "text":
"Email", "value": "a@b.c"}, ...]`, camelCase argument names, `"timeout":
"15s"`, click takes `"x"`/`"y"`.

When one shell call runs dependent bctl commands (actions, then `note add`),
join them with `&&`, not `;`. After `;` a failed step lets the rest run, and a
note can claim work that never happened.

To debug a broken page, capture instead of guessing:

```bash
bctl --session <s> page monitor start <tab-id> --dialogs dismiss
bctl --session <s> page reload <tab-id>
bctl --session <s> page monitor read <tab-id>   # failed requests, console errors, dialogs
bctl --session <s> page monitor stop <tab-id>
```

Use `--dialogs dismiss` (or `accept`) for unattended work; the default `pass`
shows dialogs to the user and blocks the page and later commands.

Actions, `goto`/`back`/`forward`/`reload`, and `tabs create` wait for any
navigation they start (`--wait load`, the default; `--wait none` to skip).
Start an unfamiliar page with `page snapshot` (far smaller than HTML or a
screenshot), then act on refs. `REF_NOT_FOUND` means the page changed: snapshot
again. `AMBIGUOUS_MATCH` lists candidates; narrow the selector/text or pass `--nth N`.
`WAIT_TIMEOUT`/`LOAD_TIMEOUT` mean the condition never held; inspect the page
instead of looping. Never add fixed sleeps after these commands.

Use explicit tab IDs, targeted selectors, and structured output as needed:

```bash
bctl --session <s> tabs get <tab-id> --json
bctl --session <s> page content <tab-id> --selector main --format markdown --max-chars 8000
bctl --session <s> page exec <tab-id> "({title: document.title, url: location.href})"
bctl --session <s> page exec <tab-id> -f /tmp/browser-task.js
bctl --session <s> page reload <tab-id>
bctl --session <s> page screenshot <tab-id> --selector '#app' --output /tmp/shot.png
```

`page exec` returns a single expression's value (await allowed, `{a: 1}` is an
object), or the last statement's value; top-level `return` also works. Promises
in a returned object/array are awaited. Return plain data, not DOM nodes
(`RESULT_NOT_SERIALIZABLE`). Use `--max-chars N` (exec and content) instead of piping to `head`; markdown
content keeps links and headings and drops hidden elements.

`await` nested inside a call argument fails with `SCRIPT_ERROR` ("missing ) after
argument list"): `out.push(await f())` breaks, `const r = await f(); out.push(r)` works.
Assign awaited values to a `const` first.

Dynamic `page exec` supports `MAIN` only. MV3 dynamic execution in `ISOLATED` is
unsupported; JavaScript exceptions are reported as errors. On pages whose CSP
forbids eval, exec falls back to source injection (Chrome 135+): use `return`
for a value from multi-statement code there. `CSP_BLOCKED` means no fallback
was available; use `page content`/`snapshot`/actions instead. Do not
recommend `ISOLATED` as the default or hide execution failures.

Same-tab page operations run in order; different tabs can proceed concurrently.
Every page operation has a timeout; a queued one that expires does not run later.
Caller timeout cannot cancel already-running work. While a timed-out operation
remains active, later operations fail promptly with `TAB_EXECUTION_PENDING`; wait
for it to finish or `page reload` the work tab when the task authorizes recovery. A committed full-document
navigation resets the old queue. Hash/history changes do not. Do not release the
queue or launch overlapping effects merely because the caller timed out.

Screenshots default to background capture. Prefer `--selector` to full-page
captures. `BACKGROUND_CAPTURE_UNAVAILABLE` means the browser cannot provide the
requested capture without activation. Report it; do not focus, take an OS
screenshot, switch to unrestricted CDP, or create a new profile to bypass it.

`--region x,y,w,h` captures a viewport rectangle (CSS pixels, must lie inside
the viewport) at device resolution; use it to read small text instead of a
full-page shot. Not combinable with `--selector` or `--full-page`.

`--max-pixels` limits the decoded bitmap when saving with `--output`, including
high-DPI captures. Saved output reports both bitmap and CSS size (`cssWidth`,
`cssHeight` in JSON); map image points to `--at` through the CSS size. Do not
infer the image's pixel count from CSS size.

Tabs that are not selected in their window get no animation frames and ~1s
timers, though the page may still report `visible`. Plain HTML loads fine;
canvas apps (Flutter web, some dashboards) sit on their loading screen. When a
wait times out with "not the selected tab", or such an app shows nothing, run
`bctl --session <s> tabs focus <tab-id>` (no `--foreground`): it selects the tab
inside the agent window without focusing the window, so it needs no approval.
On `TAB_BUSY` the window is showing another task's tab; leave it. Do not
diagnose the site as stuck before selecting the tab (LBcat 4.32.2+).

Foreground interaction requires explicit user approval for that focus change:

```bash
bctl --session <s> tabs focus <tab-id> --foreground
bctl --session <s> page screenshot <tab-id> --foreground --output /tmp/shot.png
```

`--active` activates a new tab within the agent window; prefer `--active=false`.
Exception: timing and performance work. Inactive tabs clamp `setTimeout`/`setInterval`
to about 1 tick per second while still reporting `visibilityState` visible, which
fakes stalls and long tasks. Create that tab with `--active=true` (still no
`--foreground`) and sample with `MessageChannel` rather than timers.
Never add `--foreground` or `--focus-on-error` merely to retry a failed capture.

Foreground fallback restores scroll after success and errors, but does not
restore the previous active tab. It leaves the target selected unless selection
changes externally. Full-page stitching includes horizontal overflow. Selector
capture requires the entire element to fit inside the viewport after scrolling;
otherwise it fails explicitly and requires background capture for complete pixels.
External tab activation during capture fails rather than returning another tab's
image. JPEG quality applies to the final crop or stitched image.

A personal-tab exception requires the user's explicit task instruction naming
that exact tab. Pass `--personal-tab <tab-id>` on the authorized call alongside
the session and target tab ID. This does not authorize the surrounding window,
other tabs, foreground focus, or general personal-browser discovery. Never infer
blanket permission from an exception or widen the ID after access fails.

## Userscripts and operations

Userscripts are managed with `bctl script` (see `bctl script --help`). Script management is a separate,
profile-wide operation; window/session confinement does not isolate its effects.

Daemon is managed externally. Do not start, stop, restart, or manage
`browser-control-daemon` unless explicitly asked. Runtime state usually lives
in `~/.local/state/browser-control`.

- `cannot connect to daemon`: report exact connection error; do not manage daemon.
- `no browsers connected`: extension or native messaging bridge is disconnected.
- `multiple browsers connected`: select the intended ID from `bctl browsers`.
- `SELECTOR_NOT_FOUND`: the selector matched nothing on the current page; re-check the page instead of retrying blindly.
- Scope, ownership, pause, and capture errors: follow the stopping conditions above.

Do not substitute a remote or isolated browser session when the task requires
the user's existing local login state.
