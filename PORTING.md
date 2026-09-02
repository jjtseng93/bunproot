# Bun port status

The Bun implementation is an ARM64 vertical slice, not yet a drop-in replacement
for the original PRoot. Its current integration target is:

```sh
LD_PRELOAD= proot -S ROOTFS /bin/sh -c 'ls /'
```

This works in the native Termux environment through an Android `linker64` shell
bootstrap, ptrace-controlled remote ELF loading, and guest `execve` emulation.
The nested shebang/exec path is also exercised successfully by:

```sh
LD_PRELOAD= proot -S ROOTFS /usr/bin/bun x --no-install cowsay hello
```

## Remaining compatibility work

1. **Pathname syscall coverage.** Cover all ARM64 pathname arguments, including
   dual-path operations (`renameat*`, `linkat`) and special semantics such as
   `symlinkat`, `openat2`, `execveat`, and final-component dereferencing.
2. **Relative paths and dirfd.** Maintain guest cwd, initialize the kernel cwd
   inside the selected rootfs, support `AT_FDCWD` and directory descriptors,
   and detranslate `getcwd` results.
3. **Canonicalization and symlinks.** Resolve `.`, `..`, bindings, and symlinks
   component by component without allowing traversal outside the guest root.
4. **Exec fidelity.** Read the guest envp, implement `FD_CLOEXEC`, reset signal
   dispositions, retire old mappings/stacks, and expose correct comm, auxv, and
   `/proc/self/exe` state.
5. **Shebang.** Parse `#!`, rebuild argv, and route scripts through the guest
   interpreter before ELF loading.
6. **Process model.** Complete thread groups, clone sharing flags, ptrace exec
   and exit events, signal delivery, and wait status behavior.
7. **Seccomp.** Replace the broad SIGSYS-to-ENOSYS fallback with syscall-aware
   emulation or translation.
8. **Extensions and CLI.** Port bindings, fake-id0, link2symlink, ashmem/memfd,
   mountinfo, hidden-files, port-switch, SysV IPC, and the remaining options.
9. **Architectures.** Add ELF32/AArch32 and other ABIs after ARM64 behavior is
   stable.

For `clone3`, the Bun port now matches the original entry-side policy: it reads
the first `u64` of `struct clone_args`, strips `CLONE_NEW*` namespace flags,
and otherwise lets the kernel execute the syscall.  In particular, it does not
translate `clone3` to `clone`; an older kernel's `ENOSYS` remains visible so
libc or the caller can perform its normal fallback.

Nested guest `execve` is the current process-model blocker for `bun x`.  The
new ELF image must not inherit arbitrary mappings from the Bun child, while a
plain series of `munmap` calls is not equivalent to kernel exec: `mm->brk` and
auxv pointers such as `AT_RANDOM` still describe the old image.  The current
address-space reset preserves the syscall trampoline, heap, vvar, and vdso and
rebuilds `AT_RANDOM`, `AT_PLATFORM`, `AT_BASE_PLATFORM`, and `AT_EXECFN` on the
new guest stack. Full brk virtualization is still required for exec fidelity.

The clone event loop now resumes a new tracee immediately after
`PTRACE_EVENT_CLONE/FORK/VFORK`. Kernels may either report a separate child
SIGSTOP or coalesce it with the event; waiting unconditionally for another stop
deadlocked Node worker startup.

## Current priority

Items 1 and 2 are in progress. Implemented so far:

- ARM64 pathname metadata includes single- and dual-path operations.
- Relative paths are resolved from the per-task guest cwd or `/proc/PID/fd/N`.
- Resolution of `..` is clamped in guest path space before the rootfs prefix is
  applied.
- The bootstrap kernel cwd is moved to `ROOTFS`; forked tasks inherit guest cwd.
- Successful `chdir` updates task state and `getcwd` results are detranslated.
- `/proc`, `/dev`, and `/sys` use the host kernel filesystems, matching the
  essential `-S` bindings needed by runtimes such as Bun/JSC.
- Native Termux tests pass for `/bin/sh -c 'ls /'`, `cd /tmp`, `pwd`, relative
  `ls`, traversal with repeated `..`, `renameat*`, and `symlinkat` behavior.

The guest Bun REPL is also a native regression test: `1+1` evaluates to `2`
and `.exit` returns status 0. This covers zero-extended `AT_FDCWD`, real
`/proc/self/maps`, thread clone flags, and multi-tracee event handling.

Multithreaded pathname rewriting uses a separate 4 KiB scratch slot per traced
TID inside a 1 MiB bootstrap mapping. This prevents one Bun worker from
overwriting another worker's pathname between syscall-entry and execution.
With the guest environment rooted at `HOME=/root`, `TMPDIR=/tmp`, and without
Termux `PREFIX` leakage, the native regression command below completes with
status 0:

```sh
bun i -g --backend=copyfile cowsay
```

Hard-link pathname translation is correct, but Android rejects the underlying
app-data `linkat` with `EACCES`; matching original PRoot on that operation will
require the `link2symlink` emulation tracked under item 8. `execveat` and full
final-component/symlink semantics remain open under items 1 and 3.
