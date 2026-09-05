/** ESM port of src/path/binding.c.
 *
 * A binding makes a host directory or file visible at a guest pathname. The
 * rootfs itself is just the binding at "/", so guest-to-host translation is one
 * lookup rather than a special case plus exceptions.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ignoreMissingBindings, verbose } from "../env.js";

// "/proc/self/..." stays literal: "self" is resolved by the kernel at syscall
// time against the calling tracee, so resolving it here would pin the binding
// to the tracer's own pid (src/path/binding.c:new_binding).
function resolveHost(path) {
  if (path === "/proc/self" || path.startsWith("/proc/self/")) return path;
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * `-b host` binds a host path at the same pathname inside the guest;
 * `-b host:guest` binds it at another one. As upstream, the *first* colon
 * separates the two halves, and either half may be relative: both are resolved
 * against the caller's working directory before the bootstrap moves into the
 * rootfs, so `-b .` and `-b ./sdk:/opt/sdk` mean what they look like
 * (src/cli/proot.c:handle_option_b, src/path/binding.c:new_binding).
 */
export function parseBinding(specification) {
  const separator = specification.indexOf(":");
  const host = separator < 0 ? specification : specification.slice(0, separator);
  const guest = separator < 0 ? specification : specification.slice(separator + 1);
  if (!host) throw new Error(`empty host path in binding: ${specification}`);
  return { host: resolveHost(host), guest: resolve(guest) };
}

const withinHost = (path, prefix) =>
  prefix === "/" ? path.startsWith("/") : path === prefix || path.startsWith(`${prefix}/`);

/**
 * The mount table for one guest. Both directions resolve the most specific
 * binding first, so `-b /opt/sdk:/usr/lib/sdk` wins over the rootfs at "/" for
 * everything below it and nothing above it.
 */
export function createBindings(rootfs, specifications = []) {
  // Upstream drops a binding whose host cannot be sanitized rather than
  // presenting the guest with an empty mount point, and PROOT_IGNORE_MISSING_
  // BINDINGS only silences the warning that goes with it.
  const requested = specifications.map(parseBinding).filter((binding) => {
    if (existsSync(binding.host)) return true;
    if (!ignoreMissingBindings)
      console.error(`bunproot: can't sanitize binding "${binding.host}": no such file or directory`);
    return false;
  });
  const root = { host: resolveHost(rootfs), guest: "/" };
  // Two bindings on the same guest pathname: the last one is the active one,
  // and upstream says so before dropping the other
  // (src/path/binding.c:insort_binding, case PATHS_ARE_EQUAL).
  const active = new Map();
  for (const entry of [root, ...requested]) {
    const replaced = active.get(entry.guest);
    if (replaced && verbose && !ignoreMissingBindings)
      console.error(`bunproot: both "${replaced.host}" and "${entry.host}" are bound to `+
        `"${entry.guest}", only the last binding is active`);
    active.set(entry.guest, entry);
  }
  const entries = [...active.values()];
  const byGuest = [...entries].sort((a, b) => b.guest.length - a.guest.length);
  const byHost = [...entries].sort((a, b) => b.host.length - a.host.length);

  return {
    rootfs: root.host,
    entries,

    /** Where a guest pathname lives on the host. Always answers: the rootfs
     *  binding covers everything the more specific ones do not. */
    toHost(guestPath) {
      for (const entry of byGuest) {
        if (guestPath === entry.guest) return entry.host;
        const prefix = entry.guest === "/" ? "/" : `${entry.guest}/`;
        if (guestPath.startsWith(prefix))
          return `${entry.host}${guestPath.slice(entry.guest === "/" ? 0 : entry.guest.length)}`;
      }
      return guestPath;
    },

    /** What the guest calls a host pathname, or null when the host pathname is
     *  outside every binding and so has no name the guest could use. */
    toGuest(hostPath) {
      for (const entry of byHost) {
        if (!withinHost(hostPath, entry.host)) continue;
        if (hostPath === entry.host) return entry.guest;
        const remainder = hostPath.slice(entry.host === "/" ? 0 : entry.host.length);
        return entry.guest === "/" ? remainder : `${entry.guest}${remainder}`;
      }
      return null;
    },
  };
}
