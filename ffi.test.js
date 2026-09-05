import { expect, test } from "bun:test";
import dlpath, { LIBRARY_DIRECTORIES, resolveLibrary, libraryFile } from "./dlpath.js";
import { existsSync } from "node:fs";

test("bionic is found wherever this Android release keeps it", () => {
  // The APEX first, /system/lib64 second: on Android 10 and later the second
  // is a symlink into the first, and before that it was the real location.
  expect(LIBRARY_DIRECTORIES[0]).toBe("/apex/com.android.runtime/lib64/bionic");
  expect(LIBRARY_DIRECTORIES).toContain("/system/lib64");

  for (const name of ["libc", "libdl", "libm"]) {
    expect(dlpath[name]).not.toBeUndefined();
    // A device matching neither location resolves to null rather than to a
    // path that only fails later, inside dlopen.
    if (dlpath[name] !== null) expect(existsSync(dlpath[name])).toBe(true);
  }
});

test("a library present in no searched directory resolves to null", () => {
  expect(resolveLibrary("libdefinitely-not-bionic.so")).toBeNull();
  expect(libraryFile("libc")).toBe("libc.so");
});
