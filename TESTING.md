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
| `PROOT_BUN_STRACE=1 proot -S "$ROOTFS" /bin/cat /etc/os-release` | Full syscall tracing. It must include passed-through calls as well as `openat` with the translated host pathname; setting this variable disables the seccomp filter automatically |
| `proot -S "$EMPTY" -b /system -b /apex -b /linkerconfig/ld.config.txt -b "$BIONIC_BUN:/bin/bun" /bin/bun -e 'console.log(process.platform)'` | The emulated loader keeps SP in the kernel-created main stack. Bionic caches that range in pthread metadata, and JavaScriptCore aborts in `sanitizeStackForVM` if the guest is started on an unrelated anonymous mapping |
| `proot -S "$ROOTFS" /bin/sh -c 'bun x cowsay hello'` | Registry resolve, install, `#!` re-exec, `getdents64` d_type for emulated hard links |
| `proot -S "$ROOTFS" /bin/sh -c 'bun x bunmsh -c "echo ok"'` | ES module resolution, which reads a module's own directory back through `/proc/<PID>/fd/<FD>` |
| `proot -S "$ROOTFS" /usr/bin/git clone -q https://github.com/jjtseng93/jsmdcui "$C"` | HTTPS, git's helper processes, the link2symlink hard-link emulation on pack files |
| `proot -S "$ROOTFS" /bin/sh -c "mkdir -p $FRESH; cd $FRESH; git init -q . && echo x > a && git add a && git -c user.email=a@b -c user.name=c commit -qm t"` | Loose-object hard links. **`$FRESH` must be a guest path that has never been used** — see the pitfalls below |
| `proot -S "$ROOTFS" /usr/bin/wget -q -O- https://example.com` | An absolute guest symlink (`/usr/bin/wget -> /bin/busybox`), TLS, and `ssl_client`'s completion path |
| `proot -S "$ROOTFS" /sbin/apk fix` | Archive extraction and ownership. Must print `OK: … in N packages` with **no** error count. It repairs what a first install got wrong, so run [the fresh-rootfs check](#a-rootfs-nothing-has-touched-yet) too |
| `proot -S "$ROOTFS" /usr/bin/node -e 'require("child_process").execSync("echo hi")'` | SIGCHLD forwarding, which needs the signal dispositions an emulated exec resets |
| `proot -S "$ROOTFS" bun -e 'console.log(require("node:os").networkInterfaces())'` | Android-denied `NETLINK_ROUTE`: the guest result must contain the same IPv4/IPv6 interface set as native Bun, not throw `getifaddrs` errno 13 |
| `proot -S "$ROOTFS" /bin/sh -c 'npm --version && npm root -g'` | Environment hygiene: the answer must be a guest path, never a host one |
| `proot -S "$ROOTFS" -b /some/dir:/mnt /bin/sh -c 'cat /mnt/f; cd /mnt && pwd'` | Bindings in both directions, including `getcwd` detranslation |
| `proot -S "$ROOTFS" /bin/sh -c 'readlink /proc/self/exe; cat /proc/$$/comm; :'` | The state a mapped-in image cannot inherit from `execve`. The trailing `:` matters: without it the shell execs itself away into the last command, and `$$` names that command instead |
| `proot -S "$ROOTFS" /usr/bin/python3 -c 'import os; f=os.memfd_create("p", 11); print(os.open(f"/proc/self/fd/{f}", os.O_RDONLY))'` | Reopening an existing descriptor on Android. `/proc/self/fd/N` must be substituted with `dup(N)` rather than passed to the kernel, which rejects it with `EACCES` under ptrace |
| `proot -S "$ROOTFS" /bin/sh -c 'test ! -x ""'` | Empty pathnames are `ENOENT` unless a syscall explicitly receives `AT_EMPTY_PATH`; translating `""` into cwd makes optional-command guards run missing commands |
| `proot -koe -S "$ROOTFS" /bin/sh -c 'sleep 300 &'` | `-koe`/`--kill-on-exit` detached-child cleanup. It must return immediately with status 0; without the option, waiting for the background child is upstream-compatible behaviour |
| `proot -S "$ROOTFS" /bin/sh -c 'adduser -D u; su u -c id'` | fake-id0 credentials. Must report the new user rather than `uid=0(root)`: `setgroups` and the set*id family are blocked by Android's seccomp and answered by the tracer. A `can't set groups: Function not implemented` here means that path regressed |
| `proot -S "$ROOTFS" /bin/sh -c 'groupadd audit-test && groupdel audit-test'` | Android's denial of `NETLINK_AUDIT` is exposed to a fake-root guest as `EPROTONOSUPPORT`, so shadow account tools disable audit instead of aborting |
| `proot -S "$ROOTFS" /bin/sh -c 'addgroup --system --quiet --force-badname symlink-test && getent group symlink-test && ! getent passwd symlink-test'` | A shebang script invoked through a symlink receives the invoked pathname, not its canonical target, in interpreter argv; Debian's addgroup/adduser dispatcher depends on it |
| `proot -S "$ROOTFS" /bin/sh -c 'su u -c "su root -c id"'` | The capability model. Must refuse: a permanent drop out of root takes `CAP_SETUID` with it, as `MAYBE_DROP_CAPS` does upstream |
| `proot --readme \| head -1`, `proot --l2s-docs \| head -1` | The markdown renderers, and with them that no FFI symbol is bound at import time. Both files must also still ship: `npm pack --dry-run` has to list `README.md` and `link2symlink.md` |
| `proot --l2s-status "$ROOTFS"` | The link2symlink store report. `paths` must read `portable` for a rootfs only ever opened by this port. It must also refuse `-S`, a trailing command, or any other option: it enters nothing, so an extra argument means the caller expected something else  Under `PROOT_BUN_VERBOSE=1` it must also name each stale ref, and without it say how to list them |
| `proot --l2s-status <a proot-distro rootfs>` | The same report against the original format. It must name `.l2s`, count the objects, and say whether the prefix recorded in those targets still matches where the rootfs is — that is what decides whether `-b` can reach the files. Comparison is through symlinks, so a rootfs reached by another name must not be reported as moved |
| `proot --l2s-pin "$ROOTFS"`, read an emulated link from outside the guest, then `proot --l2s-unpin "$ROOTFS"` | The pin round trip. Outside the rootfs the file must be unreadable before the pin, readable after it, and unreadable again after the unpin; inside the guest, exactly the reverse. Both legs must move — converting only the ref leaves the alias guest-absolute and nothing outside can follow it. Repeating either direction must report everything already converted, not rewrite it again. A pinned store must also be refused on entry, and a store with even one pinned ref among portable ones must be refused too — an interrupted conversion is the case the sample exists to catch. `--l2s-ignore-pin` must still get in, and there the files read back while reporting `nlink` 1 and listing as symlinks, which is the false picture the refusal exists to prevent |
| `proot -S <a proot-distro rootfs> -b /data /bin/sh -c 'cat <an emulated link>'` | Reading the original PRoot's store. It must return the file's real contents. Only a symmetric binding does this: the store names host pathnames, and a symlink reached through a binding does not get its target translated a second time, so `-b <current>:<recorded>` fails where `-b /data` succeeds |
| `proot --version` **on a host without Android bionic** | The same thing from the other side. It must print the version rather than a `libc.so not found` stack trace -- run it from inside a glibc PRoot, where dlopen cannot succeed |

### System V shared memory

Android denies the SysV IPC syscalls outright, so `shmget`, `shmat`, `shmdt`
and `shmctl` are emulated. Two guest processes holding the same key must see
one another's writes -- a private copy each would pass a naive test and fail
every real user of shared memory.

PostgreSQL is the check worth keeping, because it exercises all four calls plus
the `shm_nattch` a postmaster reads to decide whether another one is already
running. It also refuses to run as root, so it covers the fake-id0 credentials
at the same time:

```sh
proot -S "$ROOTFS" /bin/sh -c 'apk add postgresql'
proot -koe -S "$ROOTFS" /bin/sh -c '
  mkdir -p /run/postgresql && chown postgres:postgres /run/postgresql
  su postgres -c "initdb -D /var/lib/postgresql/data"
  su postgres -c "postgres -D /var/lib/postgresql/data" &
  sleep 8
  su postgres -c "psql -d postgres -c \"select version()\""'
```

`initdb` must reach `Success.`, and the server must answer the query. Three
failures each mean something different:

- `initdb: error: cannot be run as root` -- the credential emulation regressed.
- `data directory ... has wrong ownership` -- the stat owner override
  regressed; it must report the saved set-user-ID, not a hard 0.
- `could not create shared memory segment: Function not implemented` -- the shm
  emulation regressed. `could not accept new connection` with the same errno is
  the `accept`-to-`accept4` reissue instead.

Backing files live in `$TMPDIR/bunproot-shm-<pid>` and are removed when the
tracer exits. A tracer that is killed outright cannot clean up, so the next run
sweeps the directories of pids that no longer exist; after a normal run
`ls -d $TMPDIR/bunproot-shm-*` must find nothing.

### Native bubblewrap

Install Alpine's real bubblewrap package, then run the one-file-root check:

```sh
proot -S "$ROOTFS" /sbin/apk add bubblewrap
test/bwrap-native/run.sh "$ROOTFS"
```

Success is the musl dynamic loader banner and a Usage line naming the deliberately
nonstandard `/proof-bwrap-root/loader-from-private-root` path. Its underlying
exit status is 1 because no program was supplied to the loader; the test script
validates that output and exits 0. Since that pathname does not exist in the
outer rootfs, the output proves bwrap built and pivoted into the new root and
executed its payload without leaking the outer `/lib`. bunproot supplies the
Android-unreadable overflow uid/gid sysctls internally, emulates bwrap's
namespace mounts as runtime bindings, and exposes those bindings through a
synthetic `/proc/self/mountinfo`.

For an installed Flatpak, exercise the same path without opening a window.
This deliberately creates a single-use D-Bus session; the interactive README
example wraps the whole shell so multiple applications share one bus:

```sh
proot -koe -S "$ROOTFS" /bin/sh -lc \
  'export XDG_RUNTIME_DIR=/run/user/0
   mkdir -p "$XDG_RUNTIME_DIR"
   exec dbus-run-session -- flatpak run --command=true org.gnome.TextEditor'
```

It must return status 0 using the rootfs's unmodified `/usr/bin/bwrap`, with no
wrapper, `LD_PRELOAD`, or Termux-prefix bind. For the GUI invocation and the
network-namespace limitation, see
[Flatpak through stock bwrap](./README.md#flatpak-through-stock-bwrap).

On a fresh rootfs, do not use `--no-gpg-verify`. After `remote-add`, verify
that the one-shot key import was committed before installing anything:

```sh
proot -S "$ROOTFS" /bin/sh -lc \
  'grep -q "^gpg-verify=true" /var/lib/flatpak/repo/config &&
   grep -q "^gpg-verify-summary=true" /var/lib/flatpak/repo/config &&
   test -s /var/lib/flatpak/repo/flathub.trustedkeys.gpg'
```

GPG starts a daemonizing `gpg-agent` during this operation. The check is also
a regression for fork/exec stops invalidating a pending stat buffer: bunproot
must never commit fake uid/nlink metadata into an address left over from the
previous image.

The fake-root identity must be translated in both directions across Unix
sockets. This checks D-Bus authentication: outgoing `SCM_CREDENTIALS` use the
real Android ids for the kernel, while `SO_PEERCRED` observed by another
traced guest is translated back to its guest ids.

```sh
proot -koe -S "$ROOTFS" /bin/sh -lc \
  'export XDG_RUNTIME_DIR=/run/user/0
   mkdir -p "$XDG_RUNTIME_DIR"
   exec dbus-run-session -- dbus-send --session --print-reply \
     --dest=org.freedesktop.DBus /org/freedesktop/DBus \
     org.freedesktop.DBus.ListNames'
```

It must return a method reply containing `org.freedesktop.DBus`. A document
portal is a separate check: Android's `/dev/fuse` is commonly inaccessible to
app UIDs, so its FUSE mount is not provided by bunproot.

GTK's portal backend starts glycin image loaders through a nested
`bwrap --unshare-all`. Opening a chooser exercises that path: bunproot must
remove only the implied network namespace, not reject the whole shorthand.
If it regresses, `xdg-desktop-portal-gtk` aborts while loading
`image-missing.png`, and Open/Save As appears to do nothing.

Also confirm `fc-list` is nonempty in a freshly populated rootfs (the README
installs `font-dejavu`). With no host-side font, the chooser may remain alive
but resize itself to an off-screen height greater than 32767 pixels while GTK
logs `infinite surface size not supported`. Seeing a window appear briefly is
therefore not a sufficient test: keep it open, select a known file, and use
Save As to verify that the requested bytes were actually written.

## Firefox on Termux:X11

With Termux:X11 already listening on TCP display 0, Firefox runs directly:

```sh
DISPLAY=127.0.0.1:0 proot -S "$ROOTFS" \
  /usr/lib/firefox/firefox about:blank
```

No `/dev` binding is needed; `/proc`, `/dev` and `/sys` already reach the host
kernel filesystems.  Firefox's own content sandbox can remain enabled.

Three tracer behaviours are load-bearing here:

- Firefox creates shared-memory snapshots with `memfd_create`, then reopens
  them through `/proc/self/fd/N`. Android rejects that procfs open with
  `EACCES` while the tracee is under ptrace, so fake-id0 substitutes `dup(N)`,
  matching upstream PRoot. An `O_PATH` descriptor is excluded because `dup`
  would preserve `O_PATH` instead of applying the requested access mode.
- Firefox's content sandbox deliberately catches `SIGSYS` and brokers blocked
  syscalls. A caught SIGSYS must be delivered to the guest handler; only a
  tracee with the default disposition gets the Android compatibility fallback
  of `ENOSYS`.
- Firefox can have more than 255 simultaneously tracked tasks. Scratch slots
  are returned to a free pool when tasks exit, and their shared region must be
  large enough for the live set.

The 2026-09-05 check kept Firefox 151 alive for more than 65 seconds with its
normal sandbox, no SIGSEGV, and no tracer failure. `PROOT_BUN_VERBOSE=1` is
useful for this check: a clean run has no `signal=11` line.

### Symbolizing a Firefox crash

Alpine provides matching symbols separately. Install them in the same rootfs
as Firefox; the package version must match the installed browser:

```sh
proot -S "$ROOTFS" /sbin/apk add firefox-dbg
```

For Alpine 3.24 the useful file is:

```text
$ROOTFS/usr/lib/debug/usr/lib/firefox/libxul.so.debug
```

Confirm that it belongs to the stripped library before trusting a result:

```sh
file "$ROOTFS/usr/lib/firefox/libxul.so"
readelf -n "$ROOTFS/usr/lib/firefox/libxul.so" | grep -A1 'Build ID'
readelf -n "$ROOTFS/usr/lib/debug/usr/lib/firefox/libxul.so.debug" | grep -A1 'Build ID'
```

`PROOT_BUN_VERBOSE=1` reports a fault as a mapping plus a mapping-relative
offset, for example `libxul.so +0x1b3f78c`. That number is not always an ELF
virtual address suitable for `addr2line`. Read the executable `PT_LOAD` first:

```sh
readelf -l "$ROOTFS/usr/lib/firefox/libxul.so" | sed -n '/LOAD/,+1p'
```

In the Firefox 151 build used here, the executable mapping started at file
offset `0x238c000`; its `PT_LOAD` had `p_offset=0x238cd98` and
`p_vaddr=0x239cd98`, a further `0x10000` virtual-address delta. Therefore the
reported `+0x1b3f78c` was symbolized at `0x3edb78c`:

```sh
llvm-addr2line -Cfipe \
  "$ROOTFS/usr/lib/debug/usr/lib/firefox/libxul.so.debug" \
  0x3edb78c
```

That resolved to `WritableSharedMap::WritableSharedMap()`; disassembly and the
nearby crash-reason string then showed
`MOZ_RELEASE_ASSERT(mHandle.IsValid() && mMapping.IsValid())`. Mozilla's
[`SharedMap.cpp`](https://searchfox.org/firefox-main/source/dom/ipc/SharedMap.cpp)
is the corresponding upstream source. Recalculate the offsets for every build
rather than copying the Firefox 151 constants above.

The symbols add roughly 514 MiB. Once diagnosis is complete they can be
removed without removing Firefox:

```sh
proot -S "$ROOTFS" /sbin/apk del firefox-dbg
```

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

Recent Alpine `gdk-pixbuf` uses glycin to decode images. Glycin normally starts
each loader through bubblewrap with a user namespace and seccomp sandbox.
Android app processes cannot create that user namespace. The native-bwrap
regression above covers its filesystem setup, but the full glycin/WebKit path
has additional process-lifetime integration constraints. GTK may report those
later as an assertion in `gtkiconhelper.c`.

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
bun proot.js -S "$ROOTFS" /bin/sh -c 'python3 - <<"PY"
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
