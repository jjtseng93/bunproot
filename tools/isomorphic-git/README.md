# bunproot --git

A Git-compatible command line over [isomorphic-git](https://isomorphic-git.org/)
for hosts without a system Git. bunproot runs isomorphic-git underneath but
wraps its supported API surface in Git's own shape -- Git subcommands,
options, output and exit statuses -- rather than exposing isomorphic-git's
CLI. It is a deliberately useful subset, not a claim to implement every Git
command or option. `--git` selects this mode only when it is the very first
bunproot argument, which is what makes an alias work:

```sh
alias git='bun x bunproot --git'
```

This file is what `bunproot --git --readme` renders, with clickable links
where the terminal supports them. `git --help` prints the command list,
`git <command> --help` one command's options.

## Global options

```text
git [--yes] [-C <path>] [-c <name>=<value>] <command> [<args>]
git --version | --help | --readme
```

- `--yes` installs the locked isomorphic-git without asking (see
  [Installation](#installation)).
- `-C <path>` runs the command in that directory; `-c <name>=<value>` sets a
  configuration value for the one run. `-P`, `--no-pager`, `--paginate`,
  `--no-replace-objects` and `--literal-pathspecs` are accepted and ignored.

## Commands

The everyday commands first, then the rest, each in alphabetical order. A
sub-item gives the option or behaviour worth knowing; `git <command> --help`
prints the same usage line.

- `add [-A | -u] [-n] [-v] [--] <pathspec>...`
- `branch [-a | -r] | branch <name> [<start-point>] | branch (-d | -D | -m | -M | -u <upstream>) ... | branch --show-current`
- `checkout [-f] [-q] <branch> | checkout -b <new-branch> [<start-point>] | checkout [<tree-ish>] -- <pathspec>...`
  - Staged and unstaged changes are carried across a switch, or refused
    with Git's messages when they would be overwritten; `-f` discards them.
    The changes carried across are listed as Git lists them.
- `clone [--depth <n> | --shallow-since <date>] [--shallow-exclude <ref>] [-b <branch>] [--single-branch] [--no-tags] [-n] [-q] [--progress] <repository> [<directory>]`
  - HTTP(S), local paths and `file://` URLs.
- `commit [-a] [-q] [--amend] [--reset-author] [--allow-empty] [--author=<author>] [--date=<date>] [-m <msg> | -F <file>] [--] [<pathspec>...]`
  - Without `-m`/`-F` the message comes from `GIT_EDITOR`, `VISUAL` or
    `EDITOR`. `--amend` keeps the original author unless `--reset-author`,
    `--author` or `--date` says otherwise. With `MERGE_HEAD` or
    `CHERRY_PICK_HEAD` present the prepared message and parents are used
    (`--no-edit` keeps the message's comments, as Git does); unmerged paths
    are refused.
- `config [--global | --local] <name> [<value>] | config --get <name> | config --unset <name> | config --list | config --add <name> <value>`
- `diff [--cached] [--check | --stat | --name-only | --name-status] [-U<n>] [--exit-code] [--no-renames] [<commit> [<commit>] | <commit>..<commit> | <commit>...<commit>] [--] [<path>...]`
- `diff --no-index [<options>] <path> <path>`
  - File/file and directory/directory; one file against one directory is
    not implemented.
- `fetch [--depth <n> | --deepen <n> | --shallow-since <date>] [--shallow-exclude <ref>] [--tags] [-p] [-q] [--all] [--progress] [<remote> [<branch>]]`
  - Reports the refs it moved the way Git does, and nothing when nothing
    moved. Follows Git 2.48 in creating `refs/remotes/<remote>/HEAD` when it
    is missing, under `remote.<remote>.followRemoteHEAD`.
- `init [-q] [--bare] [-b <branch>] [<directory>]`
- `log [--all] [-n <count>] [--oneline] [--format=<format>] [--since=<date>] [--follow] [--reverse] [<revision> | <rev>..<rev> | <rev>...<rev>] [-- <path>]`
  - `--format` takes the common placeholders and `%xNN`; `format:` and
    `tformat:` differ in their final newline as in Git.
- `merge [--no-ff | --ff-only] [-m <msg>] [--allow-unrelated-histories] <commit> | merge --abort`
  - See [Where the port goes beyond a thin wrapper](#where-the-port-goes-beyond-a-thin-wrapper).
- `mv [-f] <source>... <destination>`
- `pull [--ff-only | --no-ff] [-q] [--progress] [<remote> [<branch>]]`
  - A fetch followed by a merge; there is no `--rebase`.
- `push [-u] [-f] [-d] [--tags] [--all] [-q] [--progress] [<remote> [<refspec>...]]`
- `remote [-v] | remote add <name> <url> | remote remove <name> | remote get-url <name> | remote set-url <name> <url>`
- `reset [--soft | --mixed | --hard] [-q] [<commit>] | reset [<tree-ish>] [--] <pathspec>...`
- `restore [--staged] [--worktree] [--source=<tree-ish>] [--] <pathspec>...`
- `rm [--cached] [-r] [-q] [--] <pathspec>...`
- `show [--stat | --no-patch] [--oneline] [<object>]`
  - One object: a commit with its patch or stat, an annotated tag before
    what it points to, a blob or tree as `cat-file -p` prints it. A shallow
    clone's boundary commit is shown as a root commit.
- `stash [push [-m <msg>] | pop [<n>] | apply [<n>] | drop [<n>] | list | clear]`
  - Tracked files only, and apply/pop cannot abort on conflicts.
- `status [-s | --porcelain] [-b] [--ignored] [--] [<pathspec>...]`
  - Paths are relative to the current directory except with `--porcelain`;
    a merge in progress is reported with its unmerged paths.
- `switch [-f] [-q] <branch> | switch -c <new-branch> [<start-point>]`
  - The same rules as `checkout`.
- `tag [-l [<pattern>]] | tag [-a] [-m <msg>] [-f] <tagname> [<commit>] | tag -d <tagname>...`

Less often:

- `cat-file (-t | -s | -e | -p) <object>`
- `check-ignore [-q] [--no-index] <pathname>...`
- `cherry-pick [-n] <commit> | cherry-pick (--continue | --skip | --abort)`
  - Single-parent commits. Keeps the picked author; a conflict leaves
    `CHERRY_PICK_HEAD` and Git's markers, then `--continue` commits.
- `commit-tree <tree> [-p <parent>]... [-m <message> | -F <file>]...`
  - The message may also come from stdin.
- `hash-object [-t <type>] [-w] [--stdin | --stdin-paths | <file>...]`
  - No attributes or clean filters, no `--path`.
- `ls-files [-s] [-o] [-z] [--full-name] [--] [<path>...]`
  - The current directory's subtree, relative to it, unless `--full-name`;
    `-s` lists conflict stages.
- `ls-remote [--heads] [--tags] [--refs] [--symref] [--exit-code] [<remote or url> [<pattern>...]]`
- `merge-base [-a] <commit> <commit>... | merge-base --is-ancestor <commit> <commit>`
- `mktag`
  - Reads the tag object from stdin; not every native fsck diagnostic is
    reproduced.
- `mktree [-z] [--missing] [--batch]`
- `notes [--ref <notes-ref>] [list | show | add | append | copy | remove | prune | get-ref] [-m <msg> | -F <file>] [--allow-empty] ...`
  - No `edit` or `merge`. Notes commits carry Git's messages.
- `rev-parse [--short] [--abbrev-ref] [--verify] <revision>... | rev-parse --show-toplevel | --git-dir | --is-inside-work-tree | --show-prefix`
- `show-ref [--heads] [--tags] [-d] [-s] [<pattern>...]`
- `update-ref [-m <reason>] <refname> <new-oid> [<old-oid>] | update-ref -d <refname> [<old-oid>] | update-ref --stdin`
  - `--stdin` understands update, create, delete and verify; no
    transactions, quoting or `-z`.
- `version`
- `write-tree`

Revisions are `HEAD`, a ref, a full or abbreviated id, or any of those with
`~N`, `^N` and `^{}` suffixes. The plumbing commands accept their common
stdin forms, including `hash-object --stdin-paths`, `mktree --batch` and
basic `update-ref --stdin`.

## A walk through the everyday flow

```sh
git clone --depth 1 --branch main https://github.com/jjtseng93/jsmdcui
cd jsmdcui
git status
git checkout -b feature
echo hello > hello.txt
git add hello.txt && git commit -m "add hello"
git diff main --stat            # the branch against main
git switch main
git merge feature               # a true merge, or a fast-forward
git log --oneline --all
git tag -a v1 -m "first" && git show v1 --stat
git push -u origin main
```

A conflicted merge follows Git's course: `status` reports the unmerged
paths, the conflict markers read `<<<<<<< HEAD` and `>>>>>>> <name>`,
`git add` marks a resolution, `git commit` concludes the merge with a merge
commit, and `git merge --abort` puts things back.

## Identity, credentials and editors

Identity comes from `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, the repository config or
`~/.gitconfig`. HTTPS credentials are looked up in Git's order and never
prompted for:

1. `GIT_USERNAME`/`GIT_PASSWORD`, then a `GIT_TOKEN` or `GITHUB_TOKEN`.
2. The configured `credential.<url>.helper` and `credential.helper` entries,
   from the repository, `~/.gitconfig` or `-c`: `store [--file=<path>]`, a
   shell command after `!` such as `!gh auth git-credential`, a program by
   path, or a `git-credential-<name>` program on `PATH`. Each is given Git's
   `get` request on stdin (`protocol`, `host`, `path`, `username`) and read
   back the same way. `cache` needs Git's own daemon and is skipped.
3. `~/.git-credentials`, then `$XDG_CONFIG_HOME/git/credentials`.

With nothing found, or a credential rejected, the command fails with Git's
`Authentication failed for '<url>'`; the first case adds a hint saying where
it looked. A commit without `-m` or `-F` uses `GIT_EDITOR`, `VISUAL` or
`EDITOR`.

## Remotes

Clone accepts HTTP(S), local paths and `file://` URLs. Network remotes are
HTTP(S) only: there is no SSH. The common shallow controls are supported
(`--depth`, fetch `--deepen`, `--shallow-since`, `--shallow-exclude`).
`fetch` follows Git 2.48 in creating `refs/remotes/<remote>/HEAD` when it is
missing, and honours `remote.<remote>.followRemoteHEAD` (`create`, `warn`,
`always`, `never`).

## Where the port goes beyond a thin wrapper

isomorphic-git's checkout, merge and abortMerge treat the index as the old
tree, which throws staged changes away, leaves a merge out of the worktree,
and rewrites clean index entries without their modes. The port implements
Git's semantics on top of the object-level APIs:

- A branch switch moves HEAD and writes only the paths the two commits
  differ in. Staged and unstaged changes are carried across, or refused with
  Git's messages when they would be overwritten; `-f` discards them.
- A merge lands its changes in the index and worktree and leaves unrelated
  local changes alone, with Git's pre-merge refusals (a dirty index, local
  changes to a touched path, an untracked file in the way). A conflicted
  merge keeps Git's `MERGE_HEAD`/`MERGE_MSG` state, labels the markers
  `HEAD` and the name as given, stages the other side's clean changes, and
  reports modify/delete conflicts. `commit` refuses over unmerged paths and
  otherwise makes the merge commit; `merge --abort` is `reset --merge`.
- `commit --amend` keeps the original author unless `--reset-author`,
  `--author` or `--date` says otherwise.
- `cherry-pick` is rebuilt on the same pieces: Git's refusals, the picked
  commit's author kept, `-n` staging without committing, and on a conflict
  Git's markers with `CHERRY_PICK_HEAD`, `--continue`, `--skip` and
  `--abort`. `status` does not yet announce a cherry-pick in progress.
- `status` and `ls-files -s` read conflict stages from the index file, which
  isomorphic-git keeps but does not expose.
- Notes commits get Git's messages (`Notes added by 'git notes add'`) in
  place of isomorphic-git's fixed one, so histories agree.
- The server's progress chatter during clone, fetch, pull and push is shown
  only on a terminal or with `--progress`, as Git does.
- `diff` is not isomorphic-git underneath: it writes the two sides into a
  scratch directory and has `bun pm diff --raw --json` produce the hunks,
  then prints them in Git's format (`index` lines, modes, hunk ranges,
  function context, exact renames). It needs a Bun that has `bun pm diff`,
  and says so otherwise. `diff --no-index` works without a repository for
  file/file and directory/directory comparisons.

## Known limits

- The stash command inherits isomorphic-git's narrower semantics: it stashes
  tracked files only, and apply/pop cannot abort on conflicts.
- No `rebase`, `blame`, `grep`, `revert`, `clean`, `bisect`, `worktree`,
  `submodule`, hooks, signatures or LFS.
- Only exact (100%) renames are paired; the combined diff of a merge commit
  is not produced.

The exact supported subsets and the work that is intentionally not a thin
wrapper are tracked in
[incomplete.md](https://github.com/jjtseng93/bunproot/blob/main/tools/isomorphic-git/incomplete.md).

## Colour and decorations

Output is coloured with Git's palette whether or not it goes to a pipe, and
`log` shows its decorations the same way; where Git decides by looking for a
terminal, this port needs to be told: `--no-color`, `-c color.ui=never` or
`NO_COLOR` for the colours, `--no-decorate` or `-c log.decorate=no` for the
decorations, and `-c color.ui=auto` / `-c log.decorate=auto` for Git's
terminal-sensing behaviour. `--porcelain` is never coloured.

## Platforms and testing

The `--git` path runs before bunproot's Android tracer and uses Bun/Node
filesystem and path APIs, so it is intended to run under Windows, macOS and
Linux as well as Android. Platform handling includes Windows file URLs, drive
boundaries, editors, file modes and symlinks. The current automated
comparison suite and Termux device runs do not replace native Windows and
macOS CI.

`test/isogit.test.js` runs the same command lines through this wrapper and
through a system Git in a scratch directory and requires the output, exit
statuses and resulting repositories to agree.

## Installation

To reduce npm supply-chain drift, the published `bun.lock` fixes
isomorphic-git 1.41.9 and all 55 packages in its production dependency tree.
That tree received a broad AI-assisted static review for install scripts,
native payloads, dynamic code execution, subprocesses, unexpected network
targets and known advisories before it was locked. This is not a formal audit
or a guarantee that the packages or repositories being cloned are safe: use
this feature at your own risk.

On first use bunproot explains that it will download isomorphic-git and its
locked dependencies from the npm registry, prints the complete command and
working directory that it will give `Bun.spawnSync`, and asks:

```text
Install now? (Y/n)
```

Only Enter, `y`, or `yes` starts the in-place installation. It uses
`bun install --frozen-lockfile --ignore-scripts --production`, so the lockfile
cannot be updated and dependency lifecycle scripts cannot run. Any other
answer cancels it. `bunproot --git --yes COMMAND` skips this question and
installs immediately. Later runs reuse the installed, version-checked copy
without asking again. bunproot verifies the installed package on disk rather
than trusting `bun install`'s exit status, which was unreliable before
[oven-sh/bun#39060](https://github.com/oven-sh/bun/issues/39060) was fixed.
