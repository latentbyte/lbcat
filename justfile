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

# build vmctl Go binaries
vmctl-build:
    just -f tools/vmctl/justfile build

# build, install to ~/.local/bin, and register native host manifests
vmctl-install:
    just -f tools/vmctl/justfile install

# run vmctl Go tests
vmctl-test:
    just -f tools/vmctl/justfile test

# run vmctl Go static analysis
vmctl-check:
    just -f tools/vmctl/justfile check

# start vmctl daemon in foreground
vmctl-dev:
    just -f tools/vmctl/justfile dev

# clean vmctl build artifacts
vmctl-clean:
    just -f tools/vmctl/justfile clean

# run vmctl smoke test
vmctl-smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    just vmctl-build
    just vmctl-test
    tools/vmctl/bin/vmhost &
    daemon_pid=$!
    cleanup() { kill "$daemon_pid" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true; }
    trap cleanup EXIT
    sleep 0.3
    tools/vmctl/bin/vmctl ping
    tools/vmctl/bin/vmctl daemon status
    tools/vmctl/bin/vmctl daemon stop
    wait "$daemon_pid" 2>/dev/null || true
    trap - EXIT

# pack the extension into distributable archives
pack:
    pnpm run pack

alias zip := pack
