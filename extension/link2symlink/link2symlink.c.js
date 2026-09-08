import { mkdirSync, lstatSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { readlink as readlinkAsync } from "node:fs/promises";
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

/** How many descriptors to keep in flight while reading the store.
 *
 * Measured on an Android app uid over 97037 refs: serially, a warm store costs
 * 6.6us per ref and a cold one 19.6us. Batched, both land near 3.5us -- the
 * concurrency hides the cold-cache stalls almost entirely, which matters more
 * than the raw speedup because a store is usually read once and cold. A batch
 * of 16 is no better than serial, and 256 is no better than 64.
 */
const SCAN_BATCH = 64;

/**
 * Read the whole store and report what it holds.
 *
 * The symlinks are the only authority here: whether a store is pinned, and to
 * what, is derived from the targets themselves rather than from any recorded
 * state, so a copied, moved, half-converted or hand-edited store still
 * reports what it actually is. Nothing is written.
 */
export async function scanStore(rootfs) {
  const refsRoot = host(rootfs, REFS);
  try { if (!lstatSync(refsRoot).isDirectory()) return null; } catch { return null; }

  const relatives = [];
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop();
    let entries;
    try { entries = readdirSync(refsRoot + relative, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isSymbolicLink()) relatives.push(child);
    }
  }

  const report = { refs: relatives.length, portable: 0, pinned: 0, malformed: 0,
    live: 0, stale: 0, prefixes: new Map(), objects: new Set() };
  const objectMarker = `${OBJS}/`;
  for (let index = 0; index < relatives.length; index += SCAN_BATCH) {
    const batch = relatives.slice(index, index + SCAN_BATCH);
    const targets = await Promise.all(batch.flatMap((relative) => [
      readlinkAsync(refsRoot + relative).catch(() => null),   // ref -> object
      readlinkAsync(host(rootfs, relative)).catch(() => null), // guest alias -> ref
    ]));
    for (let offset = 0; offset < batch.length; offset++) {
      const relative = batch[offset];
      const object = targets[offset * 2], alias = targets[offset * 2 + 1];
      // Leg two says which form the store is in. A guest-absolute target is
      // the portable form; anything else carries a host prefix, and what
      // precedes the store path is that prefix.
      if (object === null) report.malformed++;
      else if (OBJECT_RE.test(object)) {
        report.portable++;
        report.objects.add(object.slice(objectMarker.length));
      } else {
        const at = object.indexOf(objectMarker);
        const id = at < 0 ? null : object.slice(at + objectMarker.length);
        if (at <= 0 || !/^[0-9a-f]{32}$/.test(id)) report.malformed++;
        else {
          report.pinned++;
          report.objects.add(id);
          const prefix = object.slice(0, at);
          report.prefixes.set(prefix, (report.prefixes.get(prefix) ?? 0) + 1);
        }
      }
      // Leg one is what a reader actually starts from: a ref whose guest name
      // no longer points back at it describes a file that is no longer there.
      if (alias !== null && alias.endsWith(`${REFS}${relative}`)) report.live++;
      else report.stale++;
    }
  }
  return report;
}

// The original PRoot's store, which this port deliberately cannot read. Its
// names are `<PREFIX><basename><NNNN>` for the intermediate link and the same
// plus `.<NNNN>` for the file holding the data, where those last four digits
// are the emulated link count. PROOT_L2S_DIR collects them in one directory --
// proot-distro sets it to /.l2s -- and without it they sit beside each file
// they emulate.
const UPSTREAM_STORE = "/.l2s", UPSTREAM_PREFIX = ".l2s.";
const UPSTREAM_COUNT = /\.(\d{4})$/;

/**
 * Report on an original-format store, without walking the rootfs.
 *
 * Only the collected form is counted: one readdir of /.l2s. The scattered form
 * would need a full-tree walk to tally, which costs far more than the answer
 * is worth, so it is reported as present and left uncounted.
 */
export function scanUpstreamStore(rootfs) {
  const storeHost = host(rootfs, UPSTREAM_STORE);
  let entries = null;
  try { if (lstatSync(storeHost).isDirectory()) entries = readdirSync(storeHost); } catch {}
  if (entries === null) {
    // One readdir of the rootfs root, not a walk: enough to notice the
    // scattered form when it reaches the top level, and cheap when it does not.
    try {
      if (readdirSync(rootfs).some((name) => name.startsWith(UPSTREAM_PREFIX)))
        return { collected: false, intermediates: 0, finals: 0, links: 0, prefix: null };
    } catch {}
    return null;
  }

  let intermediates = 0, finals = 0, links = 0, sample = null;
  for (const name of entries) {
    if (!name.startsWith(UPSTREAM_PREFIX)) continue;
    const count = UPSTREAM_COUNT.exec(name);
    if (count !== null) { finals++; links += Number(count[1]); }
    else { intermediates++; sample ??= name; }
  }

  // Where the store believes it lives. Upstream writes host-absolute targets,
  // so this is what decides whether any of it is still reachable.
  let prefix = null;
  if (sample !== null) {
    try {
      const target = readlinkSync(`${storeHost}/${sample}`);
      const at = target.indexOf(`${UPSTREAM_STORE}/`);
      if (at > 0) prefix = target.slice(0, at);
    } catch {}
  }
  return { collected: true, intermediates, finals, links, prefix };
}

/** A rootfs whose own pathname contains a `.proot.l2s` segment cannot be
 *  pinned: the recorded prefix and the store path would then be
 *  indistinguishable, and unpinning could not tell where one ends and the
 *  other begins. Refusing is cheaper than guessing wrong on someone's data. */
export function pinnableRootfs(rootfs) {
  return !rootfs.split("/").includes(STORE.slice(1));
}

/**
 * Rewrite every target in the store to the pinned or the portable form.
 *
 * Both legs move: the guest alias that names a ref, and the ref that names an
 * object. Following an emulated link from outside the rootfs breaks at
 * whichever leg is still guest-absolute, so converting one is the same as
 * converting neither.
 *
 * Each target is judged on its own, so the work is idempotent -- an
 * interrupted run is finished by running it again -- and unpinning locates
 * the store by its own path segment rather than by any recorded prefix, so a
 * rootfs that moved after being pinned can still be brought back.
 */
export async function convertStore(rootfs, pin) {
  const refsRoot = host(rootfs, REFS);
  try { if (!lstatSync(refsRoot).isDirectory()) return null; } catch { return null; }

  const relatives = [];
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop();
    let entries;
    try { entries = readdirSync(refsRoot + relative, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isSymbolicLink()) relatives.push(child);
    }
  }

  const report = { refs: relatives.length, changed: 0, already: 0, skipped: 0 };
  // The last occurrence, not the first: a prefix may itself contain the
  // segment, and only the final one starts the store's own path.
  const portable = (target) => {
    const at = target.lastIndexOf(`${STORE}/`);
    return at < 0 ? null : target.slice(at);
  };
  const wanted = (target) => {
    const guest = portable(target);
    if (guest === null) return null;
    return pin ? `${rootfs}${guest}` : guest;
  };

  for (let index = 0; index < relatives.length; index += SCAN_BATCH) {
    const batch = relatives.slice(index, index + SCAN_BATCH);
    const targets = await Promise.all(batch.flatMap((relative) => [
      readlinkAsync(refsRoot + relative).catch(() => null),
      readlinkAsync(host(rootfs, relative)).catch(() => null),
    ]));
    for (let offset = 0; offset < batch.length; offset++) {
      const relative = batch[offset];
      const legs = [
        { path: refsRoot + relative, target: targets[offset * 2] },
        { path: host(rootfs, relative), target: targets[offset * 2 + 1] },
      ];
      let changed = false, skipped = false;
      for (const { path, target } of legs) {
        if (target === null) { skipped = true; continue; }
        const next = wanted(target);
        if (next === null) { skipped = true; continue; }
        if (next === target) continue;
        try { replaceSymlink(path, next); changed = true; } catch { skipped = true; }
      }
      if (skipped) report.skipped++;
      else if (changed) report.changed++;
      else report.already++;
    }
  }
  return report;
}

/**
 * Is this store pinned? Cheap enough to ask on every launch.
 *
 * A handful of refs decides it. The cost is in walking to the first leaf, not
 * in reading targets, so once there it reads a few rather than one: a store
 * caught halfway through a conversion would otherwise answer with whichever
 * form its first ref happens to be in, and a guest let into that state finds
 * some of its hard links unrecognised. Any pinned ref is enough to refuse.
 *
 * Both budgets are needed: the refs mirror the guest tree, so a store whose
 * first branches are deep directories can cost more readdir calls to reach a
 * leaf than it costs to read every target once there.
 *
 * It is still a sample, not a survey -- `--l2s-status` is what reports a store
 * properly, and the refusal names it.
 *
 * Returns true, false, or null when the rootfs carries no store at all.
 */
const PIN_SAMPLE = 8, PIN_DIRECTORIES = 12;
export function storeIsPinned(rootfs) {
  const refsRoot = host(rootfs, REFS);
  try { if (!lstatSync(refsRoot).isDirectory()) return null; } catch { return null; }
  const pending = [""];
  let seen = 0, visited = 0;
  while (pending.length > 0 && seen < PIN_SAMPLE && visited < PIN_DIRECTORIES) {
    const relative = pending.pop();
    let entries;
    try { entries = readdirSync(refsRoot + relative, { withFileTypes: true }); visited++; } catch { continue; }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) { pending.push(child); continue; }
      if (!entry.isSymbolicLink()) continue;
      let target;
      try { target = readlinkSync(refsRoot + child); } catch { continue; }
      if (!target.startsWith(`${OBJS}/`)) return true;
      if (++seen >= PIN_SAMPLE) break;
    }
  }
  return seen > 0 ? false : null;
}
