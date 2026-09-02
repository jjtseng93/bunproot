# PRoot Bun port

Every `src/**/*.c` and `src/**/*.h` has a matching ESM file named
`bunsrc/**/*.c.js` or `bunsrc/**/*.h.js`, so C and header files with the same
basename never collide. Pending modules explicitly export `portStatus` rather
than pretending to implement the original native behavior.

The first ptrace slice supports `-S ROOTFS`. Android's `linker64` starts a
disposable shell which stops itself before guest startup. The Bun tracer then
uses remote syscalls to map the guest ELF and the `PT_INTERP` named by that ELF,
builds its stack/auxv, jumps to the interpreter entry, and uses
`PTRACE_SYSCALL` to rewrite arm64 pathname arguments into the selected rootfs:

```sh
PATH="$PWD/bunsrc:$PATH" LD_PRELOAD= proot -S ROOTFS /bin/ls /
```

All native library paths are centralized in `dlpath.json`. `ffi.js` opens the
Android bionic libraries from `/apex/com.android.runtime/lib64/bionic`; it does
not fall back to libraries under the guest `/usr` tree.

Run this port with the Android-native Bun executable (`../bun-android`). A
GNU/Linux/glibc Bun cannot safely load bionic as a second libc.

Set `PROOT_BUN_VERBOSE=1` to print every path rewritten at syscall entry.

The remote loader does not execute a hard-coded glibc path. Dynamic executables
select glibc, musl, or another loader through their own `PT_INTERP`; static ELF
files have no interpreter mapping. Android-seccomp `SIGSYS` stops are converted
to `ENOSYS`, allowing the guest libc to use its normal compatibility fallback.

Guest fork, vfork, and clone events are followed. A vfork-style clone is
reduced to a normal fork before entry so the child has a private address space
for JS-controlled exec replacement. Guest `execve` is voided and emulated by
remapping the requested ELF in place:

```sh
PATH="$PWD/bunsrc:$PATH" LD_PRELOAD= proot -S ROOTFS /bin/sh -c 'ls /'
```

The launcher enables Bun's `--no-orphans`; ptraced tasks independently use
`PTRACE_O_EXITKILL` as the kernel-level kill-on-exit guarantee.

Regenerate missing one-to-one placeholders after adding a C/H source file:

```sh
bun run bunsrc/generate-stubs.js
```
