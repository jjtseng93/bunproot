import { expect, test } from "bun:test";
import { parseArguments } from "../cli/proot.c.js";
import { translatePath } from "./path.c.js";

test("legacy argument translation and -S parsing remain deterministic", () => {
  expect(translatePath("/")).toBe("/etc");
  expect(translatePath("/tmp")).toBe("/tmp");
  expect(parseArguments(["-S", "/rootfs/", "/bin/ls", "/"])).toEqual({
    rootfs: "/rootfs", command: ["/bin/ls", "/"],
  });
});
