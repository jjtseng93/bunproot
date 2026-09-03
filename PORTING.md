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
LD_PRELOAD= proot -S ROOTFS /usr/bin/bun x cowsay hello
```

That command resolves a package from the network, installs it into a temporary
`node_modules`, and re-executes the guest Bun as `node` through a `#!` script,
so it exercises the pathname, link2symlink, `/proc` and exec paths at once. It
required three fixes worth keeping in mind:

- ARM64 overrides the asm-generic `open(2)` flags: `O_NOFOLLOW` is `0100000`,
  and `0400000` — the asm-generic `O_NOFOLLOW` — is `O_LARGEFILE`, which musl
  sets on every `open`. Reading the wrong bit suppressed final-component
  symlink resolution for every guest open.
- `/proc/<PID>/{exe,cwd,root}` must be substituted from tracer state as in
  `src/path/proc.c:readlink_proc()`. Upstream needs this only for fidelity,
  because it execve()s the guest for real. Here the guest ELF is mapped in by
  the loader, so the kernel still reports the Android bootstrap binary and
  anything re-executing `/proc/self/exe` would leave the rootfs.
- `getdents64(2)` has to report an emulated hard link as `DT_REG`. `stat(2)`
  already did, but readers that trust `d_type` — Bun's package installer
  walking its own cache — otherwise skip every emulated file.

## Remaining compatibility work

1. **Pathname syscall coverage.** Cover all ARM64 pathname arguments, including
   dual-path operations (`renameat*`, `linkat`) and special semantics such as
   `symlinkat`, `openat2`, `execveat`, and final-component dereferencing.
2. **Relative paths and dirfd.** Maintain guest cwd, initialize the kernel cwd
   inside the selected rootfs, support `AT_FDCWD` and directory descriptors,
   and detranslate `getcwd` results.
3. **Canonicalization and symlinks.** Resolve `.`, `..`, bindings, and symlinks
   component by component without allowing traversal outside the guest root.
4. **Exec fidelity.** Reset signal dispositions, retire old mappings/stacks,
   and expose correct comm, auxv, and `/proc/self/exe` state. Guest envp
   propagation and `FD_CLOEXEC` handling are now implemented.
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

ARM64 syscall entry/exit classification uses `PTRACE_GET_SYSCALL_INFO` when
available, with the per-task toggle retained only as an old-kernel fallback.
Syscall substitution updates `NT_ARM_SYSTEM_CALL`; changing x8 alone does not
change the syscall already cached by the ARM64 kernel. This fixes BusyBox/musl
self-exec from an interactive shell.

Initial commands now use the same guest-root-aware symlink canonicalization as
nested exec. Absolute targets such as Alpine's `/usr/bin/wget -> /bin/busybox`
are resolved inside the guest while argv[0] remains the applet name. Common
fake-id0 calls and stat ownership are translated for `-S`, including uid, gid,
supplementary groups, and `ls -l` ownership.

SIGCHLD observed by the tracer is not reinjected: child termination is already
available through guest wait syscalls, while reinjection after the current
JS-controlled exec replacement can enter a stale signal frame on musl. This
fixes BusyBox wget's `ssl_client` completion path.

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
app-data `linkat` with `EACCES`. Apk's special `/proc/self/fd/N` source form
retains an exclusive-copy fallback; this is enough for `apk update` but does
not preserve hard-link identity. `execveat` remains open.

The first Bun `link2symlink` slice now replaces ordinary failed guest
`linkat()` calls with the relocatable `refs/objs/mets` format documented in
`link2symlink.md`. Existing emulated links share their object on subsequent
links, and successful `unlinkat()` decrements the dangling-symlink count.
The original `/proc/PID/fd/N` deleted-file copy special case is retained for
apk. Single-file rename updates its mirrored ref, same-object rename has native
no-op semantics, and pathname stat/statx plus descriptor fstat report the
emulated link count. Directory rename moves its mirrored refs subtree and walks
only that subtree to retarget affected aliases. Concurrency locking, recovery,
and native-hard-link restoration remain to be implemented.

Git's native clone path is now an integration regression test:

```sh
sh proot -S ../../alpine /usr/bin/git clone \
  https://github.com/jjtseng93/jsmdcui /tmp/jsmdcui
```

The clone completes through HTTPS, object unpacking, and delta resolution. The
supporting fixes deliberately follow the original implementation where one
exists:

- `src/tracee/mem.c` prefers `process_vm_readv` for tracee memory and falls
  back to `PTRACE_PEEKDATA`; the Bun port now does the same when reading exec
  pathnames and argument/environment vectors.
- `src/tracee/event.c` treats a failed `restart_tracee()` as a tracee lifecycle
  race instead of aborting the whole tracer. The Bun loop now drops a task that
  disappears between `waitpid` and `PTRACE_SYSCALL`.
- `src/tracee/tracee.c` derives child sharing from clone flags. The Bun port
  also removes `CLONE_VM | CLONE_VFORK` when its JavaScript-controlled exec
  replacement needs a private child address space.
- A real kernel `execve` closes descriptors marked `FD_CLOEXEC`. Because the
  Bun loader replaces exec in userspace, it reproduces that kernel behavior by
  inspecting `/proc/PID/fdinfo` and closing those descriptors before loading
  the next guest image. This prevents Git helpers from retaining pipe ends and
  deadlocking.
