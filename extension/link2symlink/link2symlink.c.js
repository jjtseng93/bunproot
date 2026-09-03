import { mkdirSync, lstatSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, posix } from "node:path";

export const sourceModule = "src/extension/link2symlink/link2symlink.c";
export const portStatus = "partial";
const STORE="/.proot.l2s", REFS=`${STORE}/refs`, OBJS=`${STORE}/objs`, METS=`${STORE}/mets`;
const OBJECT_RE=new RegExp(`^${OBJS}/([0-9a-f]{32})$`), COUNT_RE=/^n([0-9a-f]{16})$/;
const host=(rootfs,path)=>`${rootfs}${path}`;
const makeId=()=>randomBytes(16).toString("hex");
const ensureParent=(path)=>mkdirSync(dirname(path),{recursive:true});
function replaceSymlink(path,target) {
  ensureParent(path);
  const temporary=`${dirname(path)}/.tmp.${makeId()}`;
  symlinkSync(target,temporary);
  try { renameSync(temporary,path); }
  catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}
function refGuestPath(guestPath) {
  const normalized=posix.normalize(guestPath);
  if (!normalized.startsWith("/") || normalized===STORE || normalized.startsWith(`${STORE}/`))
    throw Object.assign(new Error(`invalid link2symlink guest path: ${guestPath}`),{code:"EINVAL"});
  return `${REFS}${normalized}`;
}
function inspectAlias(rootfs,aliasHost) {
  let target;
  try { if (!lstatSync(aliasHost).isSymbolicLink()) return null; target=readlinkSync(aliasHost); }
  catch { return null; }
  if (!target.startsWith(`${REFS}/`)) return null;
  let object;
  try { object=readlinkSync(host(rootfs,target)); } catch { return null; }
  const match=OBJECT_RE.exec(object);
  return match?{id:match[1],objectGuest:object,refGuest:target}:null;
}
function readCount(rootfs,id) {
  const match=COUNT_RE.exec(readlinkSync(host(rootfs,`${METS}/${id}`)));
  if (!match) throw Object.assign(new Error(`invalid link2symlink count for ${id}`),{code:"EIO"});
  const count=BigInt(`0x${match[1]}`);
  if (count===0n) throw Object.assign(new Error(`zero link2symlink count for ${id}`),{code:"EIO"});
  return count;
}
function writeCount(rootfs,id,count) {
  if (count<=0n || count>0xffffffffffffffffn) throw Object.assign(new Error("link count overflow"),{code:"EMLINK"});
  replaceSymlink(host(rootfs,`${METS}/${id}`),`n${count.toString(16).padStart(16,"0")}`);
}
function createRef(rootfs,guestPath,objectGuest) {
  const ref=refGuestPath(guestPath), path=host(rootfs,ref);
  ensureParent(path); symlinkSync(objectGuest,path); return ref;
}

// Mirrors upstream move_and_symlink_path(), but uses the relocatable Bun
// refs/objs/mets representation agreed in link2symlink.md.
export function emulateHardLink(rootfs,sourceHost,targetHost,sourceGuest,targetGuest) {
  if (!sourceGuest || !targetGuest) return false;
  if (targetGuest===sourceGuest) throw Object.assign(new Error("same link path"),{code:"EEXIST"});
  const existing=inspectAlias(rootfs,sourceHost);
  if (existing) {
    const targetRef=createRef(rootfs,targetGuest,existing.objectGuest);
    try { symlinkSync(targetRef,targetHost); }
    catch (error) { try { unlinkSync(host(rootfs,targetRef)); } catch {} throw error; }
    writeCount(rootfs,existing.id,readCount(rootfs,existing.id)+1n);
    return true;
  }
  if (lstatSync(sourceHost).isDirectory())
    throw Object.assign(new Error("hard link to directory"),{code:"EPERM"});
  let id, objectGuest, objectHost;
  mkdirSync(host(rootfs,OBJS),{recursive:true}); mkdirSync(host(rootfs,METS),{recursive:true});
  do {
    id=makeId(); objectGuest=`${OBJS}/${id}`; objectHost=host(rootfs,objectGuest);
    try { lstatSync(objectHost); } catch (error) { if (error.code==="ENOENT") break; throw error; }
  } while (true);
  renameSync(sourceHost,objectHost);
  let sourceRef, targetRef;
  try {
    sourceRef=createRef(rootfs,sourceGuest,objectGuest);
    targetRef=createRef(rootfs,targetGuest,objectGuest);
    symlinkSync(sourceRef,sourceHost); symlinkSync(targetRef,targetHost);
    writeCount(rootfs,id,2n);
  } catch (error) {
    try { unlinkSync(targetHost); } catch {} try { unlinkSync(sourceHost); } catch {}
    try { if (targetRef) unlinkSync(host(rootfs,targetRef)); } catch {}
    try { if (sourceRef) unlinkSync(host(rootfs,sourceRef)); } catch {}
    try { unlinkSync(host(rootfs,`${METS}/${id}`)); } catch {}
    try { renameSync(objectHost,sourceHost); } catch {}
    throw error;
  }
  return true;
}

// Cheaper than inspectEmulatedAlias(): callers that only need to know whether a
// name is an emulated hard link should not pay for the mets lookup, and must
// not inherit its throw on an inconsistent count.
export function isEmulatedAlias(rootfs,aliasHost) {
  return inspectAlias(rootfs,aliasHost)!==null;
}

export function inspectEmulatedAlias(rootfs,aliasHost) {
  const value=inspectAlias(rootfs,aliasHost);
  return value===null?null:{...value,nlink:readCount(rootfs,value.id)};
}

export function inspectEmulatedObject(rootfs,objectHost) {
  const prefix=host(rootfs,`${OBJS}/`);
  const value=objectHost.endsWith(" (deleted)")?objectHost.slice(0,-10):objectHost;
  if (!value.startsWith(prefix)) return null;
  const id=value.slice(prefix.length);
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  try { return {id,nlink:readCount(rootfs,id)}; } catch { return null; }
}

export function hasEmulatedDirectory(rootfs,guestPath) {
  try { return lstatSync(host(rootfs,refGuestPath(guestPath))).isDirectory(); }
  catch { return false; }
}

function rewriteRefSubtree(rootfs,refDirectoryGuest,oldRefBase,newRefBase) {
  const directoryHost=host(rootfs,refDirectoryGuest);
  for (const entry of readdirSync(directoryHost,{withFileTypes:true})) {
    const childRef=`${refDirectoryGuest}/${entry.name}`;
    if (entry.isDirectory()) { rewriteRefSubtree(rootfs,childRef,oldRefBase,newRefBase); continue; }
    if (!entry.isSymbolicLink()) continue;
    const aliasGuest=childRef.slice(REFS.length), aliasHost=host(rootfs,aliasGuest);
    // The moved alias still names the old ref. Match its exact payload so an
    // unrelated symlink is never rewritten merely because it occupies the
    // corresponding guest pathname.
    const oldChildRef=`${oldRefBase}${childRef.slice(newRefBase.length)}`;
    try { if (readlinkSync(aliasHost)!==oldChildRef) continue; } catch { continue; }
    replaceSymlink(aliasHost,childRef);
  }
}

export function commitEmulatedDirectoryRename(rootfs,sourceGuest,targetGuest) {
  const oldRefGuest=refGuestPath(sourceGuest), oldRef=host(rootfs,oldRefGuest);
  const newRefGuest=refGuestPath(targetGuest), newRef=host(rootfs,newRefGuest);
  ensureParent(newRef); renameSync(oldRef,newRef);
  rewriteRefSubtree(rootfs,newRefGuest,oldRefGuest,newRefGuest);
}

// Called only after the kernel successfully removed the visible alias. This
// corresponds to upstream decrement_link_count(). Refs are authoritative, so
// data deletion is limited to the transition from one validated ref to zero.
export function commitEmulatedUnlink(rootfs,link) {
  unlinkSync(host(rootfs,link.refGuest));
  if (link.nlink>1n) { writeCount(rootfs,link.id,link.nlink-1n); return; }
  unlinkSync(host(rootfs,`${METS}/${link.id}`));
  unlinkSync(host(rootfs,link.objectGuest));
}

// Complete a successful kernel rename of the visible alias. Upstream keeps
// l2s links unresolved for rename too; this updates our mirrored ref pathname
// and then replaces the moved alias payload with its new guest-absolute ref.
export function commitEmulatedRename(rootfs,link,targetHost,targetGuest,replaced=null) {
  if (replaced && replaced.id!==link.id) commitEmulatedUnlink(rootfs,replaced);
  const oldRef=host(rootfs,link.refGuest), newRefGuest=refGuestPath(targetGuest);
  const newRef=host(rootfs,newRefGuest);
  ensureParent(newRef); renameSync(oldRef,newRef);
  replaceSymlink(targetHost,newRefGuest);
}
