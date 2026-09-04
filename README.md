# bunproot

A port of [PRoot](https://github.com/termux/proot) to Bun/JavaScript: a
userspace `chroot`, `mount --bind` and shebang loader for Android, needing no
root and no kernel support beyond `ptrace`.

It runs wherever `bunx` does — Termux, a shell inside an app built with
[minapk](https://github.com/jjtseng93/minapk)
([npm](https://www.npmjs.com/package/@drxiaozhi/minapk)), or any other Android
environment with Bun on `PATH`. The tracer itself is Bun; the guest is an ARM64
Linux rootfs you supply — and that rootfs can be as little as
[five files](#a-rootfs-can-be-five-files).

**This is early work, and it is not trying to replace Termux's PRoot.** That
one is mature, complete and considerably faster; if you are in Termux and it
works for you, keep using it. What this port is for is the case after Termux: a
rootfs runner whose only dependency is a Bun binary, so an Android environment
that never had a package manager — an app built by minapk, a device where
Termux is not an option — still has a way out to a Linux userspace. Bun is the
one thing such an environment can be given as a single file, so it is the one
thing this depends on.

Licensed **GPL-2.0-or-later**, inherited as a derivative work of PRoot.
[NOTICE.md](./NOTICE.md) records what it was ported from and how to read the
`src/...` citations in the comments; [COPYING](./COPYING) is the licence.

## Quick start

bunproot needs a Bun built for Android/bionic, and how you get one depends on
where you are.

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
no npx, so the Bun that runs bunproot has to be the one the APK was built with.
Two of them work today:

- the Bun binary from Termux's TUR repository, or
- the official Bun binary run under the `LD_PRELOAD` shim minapk supplies
  ([oven-sh/bun#39060](https://github.com/oven-sh/bun/issues/39060)).

Either gives the app a `bunx` that can install:

```sh
bunx bunproot --help
```

A stock official Bun without that shim cannot, because installing on Android
runs into the platform's seccomp policy
([oven-sh/bun#39084](https://github.com/oven-sh/bun/pull/39084)). bunproot
keeps its own entry point at the package root partly for that reason — see the
comment at the top of `proot.js`. minapk's documentation covers the build side.

### Route 3: an Android shell with npm

Where Node is already present — some terminal apps ship it — Bun installs
through npm:

```sh
npm install -g bun
npx bunproot --help
```

Every route leaves you with the same `bunproot` command. On platforms other
than Android, follow the [official Bun installation
guide](https://bun.com/docs/installation) — though the tracer targets ARM64
Android and does not yet run anywhere else.

### Route 4: from source

```sh
git clone <this repository> bunproot
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

`resolv.conf` is just one line, `nameserver 1.1.1.1`. Run this command to
generate it:

```sh
echo 'nameserver 1.1.1.1' > bare/etc/resolv.conf
```

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

## Usage

```text
bunproot [-b HOST[:GUEST]]... -S ROOTFS COMMAND [ARG ...]
```

`ROOTFS` may be relative. It is resolved to an absolute path before the
bootstrap changes its working directory.

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

The guest is a real distribution, so its own tools work:

```sh
bunproot -S ./alpine /bin/sh -c 'apk add npm && npm i -g bun'
bunproot -S ./alpine /bin/sh -c 'bun x cowsay hello'
bunproot -S ./alpine /usr/bin/git clone https://github.com/jjtseng93/jsmdcui /tmp/jsmdcui
```

[TESTING.md](./TESTING.md) collects these as the regression checks, with what
each one tells you when it fails.

## What it needs

- An Android device where `ptrace` is permitted for app processes. That is the
  normal case; a hardened or work-profile environment may not allow it.
- Android's 64-bit linker at `/system/bin/linker64`, and bionic under
  `/apex/com.android.runtime/lib64/bionic`.
- A Bun built for Android/bionic, not a glibc one. `bunproot` uses whatever
  `bun` is on `PATH`, which every route above provides; the `proot` shell
  launcher additionally falls back to a `bun-android` beside it.
- An ARM64 Linux rootfs containing the guest ELF and its `PT_INTERP`.

Native library paths are defined once in `dlpath.json`. JavaScript modules open
those Android libraries through `ffi.js`; guest libraries under `ROOTFS/usr`
are never used as the tracer's libc.

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
| `PROOT_BUN_PROFILE=1` | On exit, report how many times the tracer stopped, how many of those stops it handled, how many pathnames it translated, and where the wall clock went. |
| `PROOT_NO_SECCOMP` | Set to any value to stop on every syscall instead of filtering. Upstream's variable, with upstream's semantics: presence is what counts. This is also the automatic fallback when the filter cannot be installed. |

```sh
PROOT_BUN_VERBOSE=1 PATH="$PWD:$PATH" LD_PRELOAD= \
  proot -S "$ROOTFS" /bin/ls /
```

Reading a profile: `stops` is what the tracer paid for and `handled` is what it
got. Without the seccomp filter the first is two per syscall the *guest* makes;
with it, two per syscall the *port translates*. A large gap between them means
the filter is off or is tracing more than it needs to.

```sh
PROOT_BUN_PROFILE=1 proot -S "$ROOTFS" /bin/sh -c 'bunx cowsay hello'
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
- `/proc/<PID>/{exe,cwd,root}` is answered from tracer state rather than from
  the kernel, which still describes the Android bootstrap process because the
  guest image is mapped in instead of `execve`d.
- The emulated `execve` resets signal dispositions and the alternate signal
  stack the way the real one does, so signals -- SIGCHLD in particular -- can be
  forwarded to the guest. Node's `child_process` depends on it.
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
- Regenerate missing one-to-one placeholders with:

```sh
bun run generate-stubs.js
```

This is not yet a drop-in replacement for upstream PRoot. See
[PORTING.md](./PORTING.md) for implemented coverage and remaining work.
