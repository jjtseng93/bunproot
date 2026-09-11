# bunproot

A port of [PRoot](https://github.com/termux/proot) to Bun/JavaScript: a
userspace `chroot`, `mount --bind` and shebang loader for Android, needing no
root and no kernel support beyond `ptrace`.

It runs wherever `bunx` does — Termux, a shell inside an app built with
[minapk](https://github.com/jjtseng93/minapk)
([npm](https://www.npmjs.com/package/@drxiaozhi/minapk)), or any other Android
environment with Bun on `PATH`. The tracer itself is Bun; the guest is an ARM64
Linux rootfs you supply. It can be an [empty directory](#a-rootfs-can-be-zero-files)
that borrows Android's system files, or a self-contained rootfs assembled from
as few as [five files](#a-rootfs-can-be-five-files).

**This is early work, and it is not trying to replace Termux's PRoot.** That
one is mature, complete and considerably faster; if you are in Termux and it
works for you, keep using it. What this port is for is the case after Termux: a
rootfs runner whose only dependency is a Bun binary, so an Android environment
that never had a package manager — an app built by minapk, a device where
Termux is not an option — still has a way out to a Linux userspace. Bun is the
one thing such an environment can be given as a single file, so it is the one
thing this depends on.

> **A rootfs the original PRoot has used needs `-b /data`.** Both emulate hard
> links — Android rejects `link(2)` on app storage — but not in the same on-disk
> format, and this port reads only its own. Add the bind and such a rootfs works partially(read-only):
>
> ```sh
> bunproot -S ./that-rootfs -b /data /bin/sh
> ```
>
> If you leave the bind out, any hardlink that was turned into a symlink by the upstream PRoot will become unreadable.
> That includes a large amount of files.
> Here is why. Upstream PRoot turns hardlinks into double-layer symlinks which target a *host*
> pathname. A symlink target inside a guest is read as a guest pathname, so
> following it re-roots that host path into the rootfs, where it is not present. The
> bind puts that path inside the guest as well, and it resolves.
>
> Tell the two formats apart by the store at the rootfs root: `/.l2s` is the
> original's, `/.proot.l2s` is this port's. A fresh rootfs, or one only ever
> opened with bunproot, needs nothing. `bunproot --l2s-status ./that-rootfs`
> reports which store is there without entering it, and for an original-format
> one says whether the bind above can still reach it -- which depends on the
> rootfs not having moved since those pathnames were written into it.
>
> The bind only works while the rootfs has not been moved or renamed away from the original path.
> What it recovers is a host path recorded at the time the symlink was made. That is the
> original format's own limitation, not something this port adds: the same move
> breaks the same rootfs under the original PRoot too.
>
> And the bind is for getting at what is there, not for moving in. Writing to
> such a rootfs under this port lays down a second store beside the first, and
> the two do not know about each other.
>
> The formats differ deliberately, and that is what the difference buys. This
> port records guest pathnames, so a rootfs stays readable wherever it is put —
> which is the whole point of a rootfs you can carry out of Termux. Being unable
> to read the original's store is the price.

Licensed **GPL-2.0-or-later**, inherited as a derivative work of PRoot.
[NOTICE.md](./NOTICE.md) records what it was ported from and how to read the
`src/...` citations in the comments; [COPYING](./COPYING) is the licence.

## Confirmed running (mostly under Alpine)

- Firefox
- bubblewrap (`bwrap`)
- Flatpak (limited testing)
  - GNOME Text Editor
  - GNOME Calculator
- PostgreSQL
- GTK3/WebKit 4.1 test browser
- LibreOffice
  ```sh
  uname -a > pv.txt
  DISPLAY=:0 bunproot -S ROOTFS -b ./pv.txt:/proc/version /bin/sh -c libreoffice
  ```
- bunmsh: Bun Modern Shell
- jsmdcui: Text Editor & App runtime
- npm-installed Bun
- Git clone
- OpenSSH client (`terminal.shop` confirmed) and non-root server
  - The server may need a port above 1024, the same account for `sshd` and the
    login, and relaxed `StrictModes`. Root `sshd` still needs `chroot` emulation.

## Quick start

bunproot needs a Bun built for Android/bionic, and how you get one depends on
where you are. Any build will do; prefer 1.4.1 or newer.

### Route 1: Termux, from the TUR repository

Termux packages Bun in [TUR](https://github.com/termux-user-repository/tur),
which is the shortest path — `bunx` comes with it:

```sh
pkg install tur-repo
pkg install bun
bunx bunproot --help
```

### Route 2: an app built with minapk

An app built with [minapk](https://github.com/jjtseng93/minapk) has no npm and
no npx, so the Bun that runs bunproot is whichever one the APK was built with.
Where that Bun came from does not matter — the Termux TUR build, the official
binary, or the official binary under the `LD_PRELOAD` shim posted in
[oven-sh/bun#39060](https://github.com/oven-sh/bun/issues/39060), which turns
the blocked `openat2` and `fchmodat2` into `ENOSYS`.

```sh
bunx bunproot --help
```

That succeeds on the first run, and it does so while
[oven-sh/bun#39084](https://github.com/oven-sh/bun/pull/39084) is still open.
minapk's `bunx` is really `bun i -g bunproot` followed by running the installed
entry point with `bun` directly, so it never reaches the bin-linking step whose
`openat2` Android answers with SIGSYS. bunproot helps from its side by keeping
its own entry point at the package root, where the containment check that calls
`openat2` is not reached for its `bin` target — see the comment at the top of
`proot.js`. minapk's documentation covers the build side.

### Route 3: an Android shell with npm

Where Node is already present — some terminal apps ship it — Bun installs
through npm:

```sh
npm install -g bun
npx bunproot --help
```

Use `npx` for that first run. An official Bun installed this way also has
`bunx`, but its first `bunx bunproot` is killed by SIGSYS as it finishes
installing — [oven-sh/bun#39084](https://github.com/oven-sh/bun/pull/39084)
again — printing no message of its own. The package is already extracted by
then, so a second run succeeds and keeps succeeding. `npx` never goes through
that path, and neither does the TUR build's `bunx`.

Every route leaves you with the same `bunproot` command. On platforms other
than Android, follow the [official Bun installation
guide](https://bun.com/docs/installation) — though the tracer targets ARM64
Android and does not yet run anywhere else.

### Route 4: from source

```sh
git clone https://github.com/jjtseng93/bunproot.git
cd bunproot
bun proot.js --help          # or: sh proot --help
```

`proot.js` is the entry npm links as `bunproot`; `proot` is a shell launcher
for a device with no Bun on `PATH`, which falls back to a `bun-android` binary
you place beside it.

### Get a rootfs

```sh
bunproot --download-alpine                 # fetches and checksums a minirootfs
mkdir alpine && cd alpine && tar -xzvf ../alpine-minirootfs-*.tar.gz && cd ..
```

It prints the URL and the expected SHA-256 and asks before downloading, and
verifies what it got. From a source checkout the same script is
`bun tools/download-alpine.mjs`.

Any ARM64 Linux rootfs works; Alpine is simply what this port is tested
against.

### First run

```sh
bunproot -S ./alpine /bin/sh -c 'cat /etc/os-release'
```

## A rootfs can be zero files

Android already has a shell and the usual command-line tools under `/system`.
An empty directory can therefore be used as a borrowed root:

```sh
mkdir empty
bunproot --android-container ./empty
```

From the shell inside the container, Bun can fetch an interactive
[bunmsh](https://github.com/jjtseng93/bunmsh) shell or use bunproot's
Git-compatible wrapper around the pure-JavaScript
[isomorphic-git](https://isomorphic-git.org/) to clone a repository without a
system Git:

```sh
bun x bunmsh
bun x bunproot --git clone https://github.com/jjtseng93/jsmdcui
```

On older Android releases, the first `bun x` invocation may finish installing
the package and then fail with an `invalid pointer` error before its command
starts. The installation has normally completed despite that message; ignore
it and run the same command again, and it may start successfully on the second
run.

On a device where the `invalid pointer` failure persists, replace `bun x xxx`
with an explicit global install followed by a direct launch:

```sh
bun i -g xxx
bun /root/.bun/bin/xxx
```

There is one further limitation on affected Bun versions: when a package's
declared bin entry is not at the top level of that package, Android's blocked
`openat2` can prevent the global bin link from being created. If
`/root/.bun/bin/xxx` is missing, invoke the installed JavaScript entry point
directly instead (replace the final `xxx.js` with that package's actual entry
file):

```sh
bun /root/.bun/install/global/node_modules/xxx/xxx.js
```

This binds `/system`, `/apex`, `/linkerconfig/ld.config.txt`, and
`/system/bin/sh` at `/bin/sh`. The Android Bun that started bunproot is bound
at both `/bin/bun` and `/bin/node`. It prepends `/system/bin` to the guest
`PATH` and runs `/system/bin/sh` when no command is given. A command and more
options can be supplied normally:

```sh
bunproot --android-container ./empty /system/bin/id
bunproot --android-container ./empty /bin/sh -c 'echo hello'
bunproot --android-container ./empty /bin/node -e 'console.log(process.version)'
bunproot --android-container ./empty -b ./other-bun:/bin/bun /bin/bun app.ts
```

With Bun already present, this zero-file container can also [clone a Git
repository without a system Git](#git-clone-without-system-git).

Bindings written by the caller come after the preset, so bindings at
`/bin/sh`, `/bin/bun`, or `/bin/node` replace the corresponding defaults;
binding another existing file such as `/dev/null` at one of those paths
disables that alias. As with other bindings, this makes endpoints reachable
but does not populate the empty root directory: `ls /` remains empty because
the glue filesystem which synthesizes intermediate directories has not been
ported.

## A rootfs can be five files

A distribution is the convenient guest, not the required one. The guest needs
an ELF the loader can map and whatever that ELF asks for — nothing else. For
Bun itself that is five files:

```text
/bin/bun
/lib/ld-musl-aarch64.so.1     musl's loader, which is also its libc
/lib/libstdc++.so.6
/lib/libgcc_s.so.1            libstdc++'s own dependency, which `readelf -d`
                              does not list against bun
/etc/resolv.conf              a resolver, without which `bun x` cannot install
```

An Alpine rootfs with Bun installed already has four of them — `musl` carries
the loader, and installing Bun brings `libstdc++` and `libgcc` in with it — so
the Alpine from [Get a rootfs](#get-a-rootfs) is where to copy them from. The
fifth, `resolv.conf`, is one line you write yourself.

Where Bun itself landed inside that Alpine depends on how it was installed —
npm puts it in `/usr/local/bin`, the official installer in `~/.bun/bin` — so
ask the guest rather than guessing:

```sh
mkdir -p bare/bin bare/lib bare/etc
BUN=$(bunproot -S ./alpine /bin/sh -c 'command -v bun')

cp "./alpine$BUN"                   bare/bin/bun
cp alpine/lib/ld-musl-aarch64.so.1  bare/lib/
cp alpine/usr/lib/libstdc++.so.6    bare/lib/
cp alpine/usr/lib/libgcc_s.so.1     bare/lib/
echo 'nameserver 1.1.1.1' > bare/etc/resolv.conf
```

That settles the symlink question by itself: `cp` follows a symbolic link it
is given as a source unless told otherwise, so Alpine's
`libstdc++.so.6 -> libstdc++.so.6.0.34` and npm's
`bun -> ../lib/node_modules/bun/bin/bun.exe` arrive as real files under the
names the loader asks for.

Name each file the way the loader asks for it and no symbolic links are needed:
the loader at the `PT_INTERP` path (`readelf -l` shows it), each library at its
`SONAME` rather than its versioned filename — `libstdc++.so.6`, not
`libstdc++.so.6.0.34`. Copying a distribution's `/lib` verbatim brings its
symlink farm along, but none of it is load-bearing here. Bun's other
dependency, `libc.musl-aarch64.so.1`, needs no file of its own: musl's loader
is musl's libc, and it answers for that name itself.

That is a working guest:

```sh
bunproot -S ./bare /bin/bun -e 'console.log(process.platform, process.arch)'
```

There is no shell in it, no coreutils, and no `/usr/bin/env` — a
`#!/usr/bin/env NAME` script still runs, because the tracer does the `PATH`
search itself rather than running an `env` that is not there. Give that guest a
network and `bun x` installs the rest, so a shell with `ls`, `cat` and `curl` is
one command away — here [bunmsh](https://github.com/jjtseng93/bunmsh), the Bun
Modern Shell, which carries those as builtins:

```sh
bunproot -S ./bare /bin/bun x bunmsh -c 'echo hi; ls /'
```

Without `-c` the same command drops you into that shell, interactively, inside
the five-file guest:

```sh
bunproot -S ./bare /bin/bun x bunmsh
```

It is not a *small* rootfs — Bun is 70-odd MiB — but it is one you can assemble
by copying five files, with no distribution to download, unpack or trust.

It can likewise [clone a Git repository without adding Git to those five
files](#git-clone-without-system-git).

## Git clone without system Git

Inside either minimal rootfs, a writable `bun x` installation can fetch
bunproot and use [isomorphic-git](https://isomorphic-git.org/) without a
system Git. bunproot runs isomorphic-git underneath but wraps its API in the
usual `git clone [options] repository [directory]` CLI shape; it does not
expose isomorphic-git's own CLI. `--git` selects this mode only when it is the
very first bunproot argument, and the first release supports only `clone`:

```sh
bun x bunproot --git clone https://github.com/jjtseng93/bunproot.git
bun x bunproot --git clone --depth 1 --branch main URL DIRECTORY
```

To reduce npm supply-chain drift, the published `tools/isomorphic-git/bun.lock`
fixes isomorphic-git 1.41.9 and all 55 packages in its production dependency
tree. That tree received a broad AI-assisted static review for install scripts,
native payloads, dynamic code execution, subprocesses, unexpected network
targets and known advisories before it was locked. This is not a formal audit
or a guarantee that the packages or repositories being cloned are safe: use
this feature at your own risk.

On first use bunproot explains that it will download isomorphic-git and its
locked dependencies from the npm registry, prints the complete command and
working directory that it will give `Bun.spawnSync`, and asks:

```text
Install now? (Y/n)
```

Only Enter, `y`, or `yes` starts the in-place installation. It uses
`bun install --frozen-lockfile --ignore-scripts --production`, so the lockfile
cannot be updated and dependency lifecycle scripts cannot run. Any other
answer cancels it. Later runs reuse the installed, version-checked copy without
asking again. bunproot verifies the installed package on disk rather than
trusting `bun install`'s exit status, which was unreliable before
[oven-sh/bun#39060](https://github.com/oven-sh/bun/issues/39060) was fixed.

## Usage

```text
bunproot [OPTION ...] (-S ROOTFS | --android-container ROOTFS) [COMMAND [ARG ...]]
```

Every option belongs before `COMMAND`. Parsing stops at the first argument that
is not an option, so a `--kill-on-exit` or a `--help` written after `COMMAND`
is an argument to the guest program instead.

| Option | Effect |
| --- | --- |
| `-S`, `--rootfs ROOTFS` | Run with `ROOTFS` as the root directory. `COMMAND` defaults to `/bin/sh` |
| `--android-container ROOTFS` | Use `ROOTFS`, which may be an empty directory, with `/system`, `/apex` and the linker configuration bound in; `/system/bin/sh` is also `/bin/sh`, and this Bun is both `/bin/bun` and `/bin/node`. `PATH` starts with `/system/bin`; `COMMAND` defaults to `/system/bin/sh`. `--android-container=ROOTFS` says the same thing |
| `-b`, `--bind HOST[:GUEST]` | Make a host path visible inside the guest; repeatable. `--bind=SPEC` says the same thing |
| `-m`, `--mount` | Another name for `--bind`, not a different thing |
| `--dns MODE` | Which resolver the guest gets: `auto` (default), `simple` or `off`. `--dns=MODE` says the same thing |
| `-koe`, `--kill-on-exit` | Kill whatever is left of the guest when `COMMAND` exits |
| `-p [PORT SPEC]` | With `[HOST_IP:]HOST_PORT:CONTAINER_PORT[/tcp\|udp]`, rewrite guest ports to explicit host endpoints; repeatable. A bare `-p` enables low-port protection through `PROOT_PORT_ADD`. A single port is accepted for Docker CLI compatibility |
| `--l2s-status ROOTFS` | Report what state a rootfs's emulated hard-link store is in, then exit. Recognises the original PRoot's format too. Reads only, takes a rootfs of its own, and combines with nothing else |
| `--l2s-pin ROOTFS` | Rewrite that store so tools outside the rootfs can follow its emulated hard links. The guest loses them for as long as it is pinned, and the rootfs can no longer be moved |
| `--l2s-unpin ROOTFS` | Rewrite it back, so the guest can follow them again and the rootfs can move |
| `--l2s-docs` | Render [link2symlink.md](./link2symlink.md), the on-disk format, in the terminal |
| `--l2s-ignore-pin` | Enter a rootfs whose link store is pinned, which is otherwise refused. Its emulated hard links do not work while it is pinned |
| `--download-alpine` | Fetch and checksum an Alpine minirootfs, then exit. It must be the first argument, and takes no others |
| `--git clone [OPTION ...] REPOSITORY [DIRECTORY]` | Only as the first argument, ask before installing the separately locked isomorphic-git dependencies in place with scripts disabled, accept Git-compatible clone arguments, clone, then exit |
| `--readme` | Render this README in the terminal, with links where it has them |
| `-h`, `--help` | The options and the debug environment variables |
| `-V`, `--version` | The version, then exit |

`PROOT_BUN_VERBOSE`, `PROOT_BUN_STRACE`, `PROOT_BUN_PROFILE`,
`PROOT_NO_SECCOMP` and `PROOT_IGNORE_MISSING_BINDINGS` are environment
variables rather than options; [Debugging](#debugging) is where they are
described.

### The rootfs

`ROOTFS` may be relative. It is resolved to an absolute path before the
bootstrap changes its working directory.

### Bindings

`-b`/`--bind` (`-m`/`--mount`) makes a host path visible inside the guest, and
may be repeated. `-b HOST` binds it at the same pathname; `-b HOST:GUEST` binds
it somewhere else. The first colon separates the two halves, and either half
may be relative to the caller's working directory:

```sh
bunproot -S ./alpine -b /sdcard -b ./sdk:/opt/sdk /bin/sh
```

The most specific binding wins, so `-b /opt/sdk:/usr/lib/sdk` covers everything
below `/usr/lib/sdk` and nothing above it; the rootfs is simply the binding at
`/`. A binding whose host path does not exist is reported and dropped, as
upstream does; `PROOT_IGNORE_MISSING_BINDINGS` silences the report but still
drops it. `/proc`, `/dev` and `/sys` reach the host kernel filesystems without
needing a binding.

### Port mapping and low ports

The guest shares the host network; this is syscall rewriting, not a separate
Docker network namespace or NAT. The explicit form follows Docker's
`HOST_PORT:CONTAINER_PORT` order and may be repeated:

```sh
bunproot -S ./alpine \
  -p 8080:80 \
  -p 127.0.0.1:8443:443 \
  -p 5353:53/udp \
  /bin/server
```

This maps guest TCP 80 to host TCP 8080, restricts guest TCP 443 to host
`127.0.0.1:8443`, and maps guest UDP 53 to host UDP 5353. TCP is the default;
use `/udp` explicitly for UDP. IPv6 host addresses must be bracketed:

```sh
bunproot -S ./alpine -p '[::1]:8080:80' /bin/server
```

On `bind()`, both the mapped port and an explicitly supplied host IP are
substituted before the host kernel sees the address. Localhost `connect()` and
UDP `sendto()` calls receive the corresponding substitution as well; remote
destinations are left alone.

A single Docker-style container port needs no publication because the guest
already uses the host network. It is consumed as a compatibility no-op:

```sh
bunproot -S ./alpine -p 8080 /bin/server
```

For ports 1 through 1023 this cannot reproduce Docker's automatic random host
port allocation, so bunproot prints a warning. Use an explicit mapping, or use
a bare `-p` to protect every low port by adding `PROOT_PORT_ADD` (2000 by
default):

```sh
bunproot -S ./alpine -p 2080:80 /bin/server
PROOT_PORT_ADD=3000 bunproot -p -S ./alpine /bin/server
```

In the second example, a guest `bind()` to port 80 becomes a host bind to
3080. Ports 1024 and above, and port 0 (kernel-selected), remain unchanged.
Whenever this automatic low-port rewrite occurs, bunproot reports the guest
and actual host ports.

### The resolver

A rootfs straight from a distribution tarball often carries no
`/etc/resolv.conf` at all — Alpine's minirootfs does not ship one — so nothing
inside it can resolve a name until somebody writes one by hand. `--dns` binds
one in instead, which also keeps a read-only or throwaway rootfs usable without
editing it. This is not an upstream PRoot feature.

| Mode | What it binds |
| --- | --- |
| `auto` | The default: the bundled resolver, but only where the rootfs has none of its own |
| `simple` | The bundled resolver everywhere, overriding whatever the rootfs carries |
| `off` | Nothing at all; the rootfs answers for itself, with or without a resolver. `no` and `false` say the same thing |

Both `/etc/resolv.conf` and `/tmp/resolv.conf` are covered — the second is
where a guest with no writable `/etc` is left writing its own. Binding a file
needs no file at the guest end: the mount table answers for the pathname
whether or not the rootfs has it.

`--dns` is expanded where it is written, so it takes part in the same
last-one-wins rule as any other binding, and your own `-b` on the same pathname
beats it by coming after:

```sh
bunproot -S ./alpine --dns=simple /bin/sh -c 'cat /etc/resolv.conf'
bunproot -S ./alpine --dns=off -b ./my-resolv.conf:/etc/resolv.conf /bin/sh
```

### Waiting for the guest

Like upstream PRoot, bunproot normally waits for every descendant of `COMMAND`
to exit. A browser or daemon may leave detached processes behind after an
interactive shell exits; use `-koe`/`--kill-on-exit` when leaving that shell
should terminate the whole guest session immediately:

```sh
bunproot -koe -S ./alpine /bin/sh
```

### The guest's own tools

The guest is a real distribution, so its own tools work:

```sh
bunproot -S ./alpine /bin/sh -c 'apk add npm && npm i -g bun'
bunproot -S ./alpine /bin/sh -c 'bun x cowsay hello'
bunproot -S ./alpine /usr/bin/git clone https://github.com/jjtseng93/jsmdcui /tmp/jsmdcui
```

[TESTING.md](./TESTING.md) collects these as the regression checks, with what
each one tells you when it fails.

## Android compatibility

Some of what a Linux guest expects is refused by Android's own policy rather
than by the kernel, and the guest has no second way to ask. bunproot answers
those in the tracer, so nothing in the rootfs needs a wrapper, a host helper
process or an `LD_PRELOAD`.

Android SELinux denies a Linux guest's `NETLINK_ROUTE` queries. bunproot
substitutes a harmless datagram descriptor and synthesizes the link/address
dump from the tracer's native `os.networkInterfaces()` result. Consequently a
guest Bun can use `os.networkInterfaces()` without a wrapper, host Node helper,
or `LD_PRELOAD`.

`-S` also supplies `/dev`, maps `/dev/udmabuf` to `/dev/null` when a device
node is unavailable, and provides Android-hidden overflow uid/gid values. These
are built-in compatibility bindings; no Termux prefix bind is required.

### Syscalls Android refuses to run

Android's seccomp policy is a second kind of refusal, and a harsher one: it
does not fail the call, it kills the caller with SIGSYS. The tracer catches
those and answers in the guest's place. What that answer is depends on what was
blocked.

The **id-setting family** -- `setuid`, `setgid`, `setregid`, `setresuid`,
`setfsuid`, `setgroups` and the rest -- can never be granted to an app uid, so
fake-id0 answers them from its own credentials instead. Without it `su` stops
at `can't set groups: Function not implemented`.

**`accept(2)`** is missing from the allowlist; only `accept4(2)` is there,
which is what bionic's own `accept()` wraps. musl calls `accept` directly, so
the tracer rewinds the guest to its `svc` and reissues the call as `accept4`.
The guest then blocks in the kernel as it means to. Without this a musl server
spins on a socket it can never drain -- PostgreSQL logs `could not accept new
connection: Function not implemented` about ten times a second.

**System V shared memory** is denied outright, so `shmget`, `shmat`, `shmdt`
and `shmctl` are emulated. Segments are backed by files under `TMPDIR` that the
guest maps itself with `MAP_SHARED`, so two guest processes holding the same
key really do share memory rather than each getting a private copy. PostgreSQL
needs this even with `shared_memory_type=mmap`, because it still creates a
small SysV segment as its postmaster interlock. Semaphores and message queues
are not emulated; nothing tested has needed them.

## Native bubblewrap

The guest's real, unmodified `bwrap` can run inside bunproot, without a wrapper
or `LD_PRELOAD`. Android does not grant the app real mount or user namespaces,
so bunproot emulates their syscalls and represents bind mounts, unmounts and
`pivot_root` transitions in a per-process runtime mount table.
`/proc/self/mountinfo` is synthesized from that table so bwrap validates the
same filesystem view that pathname translation enforces. The stock bwrap
arguments hidden in Flatpak's `--args` file descriptor are supported too.

This is compatibility, not a kernel security boundary: a bwrap payload is
still protected only by bunproot's ptrace pathname isolation. See the native
one-file-root regression in [TESTING.md](./TESTING.md#native-bubblewrap).

A writable `TMPDIR` is required, for bwrap's temporary sandbox roots and the
synthetic mountinfo files.

## Flatpak through stock bwrap

Install Flatpak, bubblewrap, D-Bus and a portal backend in the rootfs. The
applications then run through the distribution's stock `/usr/bin/bwrap`:

```sh
# 1. Setup {

bunproot -S "$ROOTFS" /bin/sh

apk add fish flatpak xdg-desktop-portal-gtk font-dejavu
# apk add font-noto-cjk

fish

flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo

flatpak install org.gnome.TextEditor

mkdir -p /run/user/0

# }


# 2. Run { (under fish)

export DISPLAY=:0
export XDG_SESSION_TYPE=x11
export XDG_RUNTIME_DIR=/run/user/0

dbus-run-session fish

flatpak run --filesystem=/root org.gnome.TextEditor &

# }

# flatpak run ANOTHER.APP

```

The X server must already accept TCP display 0; bunproot does not start it. On
Termux with [Termux:X11](https://github.com/termux/termux-x11) installed, that
is one command, run on the host side before the guest shell:

```sh
termux-x11 :0 -listen tcp -ac &
```

`-listen tcp` is what puts display 0 on TCP, and `-ac` drops X's access
control, so keep this to a device you trust. Leave it running for as long as
the guest needs it. The `DISPLAY=:0` above needs no `.X11-unix` binding of its
own: finding no Unix socket for that display inside the rootfs, it falls back
to TCP by itself.

`dbus-run-session` wraps the whole guest shell, not each application. Every
application launched from that shell inherits the same
`DBUS_SESSION_BUS_ADDRESS` and can communicate with the others. Exiting the
shell removes the session bus, so no persistent host or Termux D-Bus service
is required. Wrapping each `flatpak run` separately is suitable for an isolated
smoke test, but gives every application a different bus and is not a desktop
session.

Android normally denies app UIDs access to `/dev/fuse`. Consequently
`xdg-document-portal` cannot create its FUSE export at `$XDG_RUNTIME_DIR/doc`.
The D-Bus portal frontend and GTK FileChooser backend still work for paths the
sandbox can already access. The Text Editor example therefore grants its
trusted sandbox `/root` explicitly; the chooser remains enabled, but its
selection does not need a FUSE document export. Grant a narrower directory
instead when possible. This is a filesystem permission tradeoff, not a
bunproot or bwrap isolation guarantee.

The portal backend runs outside the Flatpak runtime and therefore needs at
least one font in the rootfs. On a fontless Alpine minirootfs, GTK can briefly
map the chooser and then resize it to tens of thousands of pixels, making it
look as though the dialog crashed. `font-dejavu` above supplies the minimal
host-side font set; application-runtime fonts do not replace it.

The launcher should normally already provide a writable `TMPDIR`; if a
minimal APK environment does not, set it to that app's cache directory. It
need not be a Termux path.

Flatpak's payload seccomp filter remains installed. bunproot removes only
the network part of `--unshare-net` or `--unshare-all` from bwrap's argument
stream because an Android app UID cannot configure loopback inside a real
network namespace. The other namespaces requested by `--unshare-all` remain
represented by bunproot. Consequently the emulated sandbox does **not**
provide network-namespace isolation.

## What it needs

- An Android device where `ptrace` is permitted for app processes. That is the
  normal case; a hardened or work-profile environment may not allow it.
- Android's 64-bit linker at `/system/bin/linker64`, and bionic — found in the
  Runtime APEX on Android 10 and later, in `/system/lib64` before that.
- A Bun built for Android/bionic, not a glibc one, preferably 1.4.1 or newer.
  Where it came from does not matter. `bunproot` uses whatever `bun` is on
  `PATH`, which every route above provides; the `proot` shell launcher
  additionally falls back to a `bun-android` beside it.
- An ARM64 Linux rootfs containing the guest ELF and its `PT_INTERP`.

Native library paths are resolved once in `dlpath.js`, which searches the
Runtime APEX and then `/system/lib64` so one order covers every Android release
without asking the platform its version. JavaScript modules open those Android
libraries through `ffi.js`; guest libraries under `ROOTFS/usr` are never used as
the tracer's libc.

Guest syscalls are filtered with seccomp so the tracer only stops for the ones
it translates; `syscall/seccomp.c.js` builds the filter and `PORTING.md`
records what that is worth.

Environment handling is defined once in `env.js`: the tracer's own knobs, the
environment the Android bootstrap is started with, and the environment a guest
inherits. Other modules import from it rather than reading `process.env`.

Each original `src/**/*.c` or `src/**/*.h` has a corresponding `**/*.c.js` or
`**/*.h.js` here. The launcher effectively runs `bun --no-orphans ./index.js`;
`--no-orphans` covers Bun-owned subprocesses, and the tracer also enables
`PTRACE_O_EXITKILL`, which kills tracees if the tracer exits unexpectedly.

## Debugging

Every knob is read in `env.js`. Names shared with the original PRoot keep the
original's name and semantics; the rest are prefixed `PROOT_BUN_` because they
have no upstream counterpart.

| Variable | Effect |
| --- | --- |
| `PROOT_BUN_VERBOSE=1` | Trace ELF loading, process events, signals, guest exec replacement and pathname rewriting. A memory fault also reports `si_code`, `si_addr`, and the mappings the faulting address and the faulting PC belong to. |
| `PROOT_BUN_STRACE=1` | Print every guest syscall and its result. This automatically disables syscall filtering; a result changed by the tracer shows both values, and a translated pathname also shows its host pathname. |
| `PROOT_BUN_PROFILE=1` | On exit, report how many times the tracer stopped, how many of those stops it handled, how many pathnames it translated, and where the wall clock went. |
| `PROOT_NO_SECCOMP` | Set to any value to stop on every syscall instead of filtering. Upstream's variable, with upstream's semantics: presence is what counts. This is also the automatic fallback when the filter cannot be installed. |
| `PROOT_IGNORE_MISSING_BINDINGS` | Set to any value to drop a binding whose host path does not exist without reporting it. The binding is dropped either way; this silences the report. |
| `PROOT_PORT_ADD` | Offset used by bare `-p` to protect guest ports 1–1023; defaults to 2000. A Docker-style `-p [HOST_IP:]HOST_PORT:CONTAINER_PORT[/tcp|udp]` instead enables explicit mapping mode; `-p CONTAINER_PORT` is accepted as a no-op because the guest already shares the host network. |

```sh
PROOT_BUN_VERBOSE=1 PATH="$PWD:$PATH" LD_PRELOAD= \
  bunproot -S "$ROOTFS" /bin/ls /
```

For a syscall-by-syscall view, including the value or pathname the tracer
substituted:

```sh
PROOT_BUN_STRACE=1 bunproot -S "$ROOTFS" /bin/cat /etc/os-release
```

Reading a profile: `stops` is what the tracer paid for and `handled` is what it
got. Without the seccomp filter the first is two per syscall the *guest* makes;
with it, two per syscall the *port translates*. A large gap between them means
the filter is off or is tracing more than it needs to.

```sh
PROOT_BUN_PROFILE=1 bunproot -S "$ROOTFS" /bin/sh -c 'bunx cowsay hello'
```

Tests involving FFI must run as a native Android process. Bun inside a glibc
PRoot cannot safely load Android bionic as a second libc.

## Testing

[TESTING.md](./TESTING.md) is the checklist to run before trusting a change to
the tracer: the unit tests, one integration check per area with what each one
tells you when it fails, the bare rootfs some of them need, and the pitfalls
that cost more time than the bugs did.

## Implementation notes

- The initial Android process is `/system/bin/linker64 /system/bin/sh`, stopped
  with `SIGSTOP`, then replaced by the JavaScript-controlled ELF loader.
- The loader reads `PT_INTERP` from the guest ELF, so glibc, musl, and static
  executables do not depend on a hard-coded guest loader path.
- ARM64 `PTRACE_SYSCALL` stops rewrite guest pathname arguments into `ROOTFS`.
- `/proc`, `/dev`, and `/sys` use the Android kernel filesystems.
- The current vertical slice handles fork, vfork, clone, clone3, execve, and
  `#!` interpreter chains.
- Nested exec preserves the guest environment and applies `FD_CLOEXEC`; tracee
  strings are read with the same `process_vm_readv`-first strategy as upstream.
- Guest-aware absolute symlinks work for both initial commands and nested exec;
  for example Alpine's `/usr/bin/wget -> /bin/busybox` stays inside `ROOTFS`.
- Android app-data `linkat` failures use an exclusive-copy fallback, allowing
  Alpine `apk update` to install downloaded repository indexes. Ordinary
  failed hard links use the relocatable `refs/objs/mets` emulation described
  in [link2symlink.md](./link2symlink.md).
- `--l2s-pin` rewrites both legs of every emulated hard link to carry the
  rootfs's own pathname, which is what a backup or sync tool outside the guest
  needs to follow them; `--l2s-unpin` puts them back. Unpin before entering a
  pinned rootfs: the tracer identifies an emulated hard link by its
  guest-absolute target, so it recognises none of them while they are pinned,
  and binding the rootfs onto itself only hides that -- the files read back
  while reporting a link count of 1 and listing as symlinks. Every target is
  judged on its own, so either direction is idempotent and an interrupted run
  is finished by repeating it. A rootfs whose own pathname contains a
  `.proot.l2s` segment is refused: nothing could tell the recorded prefix from
  the store path afterwards.
- Entering a pinned rootfs is refused outright, because the damage is not
  limited to the reads that fail: a new hard link would be written in the
  portable form beside the pinned ones, and unlinking a pinned alias would
  never decrement its object. The check samples a few refs on startup, which
  also catches a store left halfway through a conversion; `--l2s-ignore-pin`
  overrides it.
- `--l2s-status` names every stale ref under `PROOT_BUN_VERBOSE=1`, and only
  counts them otherwise: a store can hold tens of thousands, and the count is
  what a normal report needs.
- `--l2s-status` reads the store and derives everything from the symlink
  targets themselves, so a rootfs that was copied, moved or half-converted
  still describes what it actually is. Its concurrency is what makes a cold
  store cost about what a warm one does. It recognises an original-format
  `/.l2s` as well, and answers the one question that store cannot answer for
  itself: whether the host pathnames baked into it still lead anywhere.
- An `AF_UNIX` pathname travels in a `sockaddr` rather than as a syscall
  pathname argument, so `bind` and `connect` are translated separately.
  Abstract sockets stay in the host namespace.
- `/proc/<PID>/{exe,cwd,root}` is answered from tracer state rather than from
  the kernel, which still describes the Android bootstrap process because the
  guest image is mapped in instead of `execve`d.
- Reopening a descriptor through `/proc/self/fd/N` is denied by Android under
  ptrace, so the open becomes `dup(N)` as in upstream fake_id0, except for an
  `O_PATH` descriptor, which needs the access mode the open asked for.
- The emulated `execve` resets signal dispositions and the alternate signal
  stack the way the real one does, so signals -- SIGCHLD in particular -- can be
  forwarded to the guest. Node's `child_process` depends on it.
- Android's app seccomp policy reports a blocked syscall as SIGSYS. With the
  default disposition the guest gets `ENOSYS` to fall back on; a sandbox that
  installed a handler to broker the syscall is given the signal instead.
- The initial stack reproduces the kernel's string layout, including the
  ascending order within the argv and environment blocks that libuv measures
  `process.title` against.
- The initial command goes through the same `#!` expansion as a nested
  `execve`, so a script can be named directly on the command line.
- `#!/usr/bin/env NAME` is resolved by the tracer against the guest's own
  `PATH` when the rootfs ships no `env`, so a rootfs holding nothing but Bun
  and its libraries still runs such a script. A guest that does ship `env`
  keeps using it.
- The task name is set the way `execve` sets it, so a guest process is not
  reported as the Android bootstrap's `linker64`.
- `-S` resolves a relative rootfs before changing cwd and enables the current
  fake-id0 layer (`uid=0`, `gid=0`, root supplementary group, and root ownership
  in common stat results).
- That identity is not fixed at root: the set*id family moves a per-task
  credential set, so a guest that drops privilege is seen to have dropped it,
  and `getuid`/`geteuid` answer accordingly. A stat result hands back the saved
  set-user-ID for files the tracer's own uid owns, leaving everything else
  alone. PostgreSQL will not run as root, nor with a data directory it does not
  own, so it needs both halves.
- That identity is translated in both directions across a Unix socket: real
  ids go out in `SCM_CREDENTIALS`, guest ids come back from `SO_PEERCRED`.
  D-Bus authentication needs both halves.
- System V shared memory is emulated over files under `TMPDIR` that the guest
  maps itself, so the tracer never has to pass a descriptor; upstream needs a
  helper process and `SCM_RIGHTS` for that, and it is the part of its sysvipc
  extension that does not work on Android.
- A syscall Android blocks arrives as SIGSYS, already past `svc`. Some are
  answered outright, and `accept` is reissued as `accept4` by rewinding the
  guest one instruction; see
  [Syscalls Android refuses to run](#syscalls-android-refuses-to-run).
- A `NETLINK_ROUTE` socket is emulated rather than opened; see
  [Android compatibility](#android-compatibility).
- Mount and user namespaces are emulated in a per-process runtime mount table,
  with `/proc/self/mountinfo` synthesized from it; see
  [Native bubblewrap](#native-bubblewrap).
- A write into a tracee is checked against its writable mappings first: a fork
  or exec between a syscall's entry and its exit invalidates the buffer the
  entry remembered.
- Scratch slots are pooled and returned when a task exits, so a guest with
  hundreds of simultaneous tasks does not exhaust them.
- `--kill-on-exit` stops tracing as soon as the root guest exits;
  `PTRACE_O_EXITKILL` takes the remaining tracees with the tracer.
- FFI symbols are bound at first use, not at import. Binding them at the top
  of a module made `--version`, `--help` and `--readme` depend on Android's
  bionic being loadable, which they have no need of.
- Regenerate missing one-to-one placeholders with:

```sh
bun run generate-stubs.js
```

This is not yet a drop-in replacement for upstream PRoot. See
[PORTING.md](./PORTING.md) for implemented coverage and remaining work.
