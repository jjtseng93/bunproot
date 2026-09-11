import { expect, test } from "bun:test";
import { applyGuestEnvironment } from "./env.js";
import { parseArguments } from "./cli/proot.c.js";

test("-e and -u collect repeatable environment operations in command-line order", () => {
  const parsed=parseArguments([
    "-e","ONE=1","--env=TWO=two=parts","--env","COPIED",
    "-u","ONE","--unset-env=TWO","-S","/rootfs","/bin/sh",
  ]);
  expect(parsed.environmentActions).toEqual([
    { name:"ONE", value:"1" },
    { name:"TWO", value:"two=parts" },
    { name:"COPIED", inherit:true },
    { name:"ONE", unset:true },
    { name:"TWO", unset:true },
  ]);
  expect(parsed.command).toEqual(["/bin/sh"]);
});

test("environment actions set, inherit and unset with the last operation winning", () => {
  expect(applyGuestEnvironment(["KEEP=old","DROP=yes"],[
    { name:"KEEP", value:"new" },
    { name:"COPIED", inherit:true },
    { name:"MISSING", inherit:true },
    { name:"DROP", unset:true },
    { name:"AGAIN", unset:true },
    { name:"AGAIN", value:"last" },
  ],{ COPIED:"from-host" })).toEqual([
    "KEEP=new", "COPIED=from-host", "AGAIN=last",
  ]);
});

test("environment options reject missing or invalid names", () => {
  expect(()=>parseArguments(["-e"])).toThrow();
  expect(()=>parseArguments(["--env="])).toThrow();
  expect(()=>parseArguments(["-u","BAD=NAME","-S","/rootfs"])).toThrow();
  expect(()=>parseArguments(["--unset-env=", "-S","/rootfs"])).toThrow();
});
