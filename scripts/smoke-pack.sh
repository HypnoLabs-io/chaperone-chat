#!/usr/bin/env bash
# The packed package as a stranger installs it. Run it before a release: npm run smoke:pack
#
# npm pack, an empty folder, the tarball and public dependencies from the registry, then:
#   - the README's quickstart, run as pasted, its output compared with the one the README prints;
#   - every entry imported from ESM and required from CommonJS (test/smoke/entries.*);
#   - TypeScript under node16 resolution (ESM, CommonJS and a React page, in a CommonJS and in an ESM package) and
#     under bundler resolution (every file with a path comment in the README, docs/install.md and docs/recipes.md),
#     the package's own declarations checked too;
#   - the command line through npx.
#
# Needs the network for npm install. Works in a temporary folder ($TMPDIR) and leaves nothing behind.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
step() { echo "smoke-pack: $*"; }

cd "$root"
npm pack --silent --pack-destination "$work" >/dev/null
tarball="$(ls "$work"/chaperone-chat-*.tgz)"
step "packed $(basename "$tarball")"

mkdir "$work/consumer"
cd "$work/consumer"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$tarball" \
  typescript@~5.9.3 @types/node@22 react@19 react-dom@19 @types/react@19 pg@8 @types/pg >/dev/null
cp -R "$root/test/smoke/." .
step "installed in an empty folder"

node readme-files.mjs node_modules/chaperone-chat/README.md readme
node readme-files.mjs "$root/docs/install.md" docs/install --files-only
node readme-files.mjs "$root/docs/recipes.md" docs/recipes --files-only
node readme/try.mjs > try.actual
diff -u readme/try.expected try.actual
step "the README's quickstart prints what the README says"

node entries.mjs
node entries.cjs

npx tsc -p tsconfig.node16.json
npm pkg set type=module >/dev/null
npx tsc -p tsconfig.node16.json
npm pkg delete type >/dev/null
step "TypeScript, node16: ESM, CommonJS and React, from a CommonJS and from an ESM package"
npx tsc -p tsconfig.bundler.json
step "TypeScript, bundler: every file in the README, the install guide and the recipes"

npx chaperone-chat schema | grep -q "CREATE TABLE IF NOT EXISTS chat_conversations"
npx chaperone-chat calibrate --report | grep -q "fingerprint 6ce551c1"
step "npx chaperone-chat schema and calibrate --report"

step "ok"
