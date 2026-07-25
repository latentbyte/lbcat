# Mobile userscript management proposal

Status: possible feature, not committed

## Goal

Let users run ScriptCat-managed userscripts on mobile devices and receive remotely managed script installs, updates,
disables, and removals.

Desktop, Android, and iOS clients should share one authenticated management protocol. Browser integration remains
platform-specific.

## Platform feasibility

| Platform               | Extension approach                               | Feasibility              | Main limitation                                                    |
| ---------------------- | ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------ |
| Firefox for Android    | Existing Firefox WebExtension build              | High                     | No usable desktop-style Browser Control native host                |
| Firefox for iOS/iPadOS | None                                             | Not supported            | Firefox iOS does not support Firefox WebExtensions                 |
| Safari for iOS/iPadOS  | Separate Safari Web Extension and containing app | Medium, separate product | App Store policy, Safari APIs, and restricted background execution |

### Android

Original ScriptCat is available for Firefox Android, so the core userscript model is proven on that platform. Our fork
still needs Android-specific manifest metadata, API compatibility checks, mobile UI testing, Mozilla signing, and
distribution.

Recommended distribution:

- publish the fork through addons.mozilla.org for normal installation and automatic extension updates
- use a Mozilla-signed self-distributed XPI only for private testing or controlled deployment
- declare Android compatibility in `browser_specific_settings.gecko_android`

The current Firefox build removes Chrome-only `offscreen` and `userScripts` permissions. Remaining APIs and fallback
script injection must be tested on an actual Android release. Features such as downloads, notifications, persistent
background work, and desktop-oriented UI may behave differently.

### iOS and iPadOS

The existing extension cannot run in Firefox for iOS or iPadOS. Supporting Apple mobile devices requires a separate
Safari Web Extension packaged in a native iOS app and distributed through the App Store.

Reusable code may include:

- userscript metadata parsing
- update comparison and conflict handling
- shared data models
- remote protocol client
- script repository and sync formats

Platform-specific code would include:

- installation and permissions UI
- Safari content-script registration and injection
- background scheduling
- secure credential storage
- App Store packaging and review compliance

An iOS client should therefore be planned as a separate product sharing libraries and backend services, not as another
target of the current Firefox build.

## Remote management

### Existing Browser Control path

Desktop Browser Control connects through `chrome.runtime.connectNative()` to `com.latentbyte.browser_control`. It
already exposes script create, update, push, delete, and toggle operations.

This path should remain the desktop transport. It should not be the mobile transport because normal mobile Firefox and
Safari installations cannot install or invoke our desktop native messaging host.

### Existing cloud-sync path

Cloud sync can provide an initial Android proof of concept. ScriptCat already synchronizes scripts through supported
remote filesystems and installs scripts pulled from them. Current automatic sync runs once per hour.

Advantages:

- little new extension code
- existing conflict and script installation paths
- works through outbound HTTPS requests

Limitations:

- eventual rather than immediate delivery
- shared-folder semantics rather than per-device commands
- no command acknowledgement or device inventory
- remote file timestamps and conflicts affect outcomes
- users must configure cloud credentials on each device

### Proposed mobile transport

Add an authenticated HTTPS management API. Mobile clients periodically pull commands using browser alarms and also
refresh when opened.

Suggested flow:

1. User explicitly pairs a device using a short-lived code or QR code.
2. Backend issues a device-scoped credential stored in extension or app secure storage.
3. Client polls for commands with a monotonic cursor.
4. Client validates command signature, target, policy, and script metadata.
5. Client applies command through the existing script service where available.
6. Client reports acknowledgement, resulting script version, and sanitized error details.

Initial command set:

- `script.install`
- `script.update`
- `script.enable`
- `script.disable`
- `script.remove`
- `sync.request`

The protocol should be transport-neutral so desktop Browser Control, Android Firefox, and a future iOS Safari client can
expose consistent behavior.

## Delivery expectations

Mobile operating systems suspend browsers and extension background processes. Polling is therefore eventually
consistent:

- updates may arrive while Firefox or Safari is active
- alarms may be delayed by power management
- force-closed browsers may not process commands until reopened
- real-time delivery must not be promised

A manual "Sync now" action and visible last-sync status are required.

## Security requirements

Remote userscript installation is remote code execution within every site permission granted to the manager. Minimum
safeguards:

- explicit user opt-in and visible paired-device state
- device-scoped, revocable credentials
- TLS for all network traffic
- signed commands or signed immutable script artifacts
- script digest and expected version validation
- strict tenant and device authorization
- confirmation policy for new scripts or expanded permissions
- audit log for actor, device, action, digest, and result
- rollback to a previously accepted script version
- rate limits and replay protection
- remote disable and device revocation
- no secrets in script source, command payload logs, or telemetry

App Store and AMO policy review must happen before implementation. Silent executable-code delivery may require user
confirmation or may be restricted by store policy, especially on iOS.

## Proposed rollout

### Phase 1: Android compatibility spike

- add Android manifest compatibility metadata
- avoid initializing Browser Control native messaging on Android
- build and sign a Firefox package
- test install, script execution, update checks, permissions, options UI, and popup UI on a physical device
- validate WebDAV or S3 cloud sync as remote delivery

Exit criterion: one Android device reliably installs the extension and receives a script update through existing cloud
sync.

### Phase 2: Managed Android pilot

- define versioned command protocol
- implement device pairing and credential revocation
- add polling, acknowledgement, manual sync, and status UI
- add command validation, audit logging, and rollback
- test suspended, offline, and conflicting-update behavior

Exit criterion: paired Android devices eventually apply authorized commands and report deterministic results.

### Phase 3: iOS feasibility prototype

- create minimal Safari Web Extension wrapper
- test content injection and required userscript APIs
- review App Store remote-code rules against the proposed protocol
- identify reusable packages and unsupported GM APIs
- estimate separate product maintenance cost

Exit criterion: policy and technical evidence support a bounded iOS implementation plan.

## Open decisions

- Is hourly cloud sync sufficient, or is per-device command delivery required?
- Must remote installs be silent, or can users approve new scripts and permission expansion?
- Which cloud or management backend owns device identity and audit records?
- Which GM APIs are mandatory for the first Android release?
- Is Safari acceptable on iOS, given Firefox iOS cannot host the extension?
- Does iOS usage justify a separately packaged and reviewed application?

## Recommendation

Implement and validate Android first. Reuse existing cloud sync for the smallest proof, then add a platform-neutral
HTTPS command protocol only if targeted management is required. Treat iOS Safari support as a later, separately scoped
product using the same protocol and shared core libraries.
