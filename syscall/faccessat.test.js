import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faccessat2Result } from "../ptrace/ptrace.c.js";

const root=mkdtempSync(join(tmpdir(),"bunproot-faccessat2-"));
const file=join(root,"file"), dangling=join(root,"dangling");
writeFileSync(file,"ok");
symlinkSync("missing",dangling);
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const signed=(result)=>BigInt.asIntN(64,result);

test("faccessat2 follows symlinks unless AT_SYMLINK_NOFOLLOW is set",()=>{
  expect(signed(faccessat2Result(dangling,0,0))).toBe(-2n);
  expect(signed(faccessat2Result(dangling,0,0x100))).toBe(0n);
  expect(signed(faccessat2Result(dangling,7,0x100))).toBe(0n);
  expect(signed(faccessat2Result(file,4,0x100))).toBe(0n);
});

test("faccessat2 rejects invalid mode and flag bits",()=>{
  expect(signed(faccessat2Result(file,8,0))).toBe(-22n);
  expect(signed(faccessat2Result(file,0,0x400))).toBe(-22n);
  expect(signed(faccessat2Result(file,0,0x100|0x200|0x1000))).toBe(0n);
});
