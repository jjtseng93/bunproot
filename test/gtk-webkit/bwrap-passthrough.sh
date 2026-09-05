#!/bin/sh
# UNSANDBOXED bubblewrap stand-in for glycin/WebKit on Android.
#
# This is only for the manual GTK/WebKit integration test beside this file.
# Installing it as /usr/bin/bwrap removes the sandbox from every bwrap caller
# in the guest, including WebKit web processes.

while [ "$#" -gt 0 ]; do
  case "$1" in
    --unshare-*|--share-net|--die-with-parent|--clearenv|--new-session|--as-pid-1)
      shift
      ;;
    --chdir|--seccomp|--tmpfs|--dev|--proc|--dir|--json-status-fd|--info-fd|--sync-fd|--args|--userns|--uid|--gid|--dbus-fd)
      shift 2
      ;;
    --ro-bind|--bind|--ro-bind-try|--bind-try|--dev-bind|--dev-bind-try|--symlink|--setenv|--file|--bind-data|--ro-bind-data)
      shift 3
      ;;
    --)
      shift
      break
      ;;
    --*)
      echo "bwrap-passthrough: unsupported option: $1" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -eq 0 ]; then
  echo "bwrap-passthrough: missing payload command" >&2
  exit 2
fi

# Do not use exec here. Under bunproot, keeping this wrapper as the loader's
# parent is necessary: after exec, glycin-image-rs becomes an orphaned zombie
# and GLib waits forever for the D-Bus decode reply.
"$@"
exit $?
