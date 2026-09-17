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


Working-tree semantics supplied by the port
-------------------------------------------

isomorphic-git's checkout, merge and abortMerge treat the index as the old
tree: checkout drops staged changes and deletes staged new files, merge only
moves the ref (or, on conflicts, rewrites the whole result tree into the
worktree without staging the other side's clean changes), and abortMerge
rewrites every clean index entry without its mode or stats.  The port
implements Git's behaviour on top of the object-level APIs:

- checkout/switch: HEAD moves and only the paths the two commits differ in
  are written; local changes are carried across, or refused with Git's
  messages when they would be overwritten; the carried changes are listed.
- merge: the paths the merge changed are written to the index and worktree;
  Git's pre-merge refusals (dirty index, dirty touched paths, untracked
  files in the way) with Git's statuses; `Auto-merging` lines; conflict
  markers labelled `HEAD` and the name as given; modify/delete conflicts;
  the other side's clean changes staged on a conflict; MERGE_HEAD,
  MERGE_MODE and MERGE_MSG written.
- commit: refuses over unmerged paths, concludes a merge with the MERGE_HEAD
  parents and MERGE_MSG (`--no-edit` keeps its comments, as Git does), and
  `--amend` keeps the original author unless `--reset-author`, `--author`
  or `--date` says otherwise.
- merge --abort: `reset --merge` semantics over the paths the merge staged
  or left unmerged.
- status and ls-files -s: conflict stages are read straight from the index
  file, which isomorphic-git keeps but does not expose.
- cherry-pick: isomorphic-git 1.41.9's cherryPick takes `oid` and lands the
  tree itself but has no conflict state; the port adds Git's refusals,
  `-n`, conflict markers, CHERRY_PICK_HEAD, --continue/--skip/--abort and
  the summary line.  `status` does not yet say "You are currently
  cherry-picking".
- log A..B and A...B are computed from two walks; Git's --since cutoff
  around merges is not reproduced exactly.
- notes commits are rewritten with Git's messages, since addNote and
  removeNote hard-code their own.
- show at a shallow clone's boundary treats the commit as a root commit.

Partial commands and deliberate limits
--------------------------------------

- diff pairs only exact (100%) renames; similar-content rename detection is
  not implemented.
- diff during a conflicted merge and show of a merge commit do not produce
  Git's combined (`--cc`) format; show diffs against the first parent.
- `git merge name~N` names the merge `Merge commit 'name~N'` where Git
  strips the suffix; the conflict markers use the name as given like Git.

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
