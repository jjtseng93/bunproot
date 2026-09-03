# Regression checks

What to run before trusting a change to the tracer. Everything here must run in
native Termux: the port loads Android bionic through FFI, which Bun cannot do
from inside a glibc PRoot.

`proot` below is this directory's launcher, so run the checks from here as
`sh proot …`, or put the directory on `PATH` as [README.md](./README.md#usage)
describes. `ROOTFS` is an ARM64 Linux rootfs; the examples use the Alpine one
the port is developed against. A few checks want a second, deliberately bare
rootfs — see [A rootfs with nothing but Bun](#a-rootfs-with-nothing-but-bun).

## Unit tests

```sh
cd bunsrc
LD_PRELOAD= /system/bin/linker64 "$(realpath ../bun-android)" test
```

Covers argument and binding parsing, guest path canonicalization, the
link2symlink on-disk format, `#!` expansion including the `env` search, and ELF
`PT_INTERP` reading. Fast, no rootfs needed, so run it first.

## Integration checks

Each line names what breaks when it fails, so a red one points somewhere.

| Check | Exercises |
| --- | --- |
| `proot -S "$ROOTFS" /bin/sh -c 'ls /'` | The vertical slice: bootstrap, ELF loading, path translation |
| `proot -S "$ROOTFS" /bin/sh -c 'bun x cowsay hello'` | Registry resolve, install, `#!` re-exec, `getdents64` d_type for emulated hard links |
| `proot -S "$ROOTFS" /bin/sh -c 'bun x bunmsh -c "echo ok"'` | ES module resolution, which reads a module's own directory back through `/proc/<PID>/fd/<FD>` |
| `proot -S "$ROOTFS" /usr/bin/git clone -q https://github.com/jjtseng93/jsmdcui "$C"` | HTTPS, git's helper processes, the link2symlink hard-link emulation on pack files |
| `proot -S "$ROOTFS" /bin/sh -c "mkdir -p $FRESH; cd $FRESH; git init -q . && echo x > a && git add a && git -c user.email=a@b -c user.name=c commit -qm t"` | Loose-object hard links. **`$FRESH` must be a guest path that has never been used** — see the pitfalls below |
| `proot -S "$ROOTFS" /usr/bin/wget -q -O- https://example.com` | An absolute guest symlink (`/usr/bin/wget -> /bin/busybox`), TLS, and `ssl_client`'s completion path |
| `proot -S "$ROOTFS" /sbin/apk fix` | Archive extraction and ownership. Must print `OK: … in N packages` with **no** error count |
| `proot -S "$ROOTFS" /usr/bin/node -e 'require("child_process").execSync("echo hi")'` | SIGCHLD forwarding, which needs the signal dispositions an emulated exec resets |
| `proot -S "$ROOTFS" /bin/sh -c 'npm --version && npm root -g'` | Environment hygiene: the answer must be a guest path, never a host one |
| `proot -S "$ROOTFS" -b /some/dir:/mnt /bin/sh -c 'cat /mnt/f; cd /mnt && pwd'` | Bindings in both directions, including `getcwd` detranslation |
| `proot -S "$ROOTFS" /bin/sh -c 'readlink /proc/self/exe; cat /proc/$$/comm; :'` | The state a mapped-in image cannot inherit from `execve`. The trailing `:` matters: without it the shell execs itself away into the last command, and `$$` names that command instead |

## A rootfs with nothing but Bun

The `env`-less `#!` search and anything else that must not assume coreutils need
a rootfs holding only a Bun binary, its libraries, and a resolver:

```text
/bin/bun
/lib/ld-musl-aarch64.so.1  /lib/libc.musl-aarch64.so.1
/lib/libstdc++.so.6        /lib/libgcc_s.so.1
/etc/resolv.conf
```

`libgcc_s.so.1` is needed even though `readelf -d` does not list it: it is
`libstdc++`'s own dependency, not Bun's.

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

## Pitfalls that cost more time than the bugs

- **`/tmp` is not writable in native Termux.** It is `drwxrwx--x shell shell`;
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
