/** System V shared memory, emulated in the tracer.
 *
 * Android's seccomp policy denies the SysV IPC syscalls outright -- shmget
 * does not fail, it raises SIGSYS -- so a guest that needs them has to be
 * answered here or not at all. PostgreSQL is the case that matters: even with
 * shared_memory_type=mmap it still creates a tiny SysV segment as its
 * postmaster interlock, so there is no configuration that avoids this.
 *
 * The port follows src/extension/sysvipc/sysvipc_shm.c in what it models --
 * segment table, nattch, deferred IPC_RMID -- but not in how the memory is
 * handed to the guest. Upstream cannot mmap on the guest's behalf from inside
 * its own ptrace loop, so it forks a helper process, has the tracee connect to
 * it over AF_UNIX and passes the descriptor with SCM_RIGHTS. That helper is
 * also the part that does not work: on Android its re-exec of
 * `/proc/self/exe --shm-helper` fails to parse, the helper never reports its
 * socket, and every shm request falls back to -EIO. Here the tracer can make
 * the tracee run a syscall directly, so the descriptor never has to travel:
 * the guest opens the backing file and maps it itself.
 */

import { mkdirSync, openSync, closeSync, ftruncateSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

const IPC_PRIVATE = 0, IPC_CREAT = 0o1000, IPC_EXCL = 0o2000;
const EEXIST = -17, ENOENT = -2, EINVAL = -22, ENOSPC = -28;

// asm-generic layout, which is what arm64 uses. struct shmid64_ds is 112
// bytes: a 48-byte ipc64_perm, then segsz at 48 and the three times, with
// shm_nattch at 88 -- the field PostgreSQL reads to decide whether another
// postmaster still holds a segment it found.
export const SHMID_DS_SIZE = 112;
const PERM_KEY = 0, PERM_UID = 4, PERM_GID = 8, PERM_CUID = 12, PERM_CGID = 16, PERM_MODE = 20;
const SEGSZ = 48, ATIME = 56, DTIME = 64, CTIME = 72, CPID = 80, LPID = 84, NATTCH = 88;

const segments = new Map();   // shmid -> { key, size, path, nattch, removed }
const byKey = new Map();      // key -> shmid
let nextId = 1;
let directory = null;

/** Where the backing files live. Android has no writable /tmp; TMPDIR is the
 *  only thing that can be relied on, and it is what the launcher already
 *  guarantees for bwrap's sandbox roots. */
function shmDirectory() {
  if (directory !== null) return directory;
  const base = process.env.TMPDIR ?? "/data/local/tmp";
  sweepAbandoned(base);
  directory = join(base, `bunproot-shm-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  // A tracer that exits normally cleans up after itself; one that is killed
  // outright cannot, so the next run collects what it left.
  process.on("exit", shmCleanup);
  return directory;
}

/** Remove the segment directories of tracers that are no longer running. The
 *  pid in the name is the whole test: signal 0 asks the kernel whether it
 *  still exists without touching it. */
function sweepAbandoned(base) {
  let entries;
  try { entries = readdirSync(base); } catch { return; }
  for (const entry of entries) {
    const match = /^bunproot-shm-(\d+)$/.exec(entry);
    if (match === null || Number(match[1]) === process.pid) continue;
    try { process.kill(Number(match[1]), 0); continue; } catch (error) {
      // EPERM means someone else's live process owns that pid; only ESRCH
      // says it is gone.
      if (error?.code !== "ESRCH") continue;
    }
    try { rmSync(join(base, entry), { recursive: true, force: true }); } catch {}
  }
}

/** shmget(2). Returns a segment id, or a negative errno. */
export function shmGet(key, size, flags, owner = { uid: 0, gid: 0, pid: 0 }) {
  if (key !== IPC_PRIVATE) {
    const existing = byKey.get(key);
    if (existing !== undefined) {
      if ((flags & IPC_CREAT) && (flags & IPC_EXCL)) return EEXIST;
      return existing;
    }
    if (!(flags & IPC_CREAT)) return ENOENT;
  }
  const shmid = nextId++;
  const path = join(shmDirectory(), `${shmid}`);
  try {
    const fd = openSync(path, "w+");
    try { ftruncateSync(fd, size); } finally { closeSync(fd); }
  } catch { return ENOSPC; }
  const now = Math.floor(Date.now() / 1000);
  segments.set(shmid, { key, size, path, nattch: 0, removed: false,
    uid: owner.uid, gid: owner.gid, mode: flags & 0o777,
    cpid: owner.pid, lpid: 0, atime: 0, dtime: 0, ctime: now });
  if (key !== IPC_PRIVATE) byKey.set(key, shmid);
  return shmid;
}

export function shmSegment(shmid) {
  return segments.get(shmid) ?? null;
}

export function shmAttached(shmid, pid = 0) {
  const segment = segments.get(shmid);
  if (segment === undefined) return;
  segment.nattch++;
  segment.lpid = pid;
  segment.atime = Math.floor(Date.now() / 1000);
}

/** A segment marked removed only goes away once the last attachment does,
 *  which is what lets PostgreSQL delete a stale segment while deciding
 *  whether another postmaster still holds it. */
export function shmDetached(shmid, pid = 0) {
  const segment = segments.get(shmid);
  if (segment === undefined) return;
  if (segment.nattch > 0) segment.nattch--;
  segment.lpid = pid;
  segment.dtime = Math.floor(Date.now() / 1000);
  if (segment.removed && segment.nattch === 0) discard(shmid, segment);
}

/** shmctl(2) IPC_STAT: the segment as a struct shmid64_ds. */
export function shmStat(shmid) {
  const segment = segments.get(shmid);
  if (segment === undefined) return null;
  const buffer = new Uint8Array(SHMID_DS_SIZE);
  const view = new DataView(buffer.buffer);
  view.setInt32(PERM_KEY, segment.key, true);
  view.setUint32(PERM_UID, segment.uid, true);
  view.setUint32(PERM_GID, segment.gid, true);
  view.setUint32(PERM_CUID, segment.uid, true);
  view.setUint32(PERM_CGID, segment.gid, true);
  view.setUint32(PERM_MODE, segment.mode, true);
  view.setBigUint64(SEGSZ, BigInt(segment.size), true);
  view.setBigInt64(ATIME, BigInt(segment.atime), true);
  view.setBigInt64(DTIME, BigInt(segment.dtime), true);
  view.setBigInt64(CTIME, BigInt(segment.ctime), true);
  view.setInt32(CPID, segment.cpid, true);
  view.setInt32(LPID, segment.lpid, true);
  view.setBigUint64(NATTCH, BigInt(segment.nattch), true);
  return buffer;
}

/** shmctl(2) IPC_RMID. The segment stops answering to its key at once, but
 *  its memory survives until the last attachment goes -- which is what lets
 *  PostgreSQL remove a segment it has decided is stale while something is
 *  still mapped. */
export function shmRemove(shmid) {
  const segment = segments.get(shmid);
  if (segment === undefined) return EINVAL;
  if (segment.key !== IPC_PRIVATE) byKey.delete(segment.key);
  segment.key = IPC_PRIVATE;
  segment.removed = true;
  if (segment.nattch === 0) discard(shmid, segment);
  return 0;
}

function discard(shmid, segment) {
  segments.delete(shmid);
  if (segment.key !== IPC_PRIVATE) byKey.delete(segment.key);
  try { rmSync(segment.path, { force: true }); } catch {}
}

/** The backing files outlive nothing: a tracer that exits takes its whole
 *  IPC namespace with it, as upstream's does. */
export function shmCleanup() {
  for (const [shmid, segment] of [...segments]) discard(shmid, segment);
  if (directory !== null) { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
}

export const EINVAL_SEGMENT = EINVAL;
