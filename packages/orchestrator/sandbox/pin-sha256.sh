#!/bin/sh
# Usage: sh pin-sha256.sh <name>, such as gh. Writes <NAME>_SHA256 in the sandbox Dockerfile
# as the sha256 of the file at <NAME>_URL for <NAME>_VERSION. Renovate runs it after a bump.
set -eu
name=$(echo "$1" | tr '[:lower:]' '[:upper:]')
dockerfile="$(dirname "$0")/Dockerfile"
arg() { sed -n "s/^ARG $1=//p" "$dockerfile"; }
version=$(arg "${name}_VERSION")
url=$(arg "${name}_URL" | sed "s/\${${name}_VERSION}/$version/g")
download=$(mktemp)
trap 'rm -f "$download"' EXIT
curl -fsSL -o "$download" "$url"
sha256=$(sha256sum "$download" | cut -d ' ' -f 1)
sed -i.bak "s/^ARG ${name}_SHA256=.*/ARG ${name}_SHA256=$sha256/" "$dockerfile"
rm "$dockerfile.bak"
