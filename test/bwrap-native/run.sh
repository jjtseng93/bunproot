#!/bin/sh
set -eu

ROOTFS=${1:?usage: $0 ROOTFS [MINIMAL_ROOT]}
MINIMAL_ROOT=${2:-"${ROOTFS%/}-bwrap-min"}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

PAYLOAD=/proof-bwrap-root/loader-from-private-root
mkdir -p "$MINIMAL_ROOT/proof-bwrap-root"
cp "$ROOTFS/lib/ld-musl-aarch64.so.1" "$MINIMAL_ROOT$PAYLOAD"

set +e
OUTPUT=$(bun "$HERE/proot.js" -koe -S "$ROOTFS" \
  -b "$MINIMAL_ROOT:/bwrap-min" \
  /usr/bin/bwrap --ro-bind /bwrap-min / "$PAYLOAD" 2>&1)
STATUS=$?
set -e
printf '%s\n' "$OUTPUT"

[ "$STATUS" -eq 1 ]
case "$OUTPUT" in
  *"Dynamic Program Loader"*"Usage: $PAYLOAD"*) ;;
  *) exit 1 ;;
esac
