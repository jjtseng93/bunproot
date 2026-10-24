import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArguments } from "./proot.c.js";

const root=resolve(import.meta.dir,"..");
for (const entry of ["proot.js","index.js"]) {
  test(`${entry} --print-path emits only the entry point without starting a guest`,()=>{
    const result=Bun.spawnSync([process.execPath,resolve(root,entry),"--print-path"],{
      cwd:"/", env:{...process.env,BUN_FEATURE_FLAG_NO_ORPHANS:""},
      stdout:"pipe",stderr:"pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe(realpathSync(resolve(root,"proot.js"))+"\n");
  });
}
test("print-path is an option only before the guest command",()=>{
  expect(parseArguments(["--print-path"])).toEqual({printPath:true});
  expect(parseArguments(["-S","/rootfs","/bin/echo","--print-path"]).command)
    .toEqual(["/bin/echo","--print-path"]);
});
