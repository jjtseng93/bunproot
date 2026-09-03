# Provenance and licensing

This project is a port of **PRoot** to Bun/JavaScript. PRoot is licensed under
the **GNU General Public License, version 2 or later**, and this port is a
derivative work of it: every module here corresponds to a file of PRoot's C
source, and the comments cite that source throughout. It is therefore
distributed under the same licence. The full text, together with PRoot's
copyright holders, is in [COPYING](./COPYING).

> The copyright holder for PRoot and CARE is STMicroelectronics.

Nothing here supersedes that. The Bun port adds new work on top; it does not
relicense what it was derived from.

## What it was ported from

The C sources this port follows were taken from
[termux/proot](https://github.com/termux/proot) as of commit
`61681c6481197e3c0cec6726075053adb740f235` (2026-08-15), by way of
[jjtseng93/termux-proot-for-flatpak](https://github.com/jjtseng93/termux-proot-for-flatpak),
a fork of it. The port itself begins at `bun proot 1st iteration`
(`2289ef2ce0edc69628e72bb9cf9ee490f397cf6b`, 2026-09-03), which is the first
commit of this repository's history.

## Reading a `src/...` citation

A path like `src/path/binding.c:new_binding` names a file in **termux/proot**,
not a file in this repository. Read it against the commit above.

Two caveats, because the tree the port was written against was the fork rather
than upstream itself:

- **The fork is one commit behind upstream.** Upstream's
  `7266fb3` (`link2symlink: name the l2s directory by descriptor, not by path`)
  is not in it. Citations of `src/extension/link2symlink/link2symlink.c` were
  written against the older file.

- **The fork changed eight files of its own**, in
  `proot revision for flatpak` (`94fd6d9`) and `port add` (`09b8e7d`):
  `src/cli/proot.c`, `src/extension/mountinfo/mountinfo.c`,
  `src/extension/port_switch/port_switch.c`, `src/syscall/enter.c`,
  `src/syscall/exit.c`, `src/syscall/seccomp.c`, `src/syscall/syscall.h`,
  `src/tracee/seccomp.c`.

  Every citation this port makes into those files was checked against the
  divergence point, and all but one land on code the fork did not touch:
  `handle_option_b` in `src/cli/proot.c`, the `CLONE_NS_MASK` definition in
  `src/syscall/enter.c` (the fork's addition there is the neighbouring
  `DETACHED_OLD_ROOT`), and the `PR_readlink`/`READLINK_PROC_FD` handling in
  `src/syscall/exit.c` (the fork's addition there is `is_dev_full_fd`) are all
  upstream as cited.

  The exception is **`src/syscall/seccomp.c`**: the fork adds `PR_write`,
  `PR_writev`, `PR_pwrite64`, `PR_pwritev` and `PR_pwritev2` to
  `proot_sysnums[]`, so its list of filtered syscalls is not upstream's. That
  does not affect `syscall/seccomp.c.js`, which derives its own list from the
  syscalls this port translates, but a reader comparing the two lists should
  know they were never meant to match.

  Line numbers in citations refer to the fork's tree. Only one citation uses a
  line number at all (`src/tracee/event.c:130`, in `env.js`), in a file neither
  the fork nor upstream's newer commit touches, so it holds for both.
