## LBcat fork notes

Fork of `scriptscat/scriptcat` (remote `upstream`); `origin` is the fork, work lands on `dev`. Ships as **LBcat**
(`package.json` name `lbcat`); keep upstream identifiers and the add-on ID (see `docs/DEVELOP.md` -> LBcat releases).
The upstream guidance below still applies.

- Bump the version with every change, plain semver `x.y.z`: `just set-version x.y.z` (writes `package.json` and
  `src/manifest.json` together; never edit one by hand).
- Commands (`Justfile` wraps pnpm): `just check` (tsc + eslint; existing warnings, 0 errors expected), `just test`,
  `pnpm test:ci`, `just fmt`. Go side: `just bctl-test`, `just bctl-check`. `just bctl-install` / `bctl-install-cli`
  write to `~/.local/bin` and native host manifests; don't run them unless asked.
- Gotcha: `pnpm test:ci` uses a 500ms `--test-timeout`. Tests that spawn processes (`scripts/*.test.js`) set a
  per-test `{ timeout: 10_000 }`; do the same for new ones. Avoid `describe.concurrent` for sync render tests:
  timers start together but bodies run serially, so they flake under load.
- Fork-only subsystems:
  - `backend/browser-control/` - Go: `browser-control` CLI (`bctl`), daemon (Unix socket), `lbcat-shim` Native
    Messaging host `com.latentbyte.browser_control`. Own justfile, `env.example`, README, `SMOKE-TEST.md`.
  - `src/app/service/service_worker/native-messaging.ts` - extension end of that bridge.
  - `src/pkg/browser-control/` - agent window, tab ops/access, capture, agent notes, tab indicator.
  - `src/app/service/agent/` - in-extension LLM agent: `core/` (providers, tools, MCP client, skills, scheduler),
    `service_worker/` (chat, LLM client, MCP, skill, sub-agent services).
- Browser Control integration skill: canonical source is `$HOME/dotfiles/templates/agents/skills/browser-control/SKILL.md`
  ([GitHub source](https://github.com/hamidzr/dotfiles/blob/main/templates/agents/skills/browser-control/SKILL.md)).
  Update it when `backend/browser-control/`, `src/pkg/browser-control/`, or agent browser tools change CLI commands,
  window registration, task leases, personal-tab overrides, notification behavior, or capture capabilities.

# Repository Guidelines

This file provides guidance to AI coding agents (Claude Code, etc.) when working with code in this repository.

> **Note:** This is the single source of truth. `CLAUDE.md` only contains `@AGENTS.md` and re-imports this file — do not add content to `CLAUDE.md`; put all guidance here in `AGENTS.md`.

> **Before writing any code, read [`docs/DEVELOP.md`](docs/DEVELOP.md)** — the development spec (commands,
> project structure, coding style, UI & theme rules, testing mechanics, i18n, and the commit/PR workflow). This
> file keeps only the non-negotiable engineering principles and the architecture map; the concrete "how" lives
> in `DEVELOP.md`, and deep internals in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

> **To manually verify a feature actually works, read [`docs/VERIFICATION.md`](docs/VERIFICATION.md)** — drive
> the real built extension end-to-end with one-shot throwaway scratch scripts (not the committed test suite).

> **Before any translation/localization work, read [`docs/translation/README.md`](docs/translation/README.md)** —
> the single source of truth for translation. Whenever you add or change localized content
> (`src/locales/<locale>/translation.json`, per-language docs, UI copy, or test snapshots), you must first read
> that guide and follow the matching `docs/translation/terminology-<locale>.md` if it exists.

> **Before adding, editing, reorganizing, or reviewing any contributor doc (this file or `docs/*`), read
> [`docs/DOC-MAINTENANCE.md`](docs/DOC-MAINTENANCE.md)** — keep the doc set organized (links resolve, index
> current, no duplication) and every claim factually true against the current branch (*if you can't grep it on
> this branch, don't claim it*).

> **Doc map:** [`docs/README.md`](docs/README.md) indexes every contributor doc (development, architecture,
> translation, contributing, localized READMEs).

## Project Overview

ScriptCat — Manifest V3 browser extension that runs Tampermonkey-compatible user scripts. TypeScript + React 18 + Rspack. Package manager is **pnpm** (preinstall enforces).

## Engineering Principles

These are non-negotiable and apply to every change, regardless of what `docs/DEVELOP.md` says about mechanics.

- **Fix root causes, not symptoms — refactor over patch.** No `as any` / `// @ts-ignore` / try-catch swallow / defensive skips to make errors disappear. When the clean fix needs restructuring, refactor rather than bolt on a patch (宁愿重构也不要打补丁). If a test fails, fix the code, not the test.
- **Confirm before you fix.** Before touching a reported bug, reproduce it and confirm it actually exists — never fix from assumption. Then capture it in a failing test, then fix, **in that order** (确定 bug 存在 → 写测试 → 修复).
- **TDD/BDD first.** Write failing tests **before** implementation, using BDD-style Chinese `describe`/`it` titles. (Runner, mocks, and how to run tests are in `docs/DEVELOP.md`.)
- **SOLID, high cohesion & low coupling — applied to the existing extension points.** `Repo<T>` for new entities, `Group.on(...)` for new messages. Inject `Group` / `IMessageQueue` / DAOs via constructor; don't `new` them inside methods. Depend on narrow interfaces (`IMessageQueue`, not `MessageQueue`).
- **Direct replacement over adapter sandwiches.** When swapping a backend/library, replace in place — no `interface Foo + LegacyImpl + NewImpl` unless both must coexist at runtime.
- **Scope discipline — stay in your lane.** Bug fix ≠ cleanup PR. Touch only the files the task requires; leave unrelated files untouched (不要动和任务不相干的文件). Don't add helpers, abstractions, validation, or backwards-compat shims you don't need today. Three similar lines beats a premature abstraction.
- **No dead code or `// removed` markers** — git remembers. Delete unused code outright.

## Architecture

> **Deep dive:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the human-facing internals guide for
> contributors working on ScriptCat core: process model, message passing, service/data layers, GM API system,
> script execution, and the build pipeline, with "how to extend" recipes. The section below is the quick map.

### Multi-Process Model

5 isolated contexts communicating via message passing:

```
Service Worker (src/service_worker.ts)
  ├── ExtensionMessage ──────────────→ Content Script (src/content.ts)
  │                                        └── CustomEventMessage ──→ Inject Script (src/inject.ts)
  └── ServiceWorkerMessageSend ──────→ Offscreen (src/offscreen.ts)   (Chrome; Firefox uses EventPageOffscreenManager)
                                           └── WindowMessage ──→ Sandbox (src/sandbox.ts)
```

> SW → Offscreen uses `ServiceWorkerMessageSend` (`clients.matchAll()` + `postMessage`) on Chrome and
> `EventPageOffscreenManager` on Firefox MV3; Offscreen replies to SW over `ExtensionMessage`. `WindowMessage`
> is the Offscreen ↔ Sandbox channel.

- **Service Worker** — central hub: script CRUD, chrome APIs, permission verification, resource caching, message routing
- **Content** — bridges SW and inject script
- **Inject** — runs in page context with `unsafeWindow`
- **Offscreen** — DOM-capable background environment for background/scheduled scripts
- **Sandbox** — isolated execution via `with(arguments[0])`; cron scheduling

Execution paths: page scripts → `chrome.userScripts`; background → SW → Offscreen → Sandbox; scheduled → cron in Sandbox.

### Message Passing (`packages/message/`)
`ExtensionMessage` (chrome.runtime — SW ↔ Content / Inject / Offscreen), `WindowMessage` (postMessage — Offscreen ↔ Sandbox), `ServiceWorkerMessageSend` (`clients.matchAll()` + `postMessage` — SW → Offscreen on Chrome), `CustomEventMessage` (CustomEvent — Content ↔ Inject), `MessageQueue` (cross-context broadcast).

### Service & Data Layers
- Services in `src/app/service/<context>/` — split by execution context. Constructor-injected `Group`, `IMessageQueue`, DAOs.
- DAOs in `src/app/repo/` extend `Repo<T>` (chrome.storage + cache): `ScriptDAO`, `ValueDAO`, `ResourceDAO`, `PermissionDAO`, `SubscribeDAO`.
- **GM API** split across content / SW / offscreen, each a `GMApi` (content built on `GM_Base`; SW — permission verify, cross-origin; offscreen — DOM-dependent background-script APIs); values via `ValueService`.

### Browser Extension APIs (MV3)
`chrome.userScripts` (page injection), Offscreen API (DOM in background), Declarative Net Request (intercepts `.user.js` URLs to trigger install flow).

### Key Packages

`message/` (with mocks), `filesystem/` (WebDAV + local), `cloudscript/`, `eslint/` (userscript lint config — `eslint-plugin-userscripts`-based `defaultConfig` for the in-app editor), `chrome-extension-mock/`.

> The project's own custom ESLint rule `require-last-error-check` (enforces `chrome.runtime.lastError` handling) lives in `eslint-rules/` at the repo root and is wired in `eslint.config.mjs` — not in `packages/eslint/`.
