# Manual GTK3/WebKit test

This test reproduces the GTK3 + WebKit2 4.1 browser path on Android. It is kept
outside the unit tests because it needs an ARM64 Alpine rootfs with Python,
PyGObject, GTK3, WebKit2GTK 4.1 and an active Termux:X11 server.

Run it from the native Termux environment:

```sh
cd ~/bunproot
test/gtk-webkit/run.sh ~/pm-firefox
```

The script binds this directory at `/opt/bunproot-gtk-webkit`, so the browser
does not need to be copied into the rootfs. It does install
`bwrap-passthrough.sh` as `$ROOTFS/usr/bin/bwrap`.

## Security warning

The wrapper is deliberately unsandboxed. It removes bubblewrap's isolation so
glycin can decode images on Android, where unprivileged user namespaces are not
available. WebKit processes using the same bwrap are unsandboxed as well. Use
only trusted local pages and files.

The wrapper must keep its shell process and wait for the glycin payload. Do not
replace its final `"$@"` with `exec "$@"`: under bunproot that leaves the image
loader as an orphaned zombie and GTK waits forever for its D-Bus response.

Success means the cyan HTML page is visible, the process remains alive, and no
`gtkiconhelper.c:ensure_surface_for_gicon` assertion appears.
