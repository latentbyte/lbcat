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

# clean generated artifacts
clean:
    rm -rf dist coverage test-results playwright-report .eslintcache
    just browser-control-clean

# build Chrome extension output
build-chrome:
    pnpm build:chrome

# build Firefox extension output
build-firefox:
    pnpm build:firefox

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

# 仅安装 Browser Control CLI
browser-control-install-cli:
    just -f backend/browser-control/justfile install-cli

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

alias bctl-build := browser-control-build
alias bctl-install := browser-control-install
alias bctl-install-cli := browser-control-install-cli
alias bctl-test := browser-control-test
alias bctl-check := browser-control-check
alias bctl-dev := browser-control-dev
alias bctl-clean := browser-control-clean
alias bctl-smoke := browser-control-smoke

# pack extension + source archives, pruning dist artifacts older than 2 versions
pack:
    pnpm run pack

alias zip := pack

# pack source files for Mozilla review, excluding Browser Control tooling
mozilla-source:
    pnpm run mozilla-source

# pack, submit the Firefox zip + source to Mozilla's unlisted signing channel, save the signed XPI and its feed
amo-submit:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f .env ]; then set -a; . ./.env; set +a; fi
    : "${WEB_EXT_API_KEY:?set WEB_EXT_API_KEY in .env (AMO -> Manage API Keys -> JWT issuer)}"
    : "${WEB_EXT_API_SECRET:?set WEB_EXT_API_SECRET in .env (AMO -> Manage API Keys -> JWT secret)}"
    version=$(node -p 'require("./package.json").version')
    xpi="dist/lbcat-$version.xpi"
    # AMO never accepts a version twice; a signed XPI here means this version is already spent
    if [ -e "$xpi" ]; then echo "$xpi already exists; bump the version first" >&2; exit 1; fi
    pnpm run pack
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    unzip -q "dist/lbcat-$version-firefox.zip" -d "$work/ext"
    pnpm exec web-ext sign --channel unlisted --source-dir "$work/ext" --artifacts-dir "$work/signed" \
        --upload-source-code "dist/lbcat-$version-source.zip"
    mv "$work"/signed/*.xpi "$xpi"
    pnpm --silent firefox:updates generate "$xpi" > "dist/lbcat-updates-$version.json"
    echo "signed: $xpi"
    echo "feed:   dist/lbcat-updates-$version.json (publish both via LB Stash, see docs/DEVELOP.md)"
