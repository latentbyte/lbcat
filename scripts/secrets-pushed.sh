#!/usr/bin/env sh
# scan the commits a push would send. reads git's pre-push lines from stdin:
#   <local ref> <local sha> <remote ref> <remote sha>
# existing ref: scan <remote sha>..<local sha>; new ref: scan <local sha> --not --remotes;
# deletions have nothing to scan. fails closed when gitleaks is missing
set -eu

command -v gitleaks >/dev/null || {
  echo "gitleaks is not installed (brew install gitleaks)" >&2
  exit 1
}

zero=0000000000000000000000000000000000000000
status=0
while read -r _local_ref local_sha _remote_ref remote_sha; do
  [ -n "${local_sha:-}" ] || continue
  [ "$local_sha" = "$zero" ] && continue
  if [ "$remote_sha" = "$zero" ]; then
    range="$local_sha --not --remotes"
  else
    range="$remote_sha..$local_sha"
  fi
  gitleaks git --config .gitleaks.toml --redact --no-banner --log-opts="$range" || status=1
done
exit "$status"
