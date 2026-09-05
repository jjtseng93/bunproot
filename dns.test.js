import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "./cli/proot.c.js";
import { parseDnsMode, resolverBindings, RESOLVER_PATHS } from "./dns.js";
import { createBindings } from "./path/binding.c.js";

test("--dns takes three modes and three spellings of off", () => {
  expect(parseDnsMode("auto")).toBe("auto");
  expect(parseDnsMode("SIMPLE")).toBe("simple");
  for (const spelling of ["off", "no", "false"]) expect(parseDnsMode(spelling)).toBe("off");
  expect(() => parseDnsMode("maybe")).toThrow();
});

test("auto binds only what the rootfs lacks, simple binds both, off binds nothing", () => {
  const base = mkdtempSync(join(tmpdir(), "dns-"));
  const resolver = join(base, "resolv.conf");
  writeFileSync(resolver, "nameserver 1.1.1.1\n");
  const rootfs = join(base, "rootfs");
  mkdirSync(join(rootfs, "etc"), { recursive: true });
  mkdirSync(join(rootfs, "tmp"), { recursive: true });
  try {
    // Nothing in the rootfs yet: auto supplies both.
    expect(resolverBindings(rootfs, "auto", resolver)).toEqual(
      RESOLVER_PATHS.map((path) => `${resolver}:${path}`));

    // The rootfs carries /etc/resolv.conf, so auto leaves that one alone.
    writeFileSync(join(rootfs, "etc/resolv.conf"), "nameserver 9.9.9.9\n");
    expect(resolverBindings(rootfs, "auto", resolver)).toEqual([`${resolver}:/tmp/resolv.conf`]);
    expect(resolverBindings(rootfs, "simple", resolver)).toEqual(
      RESOLVER_PATHS.map((path) => `${resolver}:${path}`));
    expect(resolverBindings(rootfs, "off", resolver)).toEqual([]);

    // A resolver this installation does not have is not an error.
    expect(resolverBindings(rootfs, "simple", join(base, "absent"))).toEqual([]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("--dns expands where it is written and the last binding wins", () => {
  // The implicit default sits ahead of everything the caller wrote.
  expect(parseArguments(["-S", "/rootfs", "/bin/sh"]).bindings).toEqual([{ dns: "auto" }]);
  // An explicit one replaces the default and keeps its position.
  expect(parseArguments(["-S", "/rootfs", "-b", "/a", "--dns=off", "-b", "/b", "/bin/sh"]).bindings)
    .toEqual(["/a", { dns: "off" }, "/b"]);
  expect(parseArguments(["--dns", "simple", "-S", "/rootfs", "/bin/sh"]).bindings)
    .toEqual([{ dns: "simple" }]);
  expect(() => parseArguments(["-S", "/rootfs", "--dns"])).toThrow();
});

test("a later binding replaces an earlier one on the same guest path", () => {
  const base = mkdtempSync(join(tmpdir(), "dns2-"));
  const first = join(base, "first");
  const second = join(base, "second");
  mkdirSync(first); mkdirSync(second);
  try {
    // Upstream keeps the last (src/path/binding.c:insort_binding).
    const mounts = createBindings(base, [`${first}:/x`, `${second}:/x`]);
    expect(mounts.toHost("/x")).toBe(second);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
