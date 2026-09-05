#!/data/data/com.termux/files/usr/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../.." && pwd)
ROOTFS=${1:-"$HOME/pm-firefox"}

if [ ! -d "$ROOTFS" ]; then
  echo "rootfs not found: $ROOTFS" >&2
  exit 1
fi

cp "$HERE/bwrap-passthrough.sh" "$ROOTFS/usr/bin/bwrap"
chmod 755 "$ROOTFS/usr/bin/bwrap"

export DISPLAY=${DISPLAY:-127.0.0.1:0}
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export LIBGL_ALWAYS_SOFTWARE=1

# No -b /dev: bunproot passes /proc, /dev and /sys to the kernel untranslated,
# so the guest already sees the host's device nodes.
exec bun "$REPO/proot.js" -S "$ROOTFS" -b "$HERE:/opt/bunproot-gtk-webkit" \
  /usr/bin/python3 /opt/bunproot-gtk-webkit/browser.py
