#!/data/data/com.termux/files/usr/bin/bash
# Run a disposable native-Android test case while preserving output for Claude.
# Usage: test/claude/run.sh <name>

set -u

case "${1-}" in
  ""|*[!A-Za-z0-9._-]*)
    echo "usage: test/claude/run.sh <name>" >&2
    exit 2
    ;;
esac

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NAME=$1
CASE="$HERE/cases/$NAME.sh"
OUTPUT="$HERE/output"

if [ ! -f "$CASE" ]; then
  echo "test case not found: $CASE" >&2
  exit 2
fi

mkdir -p "$OUTPUT"
set +e
bash "$CASE" 2>&1 | tee "$OUTPUT/$NAME.log"
STATUS=${PIPESTATUS[0]}
set -e
printf '%s\n' "$STATUS" > "$OUTPUT/$NAME.status"
printf 'EXIT_STATUS=%s\n' "$STATUS"
exit "$STATUS"
