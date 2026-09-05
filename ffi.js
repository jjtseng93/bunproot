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
