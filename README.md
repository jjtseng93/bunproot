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

## Usage

Add this directory to `PATH` so the `proot` launcher invokes the Bun port:

```sh
cd /path/to/prbun
PATH="$PWD:$PATH" LD_PRELOAD= proot -S ROOTFS COMMAND [ARG ...]
```

`ROOTFS` may be relative. It is resolved to an absolute path before the
bootstrap changes its working directory.

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

Set `PROOT_BUN_VERBOSE=1` to show ELF loading, process events, signals, guest
exec replacement, and pathname rewriting:

```sh
PROOT_BUN_VERBOSE=1 PATH="$PWD:$PATH" LD_PRELOAD= \
  proot -S "$ROOTFS" /bin/ls /
```

Tests involving FFI must run in native Termux. Bun inside a glibc PRoot cannot
safely load Android bionic as a second libc.

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
- `-S` resolves a relative rootfs before changing cwd and enables the current
  fake-id0 layer (`uid=0`, `gid=0`, root supplementary group, and root ownership
  in common stat results).
- Regenerate missing one-to-one placeholders with:

```sh
../bun-android run generate-stubs.js
```

This is not yet a drop-in replacement for upstream PRoot. See
[PORTING.md](./PORTING.md) for implemented coverage and remaining work.
