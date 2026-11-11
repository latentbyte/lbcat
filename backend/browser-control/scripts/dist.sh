#!/usr/bin/env bash
# build macOS release tarballs (arm64, amd64) and a Homebrew formula for them
#
# usage: scripts/dist.sh [url-base]
#   url-base: where the tarballs will be downloaded from, eg a GitHub release download URL
#             defaults to a file:// URL of the output dir, for local install tests
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$root/../.." && pwd)"
out="$root/bin/dist"
version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$repo/package.json")"
if [ -z "$version" ]; then
    echo "cannot read version from package.json" >&2
    exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$out"
url_base="${1:-file://$out}"

cd "$root"
formula="$out/lbcat.rb"
sed -e "s|@VERSION@|$version|" packaging/homebrew/lbcat.rb.tmpl > "$formula"
for arch in arm64 amd64; do
    name="lbcat-$version-darwin-$arch"
    mkdir -p "$stage/$name"
    for bin in browser-control browser-control-daemon lbcat-shim; do
        CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -trimpath -ldflags="-s -w" -o "$stage/$name/$bin" "./cmd/$bin"
    done
    cp -R skills LICENSE NOTICE "$stage/$name/"
    tar -C "$stage" -czf "$out/$name.tar.gz" "$name"
    sha="$(shasum -a 256 "$out/$name.tar.gz" | awk '{print $1}')"
    upper="$(echo "$arch" | tr '[:lower:]' '[:upper:]')"
    sed -i '' -e "s|@URL_${upper}@|${url_base%/}/$name.tar.gz|" -e "s|@SHA256_${upper}@|$sha|" "$formula"
    echo "tarball: $out/$name.tar.gz"
    echo "sha256:  $sha"
done
echo "formula: $formula"
