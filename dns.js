/** Giving a guest a resolver it does not carry.
 *
 * Not an upstream PRoot feature. A rootfs from a distribution tarball has no
 * /etc/resolv.conf at all -- Alpine's minirootfs does not ship one -- so the
 * first thing anyone does is write one by hand before anything can resolve a
 * name. This binds one in instead, which also keeps a read-only or throwaway
 * rootfs usable without editing it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Both places a guest may look. /etc is the real one; /tmp is where a guest
 *  with no writable /etc is left writing its own, so an override there is
 *  worth having as well. Binding a file needs no file at the guest end: the
 *  mount table answers for the pathname whether or not the rootfs has it. */
export const RESOLVER_PATHS = ["/etc/resolv.conf", "/tmp/resolv.conf"];

/** The resolver this package ships, beside the entry point. */
export const bundledResolver = () => join(import.meta.dir, "resolv.conf");

/**
 * `--dns=`:
 *   auto    (default) bind the bundled resolver only where the rootfs has none
 *   simple  bind it everywhere, overriding whatever the rootfs carries
 *   off     never bind: the rootfs answers for itself, with or without one.
 *           "no" and "false" say the same thing
 */
export function parseDnsMode(value) {
  const mode = String(value).trim().toLowerCase();
  if (mode === "off" || mode === "no" || mode === "false") return "off";
  if (mode === "auto" || mode === "simple") return mode;
  throw new Error(`--dns takes auto, simple or off, not "${value}"`);
}

/** The bindings `--dns` asks for, as `-b` specifications. */
export function resolverBindings(rootfs, mode, resolver = bundledResolver()) {
  if (mode === "off") return [];
  // Nothing to bind rather than a missing-binding warning: an installation
  // without the file is not a broken invocation.
  if (!existsSync(resolver)) return [];
  return RESOLVER_PATHS
    .filter((path) => mode === "simple" || !existsSync(join(rootfs, path)))
    .map((path) => `${resolver}:${path}`);
}
