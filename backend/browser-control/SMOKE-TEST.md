# Browser Control Smoke Test

End-to-end test of the CLI, daemon, shim, and extension communicating over Native Messaging. All commands run from the
repo root.

## Quick: automated Go-side smoke test

```sh
just browser-control-smoke
```

This builds, runs unit tests, starts the daemon, pings it, checks status, and stops it. No browser needed. If the
command exits zero, the Go side is working.

## Prerequisites

- Go 1.21+ (`go version`)
- Node.js 20+ (`node -v`), pnpm (`pnpm -v`) for extension build
- Chrome, Brave, Comet, Firefox, or Zen installed
- just (`brew install just` or `cargo install just`)

## Step-by-step manual test

### 1. Build Go binaries

```sh
just browser-control-build
```

Verify:

```sh
backend/browser-control/bin/browser-control --help
backend/browser-control/bin/browser-control ping          # should fail: "daemon not running"
```

### 2. Start daemon, ping it

Terminal 1:

```sh
just browser-control-dev                      # blocks, logs to stderr
```

Terminal 2:

```sh
backend/browser-control/bin/browser-control ping          # "pong from daemon (pid X) in Xms"
backend/browser-control/bin/browser-control daemon status # shows pid, socket, browser count
```

### 3. Install binaries + register native host manifests

```sh
just browser-control-install
```

This single command:

1. Builds the Go binaries
2. Copies them to `~/.local/bin/`
3. Writes native host manifests for every detected browser
4. Uses `--dev` flag, so it accepts both the store extension ID and any unpacked/dev extension ID (reads Firefox addon
   ID from `dist/manifest.json` or `dist/ext/manifest.json` if it exists)

No need to re-register when you reload an unpacked extension in Chrome, because Chrome unpacked extensions keep the same
ID across reloads. For a fresh `Load unpacked` with a new path, add the new ID:

```sh
browser-control install --dev --extension-id YOUR_NEW_ID
```

### 4. Build the extension

```sh
just deps          # first time only
just dev           # rspack watch, outputs to dist/
```

### 5. Load extension in browser

**Chrome / Brave / Comet**: `chrome://extensions/` -> Developer mode -> Load unpacked -> select `dist/ext/`

**Firefox / Zen**: `about:debugging#/runtime/this-firefox` -> Load Temporary Add-on -> select `dist/manifest.json`

### 6. Test CLI commands

```sh
browser-control ping                                # daemon reachable
browser-control daemon status                       # shows connected browsers
browser-control tabs list --all-browsers --json     # list all open tabs
browser-control tabs focus --browser chrome-01 123 --json
browser-control tabs close 123                      # agent: own agent-window tab only
browser-control human tabs close 123                # operator: any tab except the marker
browser-control events --json --type tab-focused,tab-removed,browser-connected,browser-disconnected
browser-control page exec 123 "document.title"      # run JS in a tab
browser-control script list                         # list userscripts
```

## Troubleshooting

### "daemon not running"

```sh
browser-control daemon status                              # process alive?
ls -la ~/.local/state/browser-control/browser-control.sock           # socket exists?
cat ~/.local/state/browser-control/browser-control.log               # daemon logs
```

### "no browsers connected"

The extension must initiate the connection. Check:

1. Is the native host manifest in the right directory for your browser?
2. Does `allowed_origins` match your extension's actual ID?
3. Does `path` point to the actual `lbcat-shim` binary?
4. Is `nativeMessaging` in the extension's manifest permissions?
5. Has the extension-side `native-messaging.js` been implemented?

### Debugging the shim

Test the shim manually (simulates what the browser does):

```sh
# requires daemon to be running
python3 -c "
import struct, json, sys
msg = json.dumps({'id':'test','type':'handshake','role':'browser','browser':'manual'})
sys.stdout.buffer.write(struct.pack('<I', len(msg)) + msg.encode())
sys.stdout.buffer.flush()
length = struct.unpack('<I', sys.stdin.buffer.read(4))[0]
print(json.loads(sys.stdin.buffer.read(length)))
" | ~/.local/bin/lbcat-shim
```

## Implementation status

All components are implemented:

1. **Extension native messaging listener** (`src/app/service/service_worker/native-messaging.ts`): calls
   `chrome.runtime.connectNative("com.latentbyte.browser_control")` and dispatches incoming commands to browser APIs.
   Auto-reconnects on disconnect.

2. **Extension manifest**: `"nativeMessaging"` added to permissions in `src/manifest.json`.

3. **Command handlers in extension**: `tabs.list`, `tabs.get`, `tabs.focus`, `tabs.subscribe`, `page.content`,
   `page.exec`, `script.list/get/create/update/delete/toggle/push`, `ping`.
