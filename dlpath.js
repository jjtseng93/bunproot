// Where bionic lives is an Android-release question, not a kernel one. Android
// 10 (API 29) moved libc, libdl and libm into the Runtime APEX; before that
// they were in /system/lib64. Modern releases keep /system/lib64/libc.so as a
// symlink into the APEX, so one search order answers for both and nothing has
// to ask the platform its version.
//
// This is the only place that knows those paths. A device that matches neither
// resolves to null rather than a path that will fail later inside dlopen, so
// ffi.js can say what it looked for.
import { existsSync } from "node:fs";

export const LIBRARY_DIRECTORIES = [
  "/apex/com.android.runtime/lib64/bionic",
  "/system/lib64",
];

const FILES = { libc: "libc.so", libdl: "libdl.so", libm: "libm.so" };

export function resolveLibrary(file) {
  for (const directory of LIBRARY_DIRECTORIES) {
    const path = `${directory}/${file}`;
    if (existsSync(path)) return path;
  }
  return null;
}

// Resolved once at import. Three libraries, so at most six stat calls, and
// every consumer still sees the plain name-to-path object the JSON was.
const dlpath = Object.fromEntries(
  Object.entries(FILES).map(([name, file]) => [name, resolveLibrary(file)]));

export const libraryFile = (name) => FILES[name];
export default dlpath;
