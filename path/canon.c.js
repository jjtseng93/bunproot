import { lstatSync, readlinkSync } from "node:fs";
import { posix } from "node:path";

/** Resolve guest symlinks without ever allowing a target to escape rootfs. */
export function canonicalizeGuestPath(rootfs,path,{derefFinal=true,maxSymlinks=40}={}) {
  let pending=posix.normalize(path).split("/").filter(Boolean), resolved=[], followed=0;
  while (pending.length) {
    const component=pending.shift();
    if (component===".") continue;
    if (component==="..") { resolved.pop(); continue; }
    const candidate=`/${[...resolved,component].join("/")}`;
    const isFinal=pending.length===0;
    if (isFinal&&!derefFinal) { resolved.push(component); continue; }
    let stat;
    try { stat=lstatSync(`${rootfs}${candidate}`); }
    catch (error) {
      // The tracee syscall must receive filesystem errors itself; inability to
      // inspect a component only means canonicalization stops at this point.
      return posix.normalize(`/${[...resolved,component,...pending].join("/")}`);
    }
    if (!stat.isSymbolicLink()) { resolved.push(component); continue; }
    if (++followed>maxSymlinks) throw Object.assign(new Error(`too many symbolic links: ${path}`),{code:"ELOOP"});
    const target=readlinkSync(`${rootfs}${candidate}`);
    const targetPath=target.startsWith("/")?target:posix.resolve(`/${resolved.join("/")}`,target);
    pending=[...posix.normalize(targetPath).split("/").filter(Boolean),...pending];
    resolved=[];
  }
  return `/${resolved.join("/")}`;
}
