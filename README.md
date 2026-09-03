# PRoot Bun port

This directory contains the Bun/ESM port of PRoot. Each original
`src/**/*.c` or `src/**/*.h` has a corresponding `bunsrc/**/*.c.js` or
`bunsrc/**/*.h.js`. The working implementation currently targets ARM64
Android and must use the Android-native `bun-android`, not a glibc Bun binary.

## Requirements

- A ptrace-capable Termux environment.
- Android's 64-bit linker at `/system/bin/linker64`.
- Android bionic libraries under `/apex/com.android.runtime/lib64/bionic`.
- The native Bun executable at `../bun-android` relative to this directory.
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

## Usage

Add this directory to `PATH` so the `proot` launcher invokes the Bun port:

```sh
cd /path/to/prbun
PATH="$PWD:$PATH" LD_PRELOAD= proot [-b HOST[:GUEST]]... -S ROOTFS COMMAND [ARG ...]
```

`ROOTFS` may be relative. It is resolved to an absolute path before the
bootstrap changes its working directory.

`-b`/`--bind` (`-m`/`--mount`) makes a host path visible inside the guest, and
may be repeated. `-b HOST` binds it at the same pathname; `-b HOST:GUEST` binds
it somewhere else. The first colon separates the two halves, and either half
may be relative to the caller's working directory:

```sh
proot -S "$ROOTFS" -b /sdcard -b ./sdk:/opt/sdk /bin/sh
```

The most specific binding wins, so `-b /opt/sdk:/usr/lib/sdk` covers everything
below `/usr/lib/sdk` and nothing above it; the rootfs is simply the binding at
`/`. A binding whose host path does not exist is reported and dropped, as
upstream does; `PROOT_IGNORE_MISSING_BINDINGS` silences the report but still
drops it. `/proc`, `/dev` and `/sys` reach the host kernel filesystems without
needing a binding.

For the Termux `proot-distro` Debian rootfs used during development:

```sh
ROOTFS=/data/data/com.termux/files/usr/var/lib/proot-distro/containers/debian/rootfs
PATH="$PWD:$PATH" LD_PRELOAD= proot -S "$ROOTFS" /bin/ls /
PATH="$PWD:$PATH" LD_PRELOAD= proot -S "$ROOTFS" /bin/sh -c 'ls /'
```

Shebang handling and nested guest `execve` can be checked with:

```sh
PATH="$PWD:$PATH" LD_PRELOAD= proot -S "$ROOTFS" \
  /usr/bin/bun x --no-install cowsay hello
```

The same command without `--no-install` additionally covers package resolution,
installation into a temporary `node_modules`, and re-execution of the guest Bun
as `node`:

```sh
cd bunsrc
sh proot -S ../../alpine /bin/sh -c "bun x cowsay hello"
```

Node, npm and a second Bun installed through npm are covered by:

```sh
cd bunsrc
sh proot -S ../../alpine /bin/sh -c "apk add npm && npm i bun@1.3.14"
sh proot -S ../../alpine /bin/sh -c "./node_modules/.bin/bun --version"
```

Git over HTTPS is covered by the Alpine integration test:

```sh
cd bunsrc
sh proot -S ../../alpine /usr/bin/git clone \
  https://github.com/jjtseng93/jsmdcui /tmp/jsmdcui
```

The launcher effectively runs:

```sh
/system/bin/linker64 ../bun-android --no-orphans ./index.js "$@"
```

`--no-orphans` covers Bun-owned subprocesses. The tracer also enables
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

Tests involving FFI must run in native Termux. Bun inside a glibc PRoot cannot
safely load Android bionic as a second libc.

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
../bun-android run generate-stubs.js
```

This is not yet a drop-in replacement for upstream PRoot. See
[PORTING.md](./PORTING.md) for implemented coverage and remaining work.
