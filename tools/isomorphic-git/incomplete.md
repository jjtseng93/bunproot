`bunproot --git` remaining work
================================

This file records the state after the isomorphic-git 1.41.9 wrapper was
expanded and compared command-for-command with native Git.  The everyday
commands and the APIs that can be exposed as thin Git-compatible wrappers are
now covered.


Completed from the original list
--------------------------------

- notes
  - add, append, copy, show, remove, list, prune and get-ref
  - --ref, -m, -F, -f and --allow-empty
- merge-base
  - normal merge-base lookup, --all and --is-ancestor
- check-ignore
  - pathname arguments, --quiet and --no-index
- update-ref
  - create/update/delete, expected old object and basic --stdin
  - --stdin understands update, create, delete and verify
- log
  - --since and --follow
- clone/fetch shallow options
  - --shallow-since and repeatable --shallow-exclude
  - fetch --deepen uses isomorphic-git's relative depth
- fetch --prune-tags
- status --ignored
- ls-remote --symref and --exit-code
- plumbing commands
  - hash-object -t/-w/--stdin/--stdin-paths
  - write-tree
  - mktree, including -z, --missing and --batch
  - commit-tree with parents, -m, -F and stdin
  - mktag
- diff
  - --check, --stat, --name-only, --name-status and --no-index
  - --no-index handles file/file and directory/directory comparisons
- show --stat --oneline HEAD

The previously requested compatibility probes are covered as well:

- diff --check and diff --stat
- show of one object, including --stat, --no-patch and --oneline
- log --all
- branch --show-current
- rev-parse --show-toplevel
- ls-files -s/-o/-z and pathspecs
- check-ignore
- merge-base


Partial commands and deliberate limits
--------------------------------------

- show supports one object and the common patch/stat/oneline forms.  It does
  not implement Git's complete formatting and pathspec surface.
- ls-files supports the common cached, stage, others, NUL and path-filter
  forms, not every native Git option.
- notes does not implement edit or merge.  Those need editor and notes-tree
  merge behaviour rather than a thin API mapping.
- update-ref --stdin does not implement transaction commands
  (start/prepare/commit/abort), quoted input or -z.
- hash-object does not run Git attributes/clean filters or implement --path.
- mktag writes valid raw tag objects but does not reproduce every native
  fsck/--strict diagnostic.
- diff --no-index intentionally rejects a file-versus-directory comparison;
  file/file and directory/directory are supported.
- clone/fetch expose the shallow controls supplied by isomorphic-git, but do
  not attempt every native Git shallow-boundary edge case.
- checkout's dryRun, noUpdateHead, nonBlocking and batchSize are library API
  controls, not native `git checkout` command-line options.  noUpdateHead is
  used internally where restore-like behaviour requires it; the others are
  deliberately not exposed as invented Git options.
- log includeChanges is an isomorphic-git result-shape option rather than a
  native Git CLI option, so it is not exposed.
- listServerRefs protocolVersion, symrefs and peelTags are library controls.
  ls-remote uses them internally and exposes the corresponding real Git
  option, --symref.


Remaining work that is not a thin wrapper
-----------------------------------------

- pack-objects
  - packObjects can create a pack, but native Git's stdin object selection,
    stdout/index/thin-pack behaviour and protocol-facing modes need a proper
    compatibility layer.
- index-pack
  - indexPack exists, but stdin/stdout, fix-thin, keep and object database
    integration require more than argument forwarding.
- full update-ref transactions and reflog semantics
- notes edit/merge and their conflict handling
- full show formatting/pathspec behaviour
- full hash-object filters, attributes and --path behaviour
- signatures and signing workflows


Not directly provided by isomorphic-git
---------------------------------------

These cannot be described as APIs that merely need wrapping:

- rebase
- blame
- grep
- revert
- clean
- bisect
- worktree
- submodule
- a general reflog API
- hooks, signatures and LFS
- SSH transport


APIs used internally rather than exposed as commands
----------------------------------------------------

- fastForward strengthens merge/pull behaviour; Git has no ordinary
  `git fast-forward` command.
- readBlob, readCommit, readTree and readTag back show, cat-file and diff.
- walk, TREE, STAGE and WORKDIR back status, diff, checkout and write-tree.


Portability and verification
----------------------------

The --git path runs before the Android-only tracer.  Its filesystem and path
handling uses Bun/Node APIs and has explicit Windows handling for file URLs,
drive-relative path checks, editor launching, file modes and symlinks.  The
wrapper is intended to run on Windows, macOS and Linux, although the current
interactive device validation is Android/Termux rather than desktop CI.

`test/isogit.test.js` runs the same commands through native Git and the
wrapper in isolated temporary repositories with a separate HOME.  Keep new
Git-compatible behaviour covered there.
