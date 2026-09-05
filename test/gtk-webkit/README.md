# Manual GTK3/WebKit test

This test reproduces the GTK3 + WebKit2 4.1 browser path on Android. It is kept
outside the unit tests because it needs an ARM64 Alpine rootfs with Python,
PyGObject, GTK3, WebKit2GTK 4.1 and an active Termux:X11 server.

`$ROOTFS` below is that rootfs, and every command is run from a checkout in
native Termux. An Alpine minirootfs unpacked as
[the main README](../../README.md#get-a-rootfs) describes is a fine starting
point; nothing here needs a rootfs that has been used for anything else.

## Preparing the rootfs

```sh
bun proot.js -S "$ROOTFS" /sbin/apk add \
    python3 py3-gobject3 gtk+3.0 webkit2gtk-4.1 \
    font-dejavu adwaita-icon-theme gtk-update-icon-cache shared-mime-info
```

`apk update` first is not needed: the 3.24 minirootfs already lists both `main`
and `community`, and apk fetches the index it is missing.

Add `font-noto-cjk` for a page with CJK text — `index.html` here has some, and
`font-dejavu` carries no CJK at all, so without it those characters come out as
empty boxes. `fc-list :lang=zh | wc -l` should stop answering `0`; run
`fc-cache -f` in the guest if it has not.

Neither the font nor the icon theme is optional. Nothing pulls either one in as
a dependency, and GTK aborts rather than start when it cannot load an icon, so
a rootfs without them fails in `gtkiconhelper.c` for a reason that looks
nothing like a missing package. Both caches have to exist before first use:

```sh
bun proot.js -S "$ROOTFS" /bin/sh -c '
    gtk-update-icon-cache -f -t /usr/share/icons/Adwaita
    update-mime-database /usr/share/mime'
```

No `-b /dev` is needed, even though a distribution tarball ships an empty
`/dev` and device nodes cannot be created without real root. `/proc`, `/dev`
and `/sys` are passed to the kernel untranslated, so the guest gets the host's
device nodes: `/dev/null` inside the rootfs is the real `crw-rw-rw- 1, 3`, and
nothing is ever created under `ROOTFS/dev`. Only `ls /dev` differs from a
normal system, because Android refuses to list that directory to an app.

## The X server

```sh
termux-x11 :0 -listen tcp -ac &
```

`-listen tcp` is what makes `DISPLAY=127.0.0.1:0` work, and TCP needs no
binding of its own, which is why `run.sh` defaults to it. The Unix socket is
the alternative and needs its directory bound in:

```sh
DISPLAY=:0 bun proot.js -S "$ROOTFS" -b "$PREFIX/tmp/.X11-unix:/tmp/.X11-unix" …
```

## Running it

Run it from the native Termux environment:

```sh
cd ~/bunproot
test/gtk-webkit/run.sh "$ROOTFS"
```

The script binds this directory at `/opt/bunproot-gtk-webkit`, so the browser
does not need to be copied into the rootfs. It does install
`bwrap-passthrough.sh` as `$ROOTFS/usr/bin/bwrap`.

Success means the cyan HTML page is visible, the process remains alive, and no
`gtkiconhelper.c:ensure_surface_for_gicon` assertion appears. That is the real
check, and the only one worth trusting.

In particular, decoding a PNG through `GdkPixbuf` beforehand is a tempting
smoke test and an unreliable one. On a freshly built rootfs the first icon such
a probe reaches can fail while the browser it is supposed to be gating goes on
to work: plain `open()` reads the same file, and the original PRoot fails on it
too, so the failure is inside glycin rather than in the wrapper or the tracer.
Take a passing probe as reassurance; do not take a failing one as a reason to
stop.

`libEGL warning: DRI3 error: Could not get DRI3 device` on the way up is
expected. There is no GPU passthrough; rendering falls back to software, which
is what `LIBGL_ALWAYS_SOFTWARE=1` in `run.sh` asks for anyway.

## Security warning

The wrapper is deliberately unsandboxed. It removes bubblewrap's isolation so
glycin can decode images on Android, where unprivileged user namespaces are not
available. WebKit processes using the same bwrap are unsandboxed as well. Use
only trusted local pages and files.

The wrapper must keep its shell process and wait for the glycin payload. Do not
replace its final `"$@"` with `exec "$@"`: under bunproot that leaves the image
loader as an orphaned zombie and GTK waits forever for its D-Bus response.

## What not to try instead

Three approaches that look like they should work and do not. They are recorded
here because each one costs an install and a run to rule out.

- **Deleting `bwrap` rather than replacing it.** Glycin does not fall back to
  decoding in-process when the binary is absent; it reports that it could not
  spawn the command and fails there instead. The wrapper has to exist.

- **Switching to a PNG icon theme.** `adwaita-icon-theme` is SVG, so reaching
  for `faenza-icon-theme` and its 15000 PNGs is the obvious next move. It does
  not help: the icons that fail first are the PNGs inside libgtk's own
  GResource, and every decode goes through the same out-of-process loader
  whatever the format. The problem is never the format.

- **Installing `librsvg` for an SVG loader.** Alpine's package ships
  `librsvg-2.so.2` and the typelib but no gdk-pixbuf loader, so the loaders
  directory still holds nothing but `libpixbufloader-xpm.so`.

Confirming that the wall is bubblewrap rather than the tracer takes one run:
the original PRoot fails identically on the same rootfs, with the same
`gtkiconhelper.c` assertion. No `ptrace` sandbox can hand out a namespace the
kernel refuses to create.
