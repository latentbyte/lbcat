# default: list available recipes
default:
    @just --list

# install dependencies
deps:
    pnpm install

alias get-deps := deps

# run all formatters (updates filesystem)
fmt:
    pnpm prettier --write .

alias format := fmt
alias fix := fmt

# run static analysis without changing filesystem
check:
    pnpm tsc --noEmit
    pnpm eslint .

alias lint := check

# build for production
build:
    pnpm build

# set project version, e.g. `just set-version 2.1.0`
set-version version:
    pnpm run set-version {{version}}

# start dev server
dev:
    pnpm dev

# run unit tests
test:
    pnpm test

# run unit tests (ci mode)
test-ci:
    pnpm test:ci

# run e2e tests
test-e2e:
    pnpm test:e2e

# run coverage
coverage:
    pnpm coverage

# build Browser Control Go binaries
browser-control-build:
    just -f backend/browser-control/justfile build

# build, install to ~/.local/bin, and register native host manifests
browser-control-install:
    just -f backend/browser-control/justfile install

# run Browser Control Go tests
browser-control-test:
    just -f backend/browser-control/justfile test

# run Browser Control Go static analysis
browser-control-check:
    just -f backend/browser-control/justfile check

# start Browser Control daemon in foreground
browser-control-dev:
    just -f backend/browser-control/justfile dev

# clean Browser Control build artifacts
browser-control-clean:
    just -f backend/browser-control/justfile clean

# run Browser Control smoke test
browser-control-smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    just browser-control-build
    just browser-control-test
    backend/browser-control/bin/browser-control-daemon &
    daemon_pid=$!
    cleanup() { kill "$daemon_pid" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true; }
    trap cleanup EXIT
    sleep 0.3
    backend/browser-control/bin/browser-control ping
    backend/browser-control/bin/browser-control daemon status
    backend/browser-control/bin/browser-control daemon stop
    wait "$daemon_pid" 2>/dev/null || true
    trap - EXIT

alias vmctl-build := browser-control-build
alias vmctl-install := browser-control-install
alias vmctl-test := browser-control-test
alias vmctl-check := browser-control-check
alias vmctl-dev := browser-control-dev
alias vmctl-clean := browser-control-clean
alias vmctl-smoke := browser-control-smoke

# pack the extension into distributable archives
pack:
    pnpm run pack

alias zip := pack

# pack source files for Mozilla review, excluding Browser Control tooling
mozilla-source:
    #!/usr/bin/env bash
    set -euo pipefail
    version="$(node -p "require('./package.json').version")"
    out="dist/scriptcat-v${version}-source.zip"
    mkdir -p dist
    rm -f "$out"
    zip -qr "$out" \
        package.json \
        pnpm-lock.yaml \
        pnpm-workspace.yaml \
        rspack.config.ts \
        postcss.config.mjs \
        uno.config.ts \
        tsconfig.json \
        scripts \
        src \
        packages \
        README.md \
        LICENSE \
        env.example
    echo "$out"
