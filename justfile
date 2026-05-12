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

# pack the extension into distributable archives
pack:
    pnpm run pack

alias zip := pack
