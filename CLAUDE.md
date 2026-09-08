# Claude-specific instructions

Read and follow `AGENTS.md` first. It contains the shared project overview,
upstream location, and the rules for running bunproot tests in a native Android
session. This file only adds the workflow needed by Claude; do not treat it as
a replacement for `AGENTS.md`.

## Native-session output

Claude cannot reliably inspect the live jsgotty terminal after sending input.
Keep the native session alive with `tmux`, and write test output to a file that
can be read afterwards.

The repository-local harness is:

```sh
test/claude/run.sh <name>
```

It runs `test/claude/cases/<name>.sh` and uses `tee` so the output is visible
in the terminal and saved as `test/claude/output/<name>.log`; the numeric exit
status is also saved as `<name>.status`. Both directories are ignored by Git.
Put multi-step or quoting-sensitive native tests in a case script instead of
typing a long compound command directly into jsgotty.

The harness scripts are disposable debugging aids, not project tests. Do not
add their `tee` requirement to `TESTING.md`; other agents can read jsgotty
output directly and do not need it.
