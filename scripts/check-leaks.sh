#!/usr/bin/env bash
# The leak check: fails when a word from a local pattern list appears anywhere this package ships from.
#
#   bash scripts/check-leaks.sh [--pack] [--review] [root]
#
# The list is one extended regular expression per line (blank lines and # comments skipped), matched
# case-insensitively. It is read from $LEAK_PATTERNS_FILE, else <root>/.leak-patterns, which git ignores,
# so the words it guards against are never published with the code. With no list there is nothing to
# check and the script exits 0.
#
# Scanned: every tracked and untracked (not ignored) file, dist/ when it exists, the packed tarball with
# --pack (run after a build), and every commit message. Each match prints as `where:line:text` and the
# script exits 1. A clean run prints nothing.
#
# --review reads $LEAK_REVIEW_FILE, else <root>/.leak-review, instead: it prints every hit for reading
# by hand and never fails.
set -euo pipefail

pack=0
review=0
root=""
for arg in "$@"; do
  case "$arg" in
    --pack) pack=1 ;;
    --review) review=1 ;;
    -*) echo "check-leaks: unknown option $arg" >&2; exit 2 ;;
    *) root="$arg" ;;
  esac
done
root="$(cd "${root:-$(dirname "${BASH_SOURCE[0]}")/..}" && pwd)"

if [[ $review -eq 1 ]]; then
  list="${LEAK_REVIEW_FILE:-$root/.leak-review}"
else
  list="${LEAK_PATTERNS_FILE:-$root/.leak-patterns}"
fi
if [[ ! -s "$list" ]]; then
  echo "check-leaks: no pattern list at $list; nothing checked" >&2
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# An empty pattern would match every line.
grep -v -E '^[[:space:]]*(#|$)' "$list" > "$tmp/patterns" || true
if [[ ! -s "$tmp/patterns" ]]; then
  echo "check-leaks: the pattern list at $list is empty; nothing checked" >&2
  exit 0
fi
hits="$tmp/hits"
: > "$hits"
list_abs="$(cd "$(dirname "$list")" && pwd)/$(basename "$list")"

# grep exits 1 when nothing matches; only a status above 1 is an error.
search() { grep "$@" || [[ $? -eq 1 ]]; }

# 1. The working tree: tracked and untracked files, minus what git ignores (node_modules, dist, the lists).
cd "$root"
if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  git ls-files -z --cached --others --exclude-standard > "$tmp/files"
else
  find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' -print0 > "$tmp/files"
fi
while IFS= read -r -d '' file; do
  file="${file#./}"
  [[ -f "$file" ]] || continue
  [[ "$(pwd)/$file" == "$list_abs" ]] && continue
  [[ "$file" == ".leak-patterns" || "$file" == ".leak-review" ]] && continue
  search -I -n -i -E -H -f "$tmp/patterns" -- "$file" >> "$hits"
done < "$tmp/files"

# 2. The build.
if [[ -d dist ]]; then
  search -r -I -n -i -E -H -f "$tmp/patterns" -- dist >> "$hits"
fi

# 3. The tarball npm would publish.
if [[ $pack -eq 1 ]]; then
  mkdir "$tmp/pack"
  npm pack --ignore-scripts --silent --pack-destination "$tmp/pack" > /dev/null
  tar -xzf "$tmp"/pack/*.tgz -C "$tmp/pack"
  (cd "$tmp/pack" && search -r -I -n -i -E -H -f "$tmp/patterns" -- package) | sed 's|^|tarball:|' >> "$hits"
fi

# 4. Every commit message.
if git rev-parse --verify --quiet HEAD > /dev/null 2>&1; then
  git log --format='@@commit@@ %h%n%B' \
    | awk '/^@@commit@@ / { sha = $2; next } { print "commit " sha ":" $0 }' \
    | { search -i -E -f "$tmp/patterns" || true; } >> "$hits"
fi

if [[ -s "$hits" ]]; then
  cat "$hits"
  [[ $review -eq 1 ]] && exit 0
  exit 1
fi
exit 0
