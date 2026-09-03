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
- A descriptor opened through an emulated hard link is reported by the kernel
  under its `/.proot.l2s/objs/<id>` storage name, so `readlink` on
  `/proc/<PID>/fd/<FD>` has to give back the name the tracee itself used, as in
  link2symlink's `READLINK_PROC_FD` callback. Bun resolves an ES module's own
  directory this way, so `bun x bunmsh` otherwise looked for its relative
  imports next to the storage object.

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

SIGCHLD is forwarded to the guest like any other signal. It used to be dropped,
because delivering it killed the tracee; the cause was that the emulated execve
never reset signal dispositions, so a handler address belonging to the Android
bootstrap shell stayed registered and the kernel delivered into an address the
new image does not map. `resetGuestSignals()` now does what execve does --
every caught signal back to `SIG_DFL` (`SIG_IGN` and `SIG_DFL` survive, as in
execve) and `sigaltstack(SS_DISABLE)` -- at bootstrap and at every emulated
exec. Node's `child_process` needs the forwarded SIGCHLD to complete a spawn;
BusyBox wget's `ssl_client` path, git's helpers and `bun x` all still pass.

The guest's main stack is mapped at `RLIMIT_STACK` rather than 1 MiB. The
mapping is fixed and the kernel never grows it, so a guest reading back
`ulimit -s` of 8 MiB and sizing its own guard from it -- V8 does -- would run
off the end of a 1 MiB mapping.

`fchownat`/`fchown` swap the emulated ids for the real ones before the kernel
sees them, as in `src/extension/fake_id0/chown.c:handle_chown_enter_end()`.
Chowning a file to the ids it already carries is allowed without `CAP_CHOWN`,
while the guest's root ids never are, so without the swap every archive
extraction reported that it could not preserve ownership: `apk add npm` ended
in `23 errors`, and `apk fix` now reports `OK`.

`buildGuestStack()` emits the initial strings in the kernel's order. The kernel
fills the top of a new stack downwards -- AT_RANDOM and AT_PLATFORM, the
executable name behind AT_EXECFN, the environment strings, then the argument
strings -- and copies each block from its last entry to its first
(`fs/exec.c:copy_strings`), so entry 0 lands at the lowest address of its block
and the block ascends with the index. Emitting them in index order reverses
each block, which stays invisible until something measures one: libuv takes the
process-title buffer as `argv[argc-1] + strlen(argv[argc-1]) - argv[0]`, which
is negative on a reversed stack. `npm` assigns `process.title` on startup, so
it called `memset()` from `argv[0]` with a length of `(size_t)-42` and died on
the first page above its stack. That was the whole reason `npm` did not run.

An exec whose `PT_INTERP` is missing is refused during the enter stage, where
the real `execve` can still run and report `ENOENT` to the guest itself. The
commit stage has already torn down the address space, so a failure there had
nowhere to return an errno and took the tracer down with it. Guests do probe
binaries they cannot run: `npm i bun` installs both the glibc and the musl
build and tries one of them.

This chain now works end to end in the Alpine rootfs:

```sh
apk add npm
npm i bun@1.3.14
./node_modules/.bin/bun x cowsay hello
```

A memory fault under `PROOT_BUN_VERBOSE=1` reports `si_code`, `si_addr`, the
mapping the address belongs to and the mapping the faulting PC belongs to,
which is what identified the stack layout bug.

## Syscall filtering

A tracer that restarts every tracee with `PTRACE_SYSCALL` stops twice for each
syscall the guest makes, and a guest makes far more syscalls than this port
translates. `bunx` against a warm cache took **45946 stops to reach 509 that
mattered**, and 71% of the wall clock was spent in `waitpid`.

`src/syscall/seccomp.c` is ported in `syscall/seccomp.c.js`: a classic-BPF
program answering `SECCOMP_RET_TRACE` for exactly the syscalls the enter stage
handles and `SECCOMP_RET_ALLOW` for everything else. It is installed on the
bootstrap through the remote-syscall trampoline (`PR_SET_NO_NEW_PRIVS` first,
which an unprivileged filter requires) and is inherited by every fork and
execve afterwards. `PTRACE_O_TRACESECCOMP` turns a filtered syscall into a
`PTRACE_EVENT_SECCOMP` stop, which the loop treats as the entry stop; it then
asks for that one syscall's exit with `PTRACE_SYSCALL` and otherwise restarts
tracees with `PTRACE_CONT`. The tracer's own remote `munmap`, `chdir` and
`close` trip the filter, so `remoteSyscallAt()` steps over a seccomp stop the
way it already steps over the bootstrap's queued `SIGSTOP`.

Two cheaper changes came first. `PTRACE_GET_SYSCALL_INFO` already carries the
syscall number, its arguments and its return value, so the enter stage reads it
from there instead of paying a `PTRACE_GETREGSET`, and registers are fetched
lazily -- once per stop, shared by every exit-stage handler -- and never at all
for a syscall the port does not translate.

| | before | + lazy registers | + seccomp |
| --- | --- | --- | --- |
| `/bin/true` | 211 ms | | 130 ms |
| `bun --version` | 1195 ms | 733 ms | 147 ms |
| `node --version` | 321 ms | | 164 ms |
| `bunx jsmdcui --version` (warm) | 5130 ms | 2790 ms | 501 ms |
| stops for that `bunx` | 45946 | 45946 | 1030 |

`PROOT_BUN_PROFILE=1` reports the stop count, how many of those stops the port
handled, how many pathnames it translated, and where the wall clock went.
Upstream's `PROOT_NO_SECCOMP` restores stopping on every syscall -- set to any
value, as upstream tests for presence rather than a value -- which is also the
automatic fallback when the filter cannot be installed.

Installing the filter requires `PR_SET_NO_NEW_PRIVS`, so a guest cannot gain
privileges through a setuid binary afterwards. Nothing in a `-S` rootfs could
anyway -- the fake-id0 layer is the only root there is.

`env.js` owns every environment decision: the tracer's knobs, the bootstrap
environment, and the guest environment. A guest inherits the caller's variables
-- PRoot is not a container -- except those naming a host path or host-only
tooling. npm and npx export an `npm_config_*` block describing the host npm, so
without the filter a guest `npm i -g` installed into `ROOTFS/<host prefix>/bin`,
`npm root -g` answered with the host's path, and the installed command was on no
guest PATH.

`fchownat`/`fchown` report success for every id, not only the emulated root
ids that upstream swaps. This layer already answers every `stat` with uid 0 and
gid 0, so an ownership the guest cannot observe costs nothing to drop, while
failing the call makes ordinary archive extraction report that it could not
preserve ownership -- Alpine's `shadow` and `linux-pam` ship `root:shadow`
files, and apk counts one error per file.

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
