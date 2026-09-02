import { expect, test } from "bun:test";
import { readElfInterpreter } from "./elf.c.js";

test("reads PT_INTERP from an ELF executable", () => {
  const interpreter = readElfInterpreter("/system/bin/sh");
  expect(interpreter).toStartWith("/system/bin/linker");
});
