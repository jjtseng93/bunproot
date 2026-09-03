import { lstatSync, readlinkSync } from "node:fs";
import { posix } from "node:path";

/** Resolve guest symlinks without ever allowing a target to escape the guest
 *  namespace. Components are inspected through the mount table, so a symlink
 *  inside a binding is followed where that binding actually lives. */
export function canonicalizeGuestPath(mounts,path,{derefFinal=true,preserveInternalFinal=false,maxSymlinks=40}={}) {
  let pending=posix.normalize(path).split("/").filter(Boolean), resolved=[], followed=0;
  while (pending.length) {
    const component=pending.shift();
    if (component===".") continue;
    if (component==="..") { resolved.pop(); continue; }
    const candidate=`/${[...resolved,component].join("/")}`;
    const isFinal=pending.length===0;
    let stat;
    try { stat=lstatSync(mounts.toHost(candidate)); }
    catch (error) {
      // The tracee syscall must receive filesystem errors itself; inability to
      // inspect a component only means canonicalization stops at this point.
      return posix.normalize(`/${[...resolved,component,...pending].join("/")}`);
    }
    if (!stat.isSymbolicLink()) { resolved.push(component); continue; }
    const target=readlinkSync(mounts.toHost(candidate));
    // Like upstream link2symlink's TRANSLATED_PATH callback, the storage
    // symlink is an implementation detail and must look like a regular file
    // even to lstat/O_NOFOLLOW callers. Ordinary final symlinks still honor
    // the caller's no-follow semantics.
    const internalLink=target.startsWith("/.proot.l2s/refs/") ||
      target.startsWith("/.proot.l2s/objs/");
    // A caller that must report a guest-visible name (execve argv, /proc) asks
    // to stop at the storage symlink even while ordinary symlinks are followed.
    if (isFinal&&(internalLink?preserveInternalFinal:!derefFinal)) { resolved.push(component); continue; }
    if (++followed>maxSymlinks) throw Object.assign(new Error(`too many symbolic links: ${path}`),{code:"ELOOP"});
    const targetPath=target.startsWith("/")?target:posix.resolve(`/${resolved.join("/")}`,target);
    pending=[...posix.normalize(targetPath).split("/").filter(Boolean),...pending];
    resolved=[];
  }
  return `/${resolved.join("/")}`;
}
