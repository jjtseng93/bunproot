import { expect, test } from "bun:test";
import { prepareCommand } from "../cli/proot.c.js";
import { translatePath } from "./path.c.js";

test("the first version maps only the exact root argument", () => {
  expect(translatePath("/")).toBe("/etc");
  expect(translatePath("/tmp")).toBe("/tmp");
  expect(prepareCommand(["ls", "/"])).toEqual(["ls", "/etc"]);
});
