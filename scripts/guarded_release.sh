#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/guarded_release.sh <tag> <commit-message> -- <file1> [file2 ...]

Example:
  scripts/guarded_release.sh V8.2 "release: V8.2" -- src/index.js sql/reset_nil_clean_slate.sql

Behavior:
  - Commits ONLY the listed files (using an isolated temporary git index)
  - Creates an annotated tag
  - Pushes current branch and tag to origin
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 4 ]]; then
  usage
  exit 1
fi

TAG="$1"
COMMIT_MSG="$2"
shift 2

if [[ "${1:-}" != "--" ]]; then
  echo "Error: missing -- separator before file list"
  usage
  exit 1
fi
shift

if [[ $# -lt 1 ]]; then
  echo "Error: you must provide at least one file path"
  usage
  exit 1
fi

FILES=("$@")

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: not inside a git repository"
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "Error: detached HEAD is not supported for guarded release"
  exit 1
fi

for f in "${FILES[@]}"; do
  if [[ ! -e "$f" ]]; then
    echo "Error: file not found: $f"
    exit 1
  fi
done

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Error: tag already exists: $TAG"
  exit 1
fi

TMP_INDEX="$(mktemp)"
trap 'rm -f "$TMP_INDEX"' EXIT

# Use the current index as a base, then stage only explicit files into a temp index.
cp .git/index "$TMP_INDEX" 2>/dev/null || :
export GIT_INDEX_FILE="$TMP_INDEX"

git add -- "${FILES[@]}"

if git diff --cached --quiet; then
  echo "Error: no staged changes found for provided files"
  exit 1
fi

git commit -m "$COMMIT_MSG"
git tag -a "$TAG" -m "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"

echo "Release published successfully: $TAG on branch $BRANCH"
