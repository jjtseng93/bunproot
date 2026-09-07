import { dlopen, FFIType, ptr } from "bun:ffi";
import dlpath, { LIBRARY_DIRECTORIES, libraryFile } from "./dlpath.js";

const definitions = {
  libc: {
    getpid: { args: [], returns: FFIType.i32 },
    access: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  },
};

const handles = new Map();

export function openLibrary(name, symbols = definitions[name]) {
  const path = dlpath[name];
  if (path === undefined) throw new Error(`Unknown shared library: ${name}`);
  // Not a dlopen failure: the file is not on this device at all. Say where it
  // was looked for, since the answer is an Android release, not a broken port.
  if (path === null) throw new Error(
    `${libraryFile(name)} not found in ${LIBRARY_DIRECTORIES.join(" or ")}`);
  if (!symbols) throw new Error(`No FFI symbol definition for: ${name}`);
  const cacheKey = `${name}:${Object.keys(symbols).join(",")}`;
  if (!handles.has(cacheKey)) handles.set(cacheKey, dlopen(path, symbols));
  return handles.get(cacheKey);
}

/**
 * The same library, opened at first use instead of at import time.
 *
 * A module that binds its symbols at the top level makes importing it depend
 * on Android's bionic being present, which is how `--version`, `--help` and
 * `--readme` came to fail on a host where dlopen cannot succeed -- before
 * `run()` was ever called, so the CLI could not even report the problem in its
 * own words. Symbol lookups still happen on first access, so a real tracer run
 * fails exactly where it used to.
 */
export function lazySymbols(name, symbols) {
  let loaded = null;
  return new Proxy(Object.create(null), {
    get(_, property) {
      // Only a named symbol loads the library: an inspector reaching for
      // Symbol.toStringTag must not trigger a dlopen the caller never asked
      // for.
      if (typeof property !== "string") return undefined;
      loaded ??= openLibrary(name, symbols).symbols;
      return loaded[property];
    },
  });
}

export function cString(value) {
  return new TextEncoder().encode(`${value}\0`);
}

export function libcAccess(path, mode = 0) {
  const bytes = cString(path);
  return openLibrary("libc").symbols.access(ptr(bytes), mode);
}

export function nativePid() {
  return openLibrary("libc").symbols.getpid();
}

export function probeNativePath(path) {
  try {
    return { available: true, pid: nativePid(), accessible: libcAccess(path, 0) === 0 };
  } catch (error) {
    return { available: false, error };
  }
}

export { dlpath };
