# Regression checks

What to run before trusting a change to the tracer. Everything here must run as
a native Android process — Termux, or any other host with Bun on `PATH`. It
cannot run inside a glibc PRoot: the port loads Android bionic through FFI, and
Bun cannot safely take that as a second libc.

`proot` below is the command: `bunproot` where the package is installed,
`bun proot.js` or `sh proot` from a source checkout. `ROOTFS` is an ARM64 Linux rootfs; the examples use the Alpine one
the port is developed against. A few checks want a second, deliberately bare
rootfs — see [A rootfs with nothing but Bun](#a-rootfs-with-nothing-but-bun).

## Unit tests

```sh
LD_PRELOAD= bun test
```

Covers argument and binding parsing, guest path canonicalization, the
link2symlink on-disk format, `#!` expansion including the `env` search, and ELF
`PT_INTERP` reading. Fast, no rootfs needed, so run it first.

## Integration checks

Each line names what breaks when it fails, so a red one points somewhere.

| Check | Exercises |
| --- | --- |
| `proot -S "$ROOTFS" /bin/sh -c 'ls /'` | The vertical slice: bootstrap, ELF loading, path translation |
| `proot -S "$ROOTFS" /bin/sh -c 'bun x cowsay hello'` | Registry resolve, install, `#!` re-exec, `getdents64` d_type for emulated hard links |
| `proot -S "$ROOTFS" /bin/sh -c 'bun x bunmsh -c "echo ok"'` | ES module resolution, which reads a module's own directory back through `/proc/<PID>/fd/<FD>` |
| `proot -S "$ROOTFS" /usr/bin/git clone -q https://github.com/jjtseng93/jsmdcui "$C"` | HTTPS, git's helper processes, the link2symlink hard-link emulation on pack files |
| `proot -S "$ROOTFS" /bin/sh -c "mkdir -p $FRESH; cd $FRESH; git init -q . && echo x > a && git add a && git -c user.email=a@b -c user.name=c commit -qm t"` | Loose-object hard links. **`$FRESH` must be a guest path that has never been used** — see the pitfalls below |
| `proot -S "$ROOTFS" /usr/bin/wget -q -O- https://example.com` | An absolute guest symlink (`/usr/bin/wget -> /bin/busybox`), TLS, and `ssl_client`'s completion path |
| `proot -S "$ROOTFS" /sbin/apk fix` | Archive extraction and ownership. Must print `OK: … in N packages` with **no** error count. It repairs what a first install got wrong, so run [the fresh-rootfs check](#a-rootfs-nothing-has-touched-yet) too |
| `proot -S "$ROOTFS" /usr/bin/node -e 'require("child_process").execSync("echo hi")'` | SIGCHLD forwarding, which needs the signal dispositions an emulated exec resets |
| `proot -S "$ROOTFS" /bin/sh -c 'npm --version && npm root -g'` | Environment hygiene: the answer must be a guest path, never a host one |
| `proot -S "$ROOTFS" -b /some/dir:/mnt /bin/sh -c 'cat /mnt/f; cd /mnt && pwd'` | Bindings in both directions, including `getcwd` detranslation |
| `proot -S "$ROOTFS" /bin/sh -c 'readlink /proc/self/exe; cat /proc/$$/comm; :'` | The state a mapped-in image cannot inherit from `execve`. The trailing `:` matters: without it the shell execs itself away into the last command, and `$$` names that command instead |

## A rootfs nothing has touched yet

The check above runs against a rootfs that is already populated, and there is a
class of bug it cannot see. Extract a minirootfs, give it a resolver, and
install a package that ships symbolic links:

```sh
mkdir fresh && tar -xzf alpine-minirootfs-*-aarch64.tar.gz -C fresh
echo 'nameserver 1.1.1.1' > fresh/etc/resolv.conf
proot -S ./fresh /sbin/apk add git
```

It must end in `OK: … in N packages` with **no** `failed to preserve` warning
and no error count. `git` is the package to use because its `git-core`
directory is a hundred-odd links, but `fish` and `chromium` exercise the same
thing.

What this catches is a flag the tracer must honour rather than a permission:
`apk` chowns a symbolic link with `AT_SYMLINK_NOFOLLOW`, and a package extracts
its links before their targets, so a tracer that dereferences anyway lands on a
target that does not exist yet and reports `ENOENT` as `failed to preserve …:
owner`. A rootfs that already has those targets resolves the link fine and
stays green, which is why this needs a rootfs from the tarball each time.
`apk fix` afterwards repairs the damage and hides the bug, so a green `apk fix`
is not a substitute.

## A rootfs with nothing but Bun

The `env`-less `#!` search and anything else that must not assume coreutils need
a rootfs holding only a Bun binary, its libraries, and a resolver:

```text
/bin/bun
/lib/ld-musl-aarch64.so.1
/lib/libstdc++.so.6
/lib/libgcc_s.so.1
/etc/resolv.conf
```

No symbolic links: name the loader at Bun's `PT_INTERP` path and each library at
its `SONAME`, and nothing has to be linked. `libgcc_s.so.1` is needed even
though `readelf -d` does not list it against Bun — it is `libstdc++`'s own
dependency. `libc.musl-aarch64.so.1` needs no file: musl's loader answers for
that name itself. `resolv.conf` is one line — `nameserver 1.1.1.1` — and is not
optional here, since the check below installs a package.

```sh
proot -S "$BARE" /bin/bun x bunmsh -c 'echo ok; ls /'
```

That one command covers the whole chain — a `#!/usr/bin/env bun` script
resolved against the guest `PATH` with no `env` present, a network install, and
a shell whose `ls` is a builtin because there is no coreutils to call.

## Performance

```sh
PROOT_BUN_PROFILE=1 proot -S "$ROOTFS" /bin/sh -c 'bunx jsmdcui --version'
```

`stops` is what the tracer paid for and `handled` is what it got. With the
seccomp filter working the two are within a factor of two of each other; a
`stops` in the tens of thousands means the filter is off. Check the fallback
still works too, since a kernel may refuse the filter:

```sh
PROOT_NO_SECCOMP=1 proot -S "$ROOTFS" /bin/sh -c 'echo ok'
```

## GTK3/WebKit and glycin on Android

Recent Alpine `gdk-pixbuf` uses glycin to decode images.  Glycin normally
starts each loader through bubblewrap with a user namespace and seccomp
sandbox.  Android app processes cannot create that user namespace.  PRoot can
make the capability probe appear successful by removing namespace flags, but
the real loader then fails or hangs when the first PNG is requested.  GTK may
report this later as an assertion in `gtkiconhelper.c`.

For a rootfs used only in a trusted test environment, install the included
pass-through wrapper:

```sh
cp test/gtk-webkit/bwrap-passthrough.sh "$ROOTFS/usr/bin/bwrap"
chmod 755 "$ROOTFS/usr/bin/bwrap"
```

The same directory contains the minimal browser and a native-Termux launcher.
[`test/gtk-webkit/README.md`](./test/gtk-webkit/README.md) is the one to follow
for the rest: which packages the rootfs needs before any of this runs, the icon
and mime caches that have to be built, and how to get an X server the guest can
reach.

This is a security tradeoff, not sandbox emulation: it discards bubblewrap's
isolation options and runs the image loader directly.  If WebKit uses the same
`bwrap`, its web processes are unsandboxed too.  Do not use this workaround for
untrusted pages or files.

There is one bunproot-specific detail in the wrapper: it must launch and wait
for the payload as a child; it must not end with `exec "$@"`.  With `exec`, the
short-lived `glycin-image-rs` process becomes an orphaned zombie and GLib waits
forever for its D-Bus decode response.  Keeping the wrapper shell as its parent
lets the same request complete.

Decoding a PNG before involving GTK or WebKit is a useful smoke test, but not a
gate: on a freshly built rootfs the first icon this reaches can fail while the
browser goes on to work. Plain `open()` reads the same file, and the original
PRoot fails on it too, so such a failure is inside glycin rather than in the
wrapper or the tracer. Treat a pass as reassurance and a failure as
inconclusive.

```sh
bun proot.js -S "$ROOTFS" -b /dev /bin/sh -c 'python3 - <<"PY"
import gi, glob, os
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf
p = [f for f in glob.glob("/usr/share/icons/**/*.png", recursive=True)
     if os.path.isfile(f)][0]
pb = GdkPixbuf.Pixbuf.new_from_file(p)
print("PNG loaded OK", pb.get_width(), "x", pb.get_height())
PY'
```

Launch the GTK/WebKit test with the X server already running. This, not the
probe above, is what says whether the workaround worked:

```sh
test/gtk-webkit/run.sh "$ROOTFS"
```

The launcher installs the wrapper, binds `test/gtk-webkit` into the guest,
exports the `DISPLAY` and WebKit variables the run needs, and starts
`browser.py`, so none of that has to be reproduced by hand.

The successful 2026-09-05 check loaded a 48x48 PNG, kept the browser alive for
more than 60 seconds with empty stderr, and displayed page content through
Termux:X11. Repeating it from a fresh 3.24.1 minirootfs needed no `apk update`
of its own, and needed `font-noto-cjk` before the page's CJK text rendered as
anything but empty boxes.

## Pitfalls that cost more time than the bugs

- **`/tmp` is not writable on Android.** It is `drwxrwx--x shell shell`;
  `$TMPDIR` is `$PREFIX/tmp`. A test that writes to `/tmp` fails for that
  reason and not for yours.

- **Never delete a guest directory from the host side.** `rm -rf
  "$ROOTFS/tmp/whatever"` bypasses the tracer, so link2symlink's `refs` entries
  and link counts are left behind. Reusing that guest path later produces
  failures — `error: Error building trees`, or a segfault — that look like
  tracer bugs and are not. Delete from inside the guest, or use a guest path
  that has never been used. There is no fsck yet; see
  [link2symlink.md](./link2symlink.md).

- **A timeout is not a failure.** `bunx` checks the registry for `@latest` on
  every run, and that can take minutes on a slow link. Give network checks a
  generous budget before concluding anything.

- **Do not read a file's identity from the host side.** An emulated hard link
  is a symlink to a guest-absolute path, which does not resolve outside the
  rootfs. Inspect it from inside the guest, or through the tracer.

- **`#!` in an interactive Bash command line.** History expansion turns `#!`
  inside double quotes into `event not found` and aborts the whole compound
  command, so earlier checks in the same line silently do not run. Write the
  script to a file first.
