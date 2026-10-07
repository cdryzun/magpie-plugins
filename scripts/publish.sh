#!/bin/sh
# Publishes every package whose version isn't on npm yet.
#   scripts/publish.sh [otp]     (by hand: the npm account's one-time password)
# GitHub Actions runs it with no password on each version bump pushed to
# main (.github/workflows/publish.yml, npm's trusted publishing).
# One password covers the lot: it is sent with each publish while it lasts.
# Trusted publishing can't make a package npm has never seen: a new one's
# first version goes by hand (an npm account of the magpie-community org,
# `scripts/publish.sh <otp>`), and its Trusted Publisher is set after. Till
# then Actions passes it by, publishes the rest, and fails at the end
# naming it. So does a package whose publish npm refuses (one published
# by hand whose Trusted Publisher isn't set yet answers 404): the packages
# after it are still published.
set -e
cd "$(dirname "$0")/.."
# npm's own registry, whatever ~/.npmrc names (a mirror such as npmmirror
# takes no publish)
export npm_config_registry=https://registry.npmjs.org
bun scripts/check.mjs
otp="$1"
for dir in packages/*/; do
  name=$(node -p "require('./${dir}package.json').name")
  version=$(node -p "require('./${dir}package.json').version")
  if [ "$(npm view "$name@$version" version 2>/dev/null)" = "$version" ]; then
    echo "= $name@$version is on npm already"
    continue
  fi
  if [ -n "$GITHUB_ACTIONS" ] && [ -z "$otp" ] && ! npm view "$name" name >/dev/null 2>&1; then
    echo "::error::$name is not on npm yet: trusted publishing can't create it. Publish its first version by hand (scripts/publish.sh <otp>), then set this workflow as its Trusted Publisher on npmjs.com."
    new="$new $name"
    continue
  fi
  if ! (cd "$dir" && npm publish --access public ${otp:+--otp="$otp"}); then
    [ -n "$GITHUB_ACTIONS" ] && echo "::error::$name@$version wasn't published: is this workflow its Trusted Publisher on npmjs.com?"
    refused="$refused $name"
  fi
done
if [ -n "$new" ]; then
  echo "not published, new to npm:$new"
fi
if [ -n "$refused" ]; then
  echo "not published, refused by npm:$refused"
fi
if [ -n "$new$refused" ]; then
  exit 1
fi
