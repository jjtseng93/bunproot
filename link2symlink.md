# link2symlink on-disk format

This document defines the planned Bun-port format for emulating hard links on
filesystems where Android/SELinux rejects `link(2)` or `linkat(2)`. It is a new
format inspired by the original `src/extension/link2symlink/link2symlink.c`;
it is not on-disk compatible with the original `.l2s.*` layout.

## Namespace

All internal state lives inside the guest rootfs:

```text
/.proot.l2s/
├── refs/<guest-path>
├── objs/<object-id>
└── mets/<object-id>
```

The names `refs`, `objs`, and `mets` are deliberately all four bytes long.
Code may therefore convert an internal pathname in place without reallocating
or moving its suffix. In particular, replacing `objs` with `mets` maps an
object directly to its metadata entry.

The namespace is reserved for the tracer and recovery tools. Normal guest
operations must not be allowed to corrupt, rename, or remove its contents.
Absolute paths stored in symlinks are guest-absolute paths and must always be
resolved relative to `ROOTFS`, never relative to Android's host `/`.

## Object identifiers

`objs` and `mets` are flat directories. They do not mirror guest paths and do
not initially use sharding directories. Every object has a random 128-bit ID
encoded as exactly 32 lowercase hexadecimal bytes, for example:

```text
8f2c1234567890abcdef0123456789ab
```

IDs must be created with exclusive semantics and regenerated on collision.
They must not encode a pathname, PID, timestamp, inode, or link count.

## Representation

For two guest names that emulate hard links to the same file:

```text
/bin/foo
  -> /.proot.l2s/refs/bin/foo

/usr/bin/foo
  -> /.proot.l2s/refs/usr/bin/foo

/.proot.l2s/refs/bin/foo
  -> /.proot.l2s/objs/8f2c1234567890abcdef0123456789ab

/.proot.l2s/refs/usr/bin/foo
  -> /.proot.l2s/objs/8f2c1234567890abcdef0123456789ab
```

The object itself is the only ordinary file containing user data:

```text
/.proot.l2s/objs/8f2c1234567890abcdef0123456789ab
```

The ref tree mirrors the complete guest-absolute pathname below `refs/`.
Removing the `/.proot.l2s/refs` prefix from a ref path recovers the intended
guest pathname. This makes restoration possible by enumerating `refs` without
scanning the entire rootfs.

## Link-count metadata

The matching `mets` entry is an intentionally dangling symbolic link:

```text
/.proot.l2s/mets/8f2c1234567890abcdef0123456789ab
  -> n0000000000000002
```

Its payload is exactly 17 ASCII bytes:

```text
n<16 lowercase hexadecimal digits>
```

The example represents an emulated link count of two. No entry whose name
matches this payload may be created in `mets`, so the metadata link remains
dangling by construction. Readers must use `lstat(2)` and `readlinkat(2)`,
require the exact format `^n[0-9a-f]{16}$`, and reject zero, overflow, malformed
or unexpected values.

Given an object pathname, metadata lookup is a fixed-width byte substitution:

```text
/.proot.l2s/objs/<object-id>
                ↓ objs → mets
/.proot.l2s/mets/<object-id>
```

The count is a fast cache for `stat` emulation. Valid entries in `refs` remain
the recoverable authority and may be used to rebuild a missing or inconsistent
`mets` entry.

## Atomic metadata update

Never update a count using `unlink` followed by `symlink`, because readers
could observe a missing entry. Create a uniquely named temporary symlink in
the `mets` directory, then atomically rename it over the current entry:

```text
mets/.tmp.<object-id>.<nonce> -> n0000000000000003
rename(mets/.tmp.<object-id>.<nonce>, mets/<object-id>)
```

The directory must be synced when crash durability is required. Atomic rename
prevents torn or temporarily absent count values, but does not prevent lost
updates between multiple tracer processes. Every implementation must take an
exclusive lock on the corresponding open `objs/<object-id>` inode before it
reads the old count or changes refs, aliases, and metadata.

A complete emulated link operation changes several directory entries and
cannot be committed by one filesystem rename. Abrupt tracer termination can
therefore leave refs, aliases, and count out of agreement. Recovery must
validate both legs of every ref and reconstruct counts from valid refs before
garbage-collecting any object. A zero or missing count alone never authorizes
deleting user data.

## Restoration to native hard links

On a filesystem that permits native hard links, a recovery tool walks
`/.proot.l2s/refs`. For every ref it:

1. Derives the guest pathname from the ref pathname.
2. Validates that the guest alias points back to that exact ref.
3. Validates that the ref points to a well-formed object in `objs`.
4. Groups refs by object ID.
5. Creates temporary native hard links from the object to every validated
   guest pathname and atomically renames them over the fake symlinks.
6. Removes the central object name only after every intended alias succeeds;
   the inode then remains owned by the restored guest hard links.
7. Removes the corresponding refs and metadata after successful restoration.

Native hard links cannot cross filesystem boundaries. Restoration must verify
device IDs and report or retain an emulated group when its aliases do not share
a filesystem with its object. It must never silently copy such an object and
claim that hard-link identity was restored.

## Required syscall transparency

The tracer must hide this representation from the guest. At minimum it must
coordinate pathname canonicalization with `link`, `linkat`, `unlink`,
`unlinkat`, `rename`, `renameat`, and `renameat2`; emulate inode and link-count
results for `stat`, `lstat`, `fstat`, `newfstatat`, and `statx`; and repair the
names exposed through `/proc/PID/fd/N`. A guest `readlink` on an emulated hard
link must behave like `readlink` on an ordinary file rather than expose the
internal symlink chain.

Directory renames require matching updates to the mirrored subtree under
`refs` and to affected guest alias targets. Recovery must treat stale ref paths
as inconsistent state rather than restoring data to an unverified pathname.
