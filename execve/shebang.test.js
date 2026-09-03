import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBindings } from "../path/binding.c.js";
import { expandShebang, makeGuestPaths, readShebang } from "./shebang.c.js";

function rootfs(files) {
  const root = mkdtempSync(join(tmpdir(), "prbun-shebang-"));
  for (const [path, { content, mode }] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
    if (mode !== undefined) chmodSync(absolute, mode);
  }
  return root;
}

const SCRIPT = "#!/usr/bin/env node\nconsole.log(1)\n";
const PATH = "/usr/local/bin:/usr/bin:/bin";

test("reads the interpreter and its single argument", () => {
  const root = rootfs({ "s.sh": { content: SCRIPT } });
  expect(readShebang(join(root, "s.sh"))).toEqual({ interpreter: "/usr/bin/env", argument: "node" });
  rmSync(root, { recursive: true, force: true });
});

test("a missing env is replaced by the tracer's own PATH search", () => {
  const root = rootfs({
    "s.sh": { content: SCRIPT },
    "usr/bin/node": { content: "\x7fELF", mode: 0o755 },
  });
  const mounts = createBindings(root);
  const script = expandShebang(join(root, "s.sh"), "/s.sh", ["/s.sh", "x"],
    makeGuestPaths(mounts, PATH));

  expect(script.guestPath).toBe("/usr/bin/node");
  // env(1) execs under the name it was given, so argv[0] is `node`, not the
  // pathname it resolved to.
  expect(script.argv).toEqual(["node", "/s.sh", "x"]);
  rmSync(root, { recursive: true, force: true });
});

test("a real env keeps its job", () => {
  const root = rootfs({
    "s.sh": { content: SCRIPT },
    "usr/bin/env": { content: "\x7fELF", mode: 0o755 },
    "usr/bin/node": { content: "\x7fELF", mode: 0o755 },
  });
  const script = expandShebang(join(root, "s.sh"), "/s.sh", ["/s.sh"],
    makeGuestPaths(createBindings(root), PATH));
  expect(script.guestPath).toBe("/usr/bin/env");
  expect(script.argv).toEqual(["/usr/bin/env", "node", "/s.sh"]);
  rmSync(root, { recursive: true, force: true });
});

test("only the bare `env NAME` shape is taken over", () => {
  const cases = {
    "opt.sh": "#!/usr/bin/env -S node --flag\n",   // env has work of its own
    "path.sh": "#!/usr/bin/env /usr/bin/node\n",   // already a pathname
    "bare.sh": "#!/usr/bin/env\n",                 // nothing to search for
  };
  const root = rootfs({
    ...Object.fromEntries(Object.entries(cases).map(([n, c]) => [n, { content: c }])),
    "usr/bin/node": { content: "\x7fELF", mode: 0o755 },
  });
  const guest = makeGuestPaths(createBindings(root), PATH);
  for (const name of Object.keys(cases))
    expect(expandShebang(join(root, name), `/${name}`, [`/${name}`], guest).guestPath)
      .toBe("/usr/bin/env");
  rmSync(root, { recursive: true, force: true });
});

test("the search needs an executable file, and reports nothing when there is none", () => {
  const root = rootfs({
    "s.sh": { content: SCRIPT },
    "usr/bin/node": { content: "not executable", mode: 0o644 },
    "bin/node": { content: "\x7fELF", mode: 0o755 },
  });
  const guest = makeGuestPaths(createBindings(root), PATH);
  // /usr/bin/node is not executable, so the search moves on to /bin.
  expect(guest.which("node")).toBe("/bin/node");
  expect(guest.which("nothing-here")).toBeNull();

  // With no interpreter on PATH at all, env stays as written and the guest
  // gets the same ENOENT it would have got anyway.
  const bare = rootfs({ "s.sh": { content: SCRIPT } });
  expect(expandShebang(join(bare, "s.sh"), "/s.sh", ["/s.sh"],
    makeGuestPaths(createBindings(bare), PATH)).guestPath).toBe("/usr/bin/env");

  rmSync(root, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

test("the search follows bindings, not the tracer's own filesystem", () => {
  const root = rootfs({ "s.sh": { content: SCRIPT } });
  const elsewhere = rootfs({ "node": { content: "\x7fELF", mode: 0o755 } });
  const mounts = createBindings(root, [`${elsewhere}:/opt/tools`]);
  const script = expandShebang(join(root, "s.sh"), "/s.sh", ["/s.sh"],
    makeGuestPaths(mounts, `/opt/tools:${PATH}`));
  expect(script.guestPath).toBe("/opt/tools/node");
  rmSync(root, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});
