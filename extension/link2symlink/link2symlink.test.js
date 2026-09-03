import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeGuestPath } from "../../path/canon.c.js";
import { createBindings } from "../../path/binding.c.js";
import { commitEmulatedDirectoryRename, commitEmulatedRename, commitEmulatedUnlink, emulateHardLink, inspectEmulatedAlias } from "./link2symlink.c.js";

const roots=[];
afterEach(()=>{ for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const hostPath=(root,guest)=>`${root}${guest}`;
function resolvedHost(root,guest) { return hostPath(root,canonicalizeGuestPath(createBindings(root),guest)); }

describe("relocatable link2symlink format",()=>{
  test("content remains shared after the rootfs moves",()=>{
    const parent=mkdtempSync(join(tmpdir(),"proot-l2s-")); roots.push(parent);
    const original=join(parent,"old-root"), moved=join(parent,"new-root");
    mkdirSync(`${original}/usr/bin`,{recursive:true}); mkdirSync(`${original}/bin`,{recursive:true});
    writeFileSync(`${original}/usr/bin/tool`,"before\n");

    expect(emulateHardLink(original,`${original}/usr/bin/tool`,`${original}/bin/tool`,
      "/usr/bin/tool","/bin/tool")).toBe(true);
    expect(inspectEmulatedAlias(original,`${original}/usr/bin/tool`)?.nlink).toBe(2n);
    expect(readlinkSync(`${original}/usr/bin/tool`)).toBe("/.proot.l2s/refs/usr/bin/tool");
    expect(readlinkSync(`${original}/.proot.l2s/mets/${inspectEmulatedAlias(original,`${original}/usr/bin/tool`).id}`))
      .toBe("n0000000000000002");

    renameSync(original,moved);
    writeFileSync(resolvedHost(moved,"/bin/tool"),"after\n");
    expect(readFileSync(resolvedHost(moved,"/usr/bin/tool"),"utf8")).toBe("after\n");

    const third=`${moved}/sbin/tool`; mkdirSync(`${moved}/sbin`,{recursive:true});
    expect(emulateHardLink(moved,`${moved}/bin/tool`,third,"/bin/tool","/sbin/tool")).toBe(true);
    expect(inspectEmulatedAlias(moved,third)?.nlink).toBe(3n);
    const removed=inspectEmulatedAlias(moved,third);
    unlinkSync(third); commitEmulatedUnlink(moved,removed);
    expect(inspectEmulatedAlias(moved,`${moved}/bin/tool`)?.nlink).toBe(2n);

    const oldAlias=`${moved}/bin/tool`, newAlias=`${moved}/bin/renamed`;
    const renamed=inspectEmulatedAlias(moved,oldAlias);
    renameSync(oldAlias,newAlias);
    commitEmulatedRename(moved,renamed,newAlias,"/bin/renamed");
    expect(readlinkSync(newAlias)).toBe("/.proot.l2s/refs/bin/renamed");
    writeFileSync(resolvedHost(moved,"/bin/renamed"),"renamed\n");
    expect(readFileSync(resolvedHost(moved,"/usr/bin/tool"),"utf8")).toBe("renamed\n");

    renameSync(`${moved}/usr`,`${moved}/opt`);
    commitEmulatedDirectoryRename(moved,"/usr","/opt");
    expect(readlinkSync(`${moved}/opt/bin/tool`)).toBe("/.proot.l2s/refs/opt/bin/tool");
    expect(readFileSync(resolvedHost(moved,"/opt/bin/tool"),"utf8")).toBe("renamed\n");
  });
});
