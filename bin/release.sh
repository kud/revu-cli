#!/usr/bin/env bash
# Repo-local release policy, detected and used by /k-release (Step 0.5).
#
# revu-cli ships a main package (@kud/revu-cli) plus three platform sub-packages
# (npm-packages/{darwin-arm64,linux-x64,linux-arm64}) whose versions must stay in
# lockstep, or the CI publish rejects a re-published version. scripts/bump.ts
# handles that sync + commit + tag + push. Generic `git lzv` only bumps the root
# package and is unaware of the sub-packages, so releases MUST route through here.
set -euo pipefail

bump="${1:-patch}"
case "$bump" in
  patch | minor | major) ;;
  *)
    echo "Usage: bin/release.sh [patch|minor|major]" >&2
    exit 1
    ;;
esac

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# /k-release writes CHANGELOG.md before invoking this script. scripts/bump.ts
# only stages the version files, so stage the changelog here to fold it into the
# same release commit.
git add CHANGELOG.md 2>/dev/null || true

exec bun run "bump:${bump}"
