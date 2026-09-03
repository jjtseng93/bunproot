import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArguments } from "../cli/proot.c.js";
import { createBindings, parseBinding } from "./binding.c.js";
import { translatePath } from "./path.c.js";

test("legacy argument translation and -S parsing remain deterministic", () => {
  expect(translatePath("/")).toBe("/etc");
  expect(translatePath("/tmp")).toBe("/tmp");
  expect(parseArguments(["-S", "/rootfs/", "/bin/ls", "/"])).toEqual({
    rootfs: "/rootfs", bindings: [], command: ["/bin/ls", "/"],
  });
  expect(parseArguments(["-S", "../alpine", "/bin/sh"])).toEqual({
    rootfs: resolve("../alpine"), bindings: [], command: ["/bin/sh"],
  });
});

test("bindings are collected in order and never eat the command", () => {
  expect(parseArguments(["-b", "/data", "-S", "/rootfs", "/bin/sh"])).toEqual({
    rootfs: "/rootfs", bindings: ["/data"], command: ["/bin/sh"],
  });
  expect(parseArguments(["-S", "/rootfs", "-b", "/a:/x", "--bind=/b:/y", "/bin/sh", "-c", "-b"])).toEqual({
    rootfs: "/rootfs", bindings: ["/a:/x", "/b:/y"], command: ["/bin/sh", "-c", "-b"],
  });
  expect(() => parseArguments(["-S", "/rootfs"])).toThrow();
  expect(() => parseArguments(["-b", "/data", "/bin/sh"])).toThrow();
  expect(() => parseArguments(["-S", "/rootfs", "-b"])).toThrow();
});

test("a bare binding keeps its pathname, a pair maps one to the other", () => {
  expect(parseBinding("/data/sdk")).toEqual({ host: "/data/sdk", guest: "/data/sdk" });
  expect(parseBinding("/data/sdk:/opt/sdk/")).toEqual({ host: "/data/sdk", guest: "/opt/sdk" });
  // The first colon separates, so a later one belongs to the guest pathname.
  expect(parseBinding("/data:/opt/a:b")).toEqual({ host: "/data", guest: "/opt/a:b" });
  // Either half may be relative to the caller's working directory.
  expect(parseBinding("./sdk:/opt/sdk")).toEqual({ host: resolve("./sdk"), guest: "/opt/sdk" });
  expect(parseBinding("/data/sdk:sub")).toEqual({ host: "/data/sdk", guest: resolve("sub") });
  expect(parseBinding(".")).toEqual({ host: resolve("."), guest: resolve(".") });
  expect(() => parseBinding(":/opt")).toThrow();
});

test("a binding whose host is missing is dropped, not presented empty", () => {
  const mounts = createBindings("/rootfs", ["/definitely/not/here:/mnt"]);
  expect(mounts.entries).toHaveLength(1);
  expect(mounts.toHost("/mnt/x")).toBe("/rootfs/mnt/x");
});

test("the most specific binding wins in both directions", () => {
  // Real directories: createBindings drops a binding whose host is missing.
  const base = mkdtempSync(join(tmpdir(), "prbun-binding-"));
  const root = join(base, "rootfs"), sdk = join(base, "sdk"), scratch = join(base, "scratch");
  for (const directory of [root, sdk, scratch]) mkdirSync(directory);
  const mounts = createBindings(root, [`${sdk}:/usr/lib/sdk`, `${scratch}:/tmp`]);

  expect(mounts.toHost("/")).toBe(root);
  expect(mounts.toHost("/etc/passwd")).toBe(`${root}/etc/passwd`);
  expect(mounts.toHost("/usr/lib/sdk")).toBe(sdk);
  expect(mounts.toHost("/usr/lib/sdk/bin/cc")).toBe(`${sdk}/bin/cc`);
  // A sibling that merely shares a prefix belongs to the rootfs, not the binding.
  expect(mounts.toHost("/usr/lib/sdkother")).toBe(`${root}/usr/lib/sdkother`);
  expect(mounts.toHost("/tmp/x")).toBe(`${scratch}/x`);

  expect(mounts.toGuest(root)).toBe("/");
  expect(mounts.toGuest(`${root}/etc/passwd`)).toBe("/etc/passwd");
  expect(mounts.toGuest(`${sdk}/bin/cc`)).toBe("/usr/lib/sdk/bin/cc");
  expect(mounts.toGuest(scratch)).toBe("/tmp");
  expect(mounts.toGuest("/somewhere/else")).toBeNull();

  rmSync(base, { recursive: true, force: true });
});
