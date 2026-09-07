import { FFIType, ptr } from "bun:ffi";
import { accessSync, constants as fsConstants, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { tmpdir } from "node:os";
import { openLibrary } from "../ffi.js";
import { getPc, getSp, getSyscallNumber, getX, makeIovec, makeRegisterSet, NT_PRSTATUS, setPc, setX } from "../tracee/reg.c.js";
import { readCString, writeBytes, writeCString } from "../tracee/mem.c.js";
import { readElfLoadInfo, relocateElf } from "../execve/elf.c.js";
import { expandShebang, makeGuestPaths } from "../execve/shebang.c.js";
import { canonicalizeGuestPath } from "../path/canon.c.js";
import { guestEnvironment, noSeccomp, verbose } from "../env.js";
import { count, report, timed } from "../profile.js";
import { buildFilter, buildProgramHeader } from "../syscall/seccomp.c.js";
import { commitEmulatedDirectoryRename, commitEmulatedRename, commitEmulatedUnlink, emulateHardLink, hasEmulatedDirectory, inspectEmulatedAlias, inspectEmulatedObject, isEmulatedAlias } from "../extension/link2symlink/link2symlink.c.js";

const PTRACE_PEEKTEXT=1, PTRACE_PEEKDATA=2, PTRACE_POKETEXT=4, PTRACE_POKEDATA=5;
const PTRACE_CONT=7, PTRACE_ATTACH=16, PTRACE_SYSCALL=24;
const PTRACE_GETREGSET=0x4204, PTRACE_SETREGSET=0x4205, PTRACE_SETOPTIONS=0x4200;
const PTRACE_GET_SYSCALL_INFO=0x420e, PTRACE_GETSIGINFO=0x4202;
const native = openLibrary("libc", {
  ptrace: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.u64], returns: FFIType.i64 },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  process_vm_readv: { args: [FFIType.i32,FFIType.ptr,FFIType.u64,FFIType.ptr,FFIType.u64,FFIType.u64], returns:FFIType.i64 },
}).symbols;
const call = (request, pid, address=0n, data=0n) => native.ptrace(request, pid, address, data);
const memory = {
  peek: (pid, address) => call(PTRACE_PEEKDATA, pid, address),
  poke(pid, address, word) { if (call(PTRACE_POKEDATA, pid, address, word) === -1n) throw new Error("PTRACE_POKEDATA failed"); },
  read(pid,address,length) {
    const output=new Uint8Array(length), local=new Uint8Array(16), remote=new Uint8Array(16);
    const localView=new DataView(local.buffer), remoteView=new DataView(remote.buffer);
    localView.setBigUint64(0,BigInt(ptr(output)),true); localView.setBigUint64(8,BigInt(length),true);
    remoteView.setBigUint64(0,address,true); remoteView.setBigUint64(8,BigInt(length),true);
    const count=native.process_vm_readv(pid,ptr(local),1n,ptr(remote),1n,0n);
    return count>0n?output.subarray(0,Number(count)):null;
  },
};
function wait(pid, options = 0) {
  return waitResult(pid,options).status;
}
function waitResult(pid, options = 0) {
  const bytes = new Uint8Array(4);
  const waited=native.waitpid(pid, ptr(bytes), options);
  if (waited < 0) throw new Error("waitpid failed");
  return { pid:waited, status:new DataView(bytes.buffer).getInt32(0, true) };
}

function eventMessage(pid) {
  const bytes=new Uint8Array(8);
  if (call(0x4201,pid,0n,BigInt(ptr(bytes)))<0n) throw new Error("PTRACE_GETEVENTMSG failed");
  return Number(new DataView(bytes.buffer).getBigUint64(0,true));
}

function catchesSignal(pid,signal) {
  try {
    const match=/^SigCgt:\s+([0-9a-f]+)/mi.exec(readFileSync(`/proc/${pid}/status`,"utf8"));
    return match!==null && (BigInt(`0x${match[1]}`)&(1n<<BigInt(signal-1)))!==0n;
  } catch { return false; }
}
// PTRACE_GET_SYSCALL_INFO already carries the syscall number, its arguments and
// its return value, so one call answers what would otherwise cost a
// PTRACE_GETREGSET as well.  The buffer is reused: a stop is handled to
// completion before the next one is fetched.
const SYSCALL_INFO=new Uint8Array(88);
const SYSCALL_INFO_VIEW=new DataView(SYSCALL_INFO.buffer);
const SYSCALL_INFO_POINTER=BigInt(ptr(SYSCALL_INFO));
function syscallInfo(pid) {
  SYSCALL_INFO.fill(0);
  const result=call(PTRACE_GET_SYSCALL_INFO,pid,BigInt(SYSCALL_INFO.byteLength),SYSCALL_INFO_POINTER);
  // op: NONE=0, ENTRY=1, EXIT=2, SECCOMP=3
  return result<0n?0:SYSCALL_INFO[0];
}
const syscallInfoNumber=()=>Number(SYSCALL_INFO_VIEW.getBigUint64(24,true));
const syscallInfoResult=()=>BigInt.asIntN(64,SYSCALL_INFO_VIEW.getBigInt64(24,true));
// PTRACE_GET_SYSCALL_INFO is Linux 5.3 and newer. Where it is missing the info
// block stays zeroed, so its "result" reads as success for every syscall that
// ever fails -- which silently disables the linkat(2) EACCES fallback and lets
// the link2symlink bookkeeping commit against calls that did not happen. The
// register holds the same value on every kernel; the info block is only worth
// reading because it saves the PTRACE_GETREGSET when the kernel filled it in.
const exitResult=(phase,state)=>phase===2?syscallInfoResult():BigInt.asIntN(64,getX(state.regs,0));
function getRegisters(pid) {
  const regs = makeRegisterSet(), iovec = makeIovec(regs);
  if (call(PTRACE_GETREGSET, pid, BigInt(NT_PRSTATUS), BigInt(iovec.pointer)) < 0n) throw new Error("PTRACE_GETREGSET failed");
  return { regs, iovec };
}
function putRegisters(pid, state) {
  if (call(PTRACE_SETREGSET, pid, BigInt(NT_PRSTATUS), BigInt(state.iovec.pointer)) < 0n) throw new Error("PTRACE_SETREGSET failed");
}
function setKernelSyscallNumber(pid,state,number) {
  setX(state.regs,8,BigInt.asUintN(64,BigInt(number)));
  const value=new Uint8Array(8);
  new DataView(value.buffer).setBigUint64(0,BigInt.asUintN(64,BigInt(number)),true);
  const iovec=new Uint8Array(16), view=new DataView(iovec.buffer);
  view.setBigUint64(0,BigInt(ptr(value)),true);
  view.setBigUint64(8,8n,true);
  if (call(PTRACE_SETREGSET,pid,0x404n,BigInt(ptr(iovec)))<0n)
    throw new Error("unable to set arm64 syscall number");
  putRegisters(pid,state);
}

const ARM64_SYSCALL_TRAMPOLINE = 0xd4200000d4000001n; // svc #0; brk #0
const TRAMPOLINE_REGION_SIZE = 16n*1024n*1024n;
const SYS_READ = 63, SYS_LSEEK = 62, SYS_GETPID = 172, SYS_MMAP = 222;
const SYS_GETCWD = 17, SYS_DUP = 23, SYS_CHDIR = 49, SYS_FCHDIR = 50, SYS_OPENAT = 56, SYS_CLOSE = 57, SYS_MUNMAP=215;
const SYS_READLINKAT = 78, SYS_GETDENTS64 = 61;
const SYS_BIND = 200, SYS_CONNECT = 203;
const SYS_FCHOWNAT = 54, SYS_FCHOWN = 55;
const SYS_SIGALTSTACK = 132, SYS_RT_SIGACTION = 134, SYS_PRCTL = 167;
const PTRACE_EVENT_SECCOMP = 7;
const PR_SET_NO_NEW_PRIVS = 38, PR_SET_SECCOMP = 22, SECCOMP_MODE_FILTER = 2, PR_SET_NAME = 15;
const TASK_COMM_LEN = 16;
const DT_REG = 8, DT_LNK = 10;
// Keep this in sync with the original src/syscall/enter.c.  Android commonly
// rejects namespace creation, while the process/thread creation itself is OK.
const CLONE_NS_MASK=0x7e020080n;

function stoppedSignal(status) {
  return (status & 0xff) === 0x7f ? (status >> 8) & 0xff : null;
}

function remoteSyscallAt(pid, address, syscall, args = []) {
  const state = getRegisters(pid);
  const savedRegisters = state.regs.bytes.slice();
  const savedCode = call(PTRACE_PEEKTEXT, pid, address);
  if (call(PTRACE_POKETEXT, pid, address, ARM64_SYSCALL_TRAMPOLINE) < 0n)
    throw new Error("unable to install remote-syscall trampoline");
  try {
    setPc(state.regs, address);
    setX(state.regs, 8, syscall);
    for (let index = 0; index < 6; index++) setX(state.regs, index, args[index] ?? 0n);
    putRegisters(pid, state);
    if (call(PTRACE_CONT, pid) < 0n) throw new Error("PTRACE_CONT failed during remote syscall");
    let status = wait(pid);
    // PTRACE_ATTACH can leave the bootstrap's original group-stop queued, and
    // once the filter is installed the tracer's own remote munmap/chdir/close
    // trip it: those are already host paths, so let them through untranslated
    // and keep waiting for the trampoline's brk.
    while (stoppedSignal(status) === 19 || (status >>> 16) === PTRACE_EVENT_SECCOMP) {
      if (call(PTRACE_CONT, pid) < 0n) throw new Error("failed to drain remote-syscall stop");
      status = wait(pid);
    }
    if (stoppedSignal(status) !== 5) throw new Error(`remote syscall stopped with status 0x${status.toString(16)}`);
    return BigInt.asIntN(64, getX(getRegisters(pid).regs, 0));
  } finally {
    call(PTRACE_POKETEXT, pid, address, savedCode);
    state.regs.bytes.set(savedRegisters);
    putRegisters(pid, state);
  }
}

function allocateRemoteSyscalls(pid,borrowedPc) {
  const requested=0x2000000000n;
  const page=remoteSyscallAt(pid,borrowedPc,SYS_MMAP,
    [requested,TRAMPOLINE_REGION_SIZE,7n,0x100022n,-1n,0n]); // FIXED_NOREPLACE|PRIVATE|ANON
  if (page < 0n) throw new Error(`remote mmap failed: ${page}`);
  if (page!==requested) throw new Error(`remote mmap returned unexpected address 0x${page.toString(16)}`);
  memory.poke(pid, page, ARM64_SYSCALL_TRAMPOLINE);
  return page;
}

function initializeRemoteSyscalls(pid) {
  const borrowedPc=getPc(getRegisters(pid).regs);
  const remotePid=remoteSyscallAt(pid,borrowedPc,SYS_GETPID);
  if (remotePid!==BigInt(pid)) throw new Error(`remote getpid mismatch: expected ${pid}, got ${remotePid}`);
  return allocateRemoteSyscalls(pid,borrowedPc);
}

function resetExecAddressSpace(pid,trampoline) {
  const trampolineEnd=trampoline+TRAMPOLINE_REGION_SIZE;
  const mappings=readFileSync(`/proc/${pid}/maps`,"utf8").trim().split("\n");
  for (const line of mappings) {
    const match=/^([0-9a-f]+)-([0-9a-f]+)\s/.exec(line);
    if (!match) continue;
    const start=BigInt(`0x${match[1]}`), end=BigInt(`0x${match[2]}`);
    if (start<trampolineEnd && end>trampoline) continue;
    // Kernel-owned mappings either cannot be unmapped or are regenerated by
    // exec.  Leaving them in place matches what the new Linux image expects.
    // munmap cannot reset the kernel's mm->brk metadata like execve does.
    // Preserve the inherited heap until brk virtualization is implemented;
    // otherwise the new dynamic linker receives an apparently valid break
    // that points into an unmapped range and faults immediately.
    if (line.includes("[heap]") || line.includes("[vvar]") || line.includes("[vdso]")) continue;
    const result=remoteCall(pid,trampoline,SYS_MUNMAP,[start,end-start]);
    if (result<0n && verbose)
      console.error(`[ptrace] pid=${pid} munmap 0x${start.toString(16)}-0x${end.toString(16)} failed: ${result}`);
  }
}

function isMapped(pid,address) {
  return readFileSync(`/proc/${pid}/maps`,"utf8").split("\n").some((line)=>{
    const match=/^([0-9a-f]+)-([0-9a-f]+)\s/.exec(line);
    return match && BigInt(`0x${match[1]}`)<=address && BigInt(`0x${match[2]}`)>address;
  });
}

function closeExecDescriptors(pid,trampoline) {
  let entries;
  try { entries=readdirSync(`/proc/${pid}/fdinfo`); }
  catch { return; }
  for (const entry of entries) {
    const fd=Number(entry);
    if (!Number.isInteger(fd) || fd<0) continue;
    let text;
    try { text=readFileSync(`/proc/${pid}/fdinfo/${fd}`,"utf8"); }
    catch { continue; }
    const match=/^flags:\s*([0-7]+)/m.exec(text);
    if (!match || (Number.parseInt(match[1],8)&0x80000)===0) continue;
    remoteCall(pid,trampoline,SYS_CLOSE,[BigInt(fd)]);
  }
}

function remoteCall(pid, trampoline, syscall, args=[]) {
  return remoteSyscallAt(pid, trampoline, syscall, args);
}

// A memory fault says far more with the address it happened at and the mapping
// that address belongs to: an emulated exec that leaves a stale mapping behind
// shows up as a write into a region the guest never asked for.
function describeFault(pid,signal,pc,lr=null) {
  if (signal!==4 && signal!==7 && signal!==11) return "";
  const info=new Uint8Array(128);
  if (call(PTRACE_GETSIGINFO,pid,0n,BigInt(ptr(info)))<0n) return "";
  const view=new DataView(info.buffer), address=view.getBigUint64(16,true);
  let description=` si_code=${view.getInt32(8,true)} si_addr=0x${address.toString(16)}`;
  let mappings=[];
  try { mappings=readFileSync(`/proc/${pid}/maps`,"utf8").split("\n"); } catch { return description; }
  const locate=(value)=>{
    for (const line of mappings) {
      const match=/^([0-9a-f]+)-([0-9a-f]+)\s/.exec(line);
      if (!match) continue;
      const start=BigInt(`0x${match[1]}`);
      if (value>=start && value<BigInt(`0x${match[2]}`)) return `${line.trim()} +0x${(value-start).toString(16)}`;
    }
    return null;
  };
  const faulted=locate(address), executing=locate(pc);
  if (faulted!==null) description+=` in [${faulted}]`;
  if (executing!==null) description+=` from [${executing}]`;
  // The link register names the caller, which is what identifies an abort
  // helper's real origin -- __stack_chk_fail and friends all look alike at pc.
  if (lr!==null) { const called=locate(lr); if (called!==null) description+=` calledby [${called}]`; }
  // A poor man's backtrace: the stack words that land inside an executable
  // mapping are, near enough, the return addresses of the frames above.
  try {
    const sp=getX(getRegisters(pid).regs,31);
    const bytes=readTraceeBytes(pid,sp,2048);
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const seen=new Set(), frames=[];
    for (let offset=0; offset+8<=bytes.length && frames.length<8; offset+=8) {
      const word=view.getBigUint64(offset,true);
      if (word<0x1000n) continue;
      const where=locate(word);
      if (where===null || !/ r-xp /.test(where)) continue;
      const name=where.replace(/^.*\s(\S+) (\+0x[0-9a-f]+)$/,"$1 $2");
      if (seen.has(name)) continue;
      seen.add(name); frames.push(name.replace(/^.*\//,""));
    }
    if (frames.length) description+=` stack[${frames.join(" <- ")}]`;
  } catch {}
  return description;
}

// execve(2) resets every caught signal to SIG_DFL and disables the alternate
// signal stack; SIG_IGN and SIG_DFL dispositions survive.  The guest image is
// installed by the loader rather than by a real execve, so without this a
// handler address belonging to the Android bootstrap shell stays registered.
// The kernel would then deliver a signal straight into an address the new image
// does not map -- which is why forwarding SIGCHLD used to kill the tracee
// instead of reaching its handler.
function resetGuestSignals(pid,trampoline) {
  const action=trampoline+2048n, previous=trampoline+2112n;
  writeBytes(memory,pid,action,new Uint8Array(32)); // SIG_DFL, no flags, empty mask
  for (let signal=1; signal<=64; signal++) {
    if (signal===9 || signal===19) continue; // SIGKILL and SIGSTOP cannot be changed
    if (remoteCall(pid,trampoline,SYS_RT_SIGACTION,[BigInt(signal),0n,previous,8n])<0n) continue;
    const handler=BigInt.asUintN(64,memory.peek(pid,previous));
    if (handler===0n || handler===1n) continue; // SIG_DFL / SIG_IGN
    remoteCall(pid,trampoline,SYS_RT_SIGACTION,[BigInt(signal),action,0n,8n]);
  }
  const stack=new Uint8Array(24);
  new DataView(stack.buffer).setUint32(8,2,true); // ss_flags = SS_DISABLE
  writeBytes(memory,pid,action,stack);
  remoteCall(pid,trampoline,SYS_SIGALTSTACK,[action,0n]);
}

// execve(2) names the task after the program it was asked for.  The loader has
// to do the same, or every guest process reports the Android bootstrap's
// `linker64` -- in the host's process list, and to the guest reading its own
// /proc/self/comm.  The name is the basename of the pathname handed to
// execve, before symlinks are followed and before a `#!` line is expanded
// (fs/exec.c:begin_new_exec calls set_task_comm with kbasename(bprm->filename),
// and binfmt_script replaces bprm->interp rather than bprm->filename): `/bin/sh`
// is `sh` even where it is a symlink to busybox, and a script keeps its own
// name rather than its interpreter's.  The kernel truncates to TASK_COMM_LEN
// including the NUL.
function setGuestName(pid,trampoline,requested) {
  const name=new TextEncoder().encode(requested).subarray(0,TASK_COMM_LEN-1);
  const address=trampoline+1024n;
  writeBytes(memory,pid,address,Uint8Array.from([...name,0]));
  remoteCall(pid,trampoline,SYS_PRCTL,[BigInt(PR_SET_NAME),address,0n,0n,0n]);
}

function setKernelRootCwd(pid,trampoline,rootfs) {
  const address=trampoline+512n;
  writeCString(memory,pid,address,rootfs);
  const result=remoteCall(pid,trampoline,SYS_CHDIR,[address]);
  if (result<0n) throw new Error(`remote chdir(${rootfs}) failed: ${result}`);
}

function mapElf(pid, trampoline, info) {
  const pathAddress = trampoline + 128n;
  writeCString(memory, pid, pathAddress, info.filename);
  const fd = remoteCall(pid, trampoline, SYS_OPENAT, [-100n, pathAddress, 0n, 0n]);
  if (fd < 0n) throw new Error(`remote openat failed for ${info.filename}: ${fd}`);
  try {
    for (const mapping of info.mappings) {
      const flags = mapping.anonymous ? 0x32n : 0x12n; // PRIVATE|FIXED[|ANONYMOUS]
      const mapped = remoteCall(pid, trampoline, SYS_MMAP, [mapping.address, mapping.length,
        BigInt(mapping.protection), flags, mapping.anonymous ? -1n : fd, mapping.offset]);
      if (mapped !== mapping.address)
        throw new Error(`remote mmap failed for ${info.filename} at 0x${mapping.address.toString(16)}: ${mapped}`);
      // PT_LOAD p_memsz can extend beyond p_filesz while the backing ELF still
      // has unrelated bytes later in the same page. mmap does not zero that
      // partial-page BSS for us, so match the original PRoot loader explicitly.
      if (!mapping.anonymous && mapping.clearLength > 0n) {
        const clearStart=mapping.address+mapping.length-mapping.clearLength;
        const clearEnd=clearStart+mapping.clearLength;
        for (let wordAddress=clearStart&~7n; wordAddress<clearEnd; wordAddress+=8n) {
          let word=BigInt.asUintN(64,memory.peek(pid,wordAddress));
          for (let byte=0n; byte<8n; byte++) {
            const address=wordAddress+byte;
            if (address>=clearStart && address<clearEnd) word&=~(0xffn<<(byte*8n));
          }
          memory.poke(pid,wordAddress,word);
        }
      }
    }
  } finally { remoteCall(pid, trampoline, SYS_CLOSE, [fd]); }
}

function loadGuestImages(pid, trampoline, guest) {
  const main = relocateElf(readElfLoadInfo(guest.executable), 0x3000000000n);
  const interpreter = guest.loader === null ? null : relocateElf(readElfLoadInfo(guest.loader), 0x3f00000000n);
  mapElf(pid, trampoline, main);
  if (interpreter !== null) mapElf(pid, trampoline, interpreter);
  return { main, interpreter };
}

function readAuxv(pid) {
  const bytes = readFileSync(`/proc/${pid}/auxv`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), entries = [];
  for (let offset=0; offset+16<=bytes.byteLength; offset+=16) {
    const type=view.getBigUint64(offset,true), value=view.getBigUint64(offset+8,true);
    if (type===0n) break;
    entries.push([type,value]);
  }
  return entries;
}

function readPointerArray(pid,address,limit=4096) {
  const values=[];
  for (let index=0; index<limit; index++) {
    const pointer=BigInt.asUintN(64,memory.peek(pid,address+BigInt(index*8)));
    if (pointer===0n) return values;
    values.push(readCString(memory,pid,pointer));
  }
  throw new Error("unterminated tracee pointer array");
}

function prepareExecGuest(pid,mounts,task,state,tasks) {
  const pathname=readCString(memory,pid,getX(state.regs,0));
  let argv=readPointerArray(pid,getX(state.regs,1));
  const env=readPointerArray(pid,getX(state.regs,2));
  const input=pathname.startsWith("/")?posix.normalize(pathname):posix.resolve(task.cwd,pathname);
  const name=posix.basename(input);
  // Two names for one file: the guest-visible pathname, which goes into argv
  // and /proc/<PID>/exe, and the host pathname the loader actually reads.  They
  // differ for an emulated hard link, and an interpreter that resolves its
  // imports next to argv[1] must never be handed /.proot.l2s/objs/<id>.
  let guestPath=canonicalizeGuestPath(mounts,resolveProcLink(pid,tasks,input)??input,
    {preserveInternalFinal:true});
  let executable=mounts.toHost(canonicalizeGuestPath(mounts,guestPath));
  // Flatpak hides almost all bubblewrap options in a NUL-separated --args FD.
  // Android app processes cannot configure loopback after CLONE_NEWNET and
  // the tracer deliberately virtualizes namespace creation, so letting bwrap
  // touch the host network namespace would fail (or mutate it on permissive
  // systems). Expand the FD here and drop exactly --unshare-net. This keeps the
  // guest's stock bwrap executable and needs no wrapper or LD_PRELOAD.
  if (existsSync(executable) &&
      (posix.basename(guestPath)==="bwrap" || posix.basename(guestPath)==="bwrap-real")) {
    const expanded=[];
    for (let index=0; index<argv.length; index++) {
      let fd=null;
      if (argv[index]==="--args" && index+1<argv.length) fd=argv[++index];
      else if (argv[index].startsWith("--args=")) fd=argv[index].slice(7);
      if (fd!==null && /^\d+$/.test(fd)) {
        const hidden=new TextDecoder().decode(readTraceeFd(pid,task,Number(fd))).split("\0");
        if (hidden.at(-1)==="") hidden.pop(); // the terminating NUL is not an argument
        for (let hiddenIndex=hidden.length-1; hiddenIndex>=0; hiddenIndex--)
          if (hidden[hiddenIndex]==="--unshare-net") hidden.splice(hiddenIndex,1);
        expanded.push(...hidden);
      } else expanded.push(argv[index]);
    }
    argv=expanded;
    // Remember bwrap's persistent fd bindings by destination. At mount(2)
    // time the source can be an anonymous /proc/self/fd path whose displayed
    // pathname is not useful; the option list is the stable association and
    // avoids depending on Flatpak's current fd allocation order.
    task.bwrapFdMounts=new Map();
    for (let index=0; index+2<argv.length; index++) {
      if (!["--bind-fd","--ro-bind-fd","--dev-bind-fd"].includes(argv[index])) continue;
      const fd=Number(argv[index+1]);
      if (Number.isInteger(fd)) task.bwrapFdMounts.set(posix.normalize(argv[index+2]),fd);
      index+=2;
    }
  }
  // The PATH a `#!/usr/bin/env NAME` search has to use is the guest's own, and
  // for a nested exec that is whatever envp the tracee is passing along.
  const searchPath=env.find((entry)=>entry.startsWith("PATH="))?.slice(5);
  const script=expandShebang(executable,guestPath,argv,makeGuestPaths(mounts,searchPath,task.cwd));
  if (script!==null) {
    guestPath=canonicalizeGuestPath(mounts,script.guestPath,{preserveInternalFinal:true});
    executable=mounts.toHost(canonicalizeGuestPath(mounts,guestPath));
    argv=script.argv;
  }
  const info=readElfLoadInfo(executable);
  const interpreter=info.interpreter;
  // The sandbox root commonly has /lib -> usr/lib.  Resolve that guest link
  // before translating it; otherwise a perfectly valid glibc loader is looked
  // up in the empty tmpfs placeholder rather than the /usr runtime binding.
  const loader=interpreter===null?null:
    mounts.toHost(canonicalizeGuestPath(mounts,interpreter));
  // Refuse the exec here, while the caller can still let the real execve run
  // and report the error itself.  Once the commit stage has torn down the
  // address space there is nothing left to return an errno to -- and a guest
  // that probes binaries it cannot run is ordinary: npm installs both the
  // glibc and the musl build of a package and tries one of them.
  if (loader!==null && !existsSync(loader))
    throw Object.assign(new Error(`ELF interpreter not found: ${interpreter}`),{code:"ENOENT"});
  return { executable, guestPath, name, interpreter, loader, argv:argv.length?argv:[pathname], env };
}

function buildGuestStack(pid, trampoline, images, guest) {
  // A real execve gives the main thread a stack that grows up to RLIMIT_STACK.
  // This mapping is fixed, so it has to be at least as large as the limit the
  // guest reads back: V8 sizes its stack guard from RLIMIT_STACK, and a node
  // program with a deep enough call graph (npm's CommonJS loader) otherwise
  // runs off the end of a mapping the kernel never grows and takes a SIGSEGV.
  const stackSize=8n*1024n*1024n;
  const stackBase=remoteCall(pid,trampoline,SYS_MMAP,[0n,stackSize,3n,0x22n,-1n,0n]);
  if (stackBase<0n) throw new Error(`guest stack mmap failed: ${stackBase}`);
  const capacity=65536, local=new Uint8Array(capacity), view=new DataView(local.buffer);
  const remoteTop=stackBase+stackSize;
  let cursor=capacity;
  const putString=(value)=>{
    const bytes=new TextEncoder().encode(`${value}\0`); cursor-=bytes.length; local.set(bytes,cursor);
    return remoteTop-BigInt(capacity-cursor);
  };
  const putBytes=(bytes)=>{
    cursor-=bytes.length; local.set(bytes,cursor);
    return remoteTop-BigInt(capacity-cursor);
  };
  const envStrings=guest.env??guestEnvironment();
  // The kernel fills the top of a new stack downwards: AT_RANDOM and
  // AT_PLATFORM, the executable name behind AT_EXECFN, then the environment
  // strings and finally the argument strings -- and each block is copied from
  // its last entry to its first (fs/exec.c:copy_strings), so entry 0 ends up at
  // the lowest address of its block and the whole region ascends with the
  // index.  Emitting the strings in index order instead reverses each block.
  // That looks harmless until something measures the block: libuv takes the
  // process-title buffer as argv[argc-1] + strlen(argv[argc-1]) - argv[0],
  // which is negative on a reversed stack, so a program that assigns
  // process.title -- npm does, on startup -- memset()s from argv[0] upwards
  // until it runs out of address space.
  const putVector=(values)=>{
    const pointers=new Array(values.length);
    for (let index=values.length-1; index>=0; index--) pointers[index]=putString(values[index]);
    return pointers;
  };
  // Pointer-valued auxv entries belong to the old Android bootstrap stack and
  // must never be copied verbatim across an emulated execve.
  const randomBytes=new Uint8Array(16); crypto.getRandomValues(randomBytes);
  const random=putBytes(randomBytes);
  const platform=putString("aarch64");
  const execfn=putString(guest.argv[0]);
  const envPointers=putVector(envStrings);
  const argvPointers=putVector(guest.argv);
  cursor&=~15;
  const replacements=new Map([[3n,images.main.phoff+images.main.mappings[0].address],[4n,BigInt(images.main.phentsize)],
    [5n,BigInt(images.main.phnum)],[7n,images.interpreter?.mappings[0].address??0n],[9n,images.main.entry],
    [15n,platform],[24n,platform],[25n,random],[31n,execfn]]);
  const aux=readAuxv(pid).map(([type,value])=>[type,replacements.get(type)??value]);
  for (const [type,value] of replacements) if (!aux.some(([current])=>current===type)) aux.push([type,value]);
  const words=[BigInt(argvPointers.length),...argvPointers,0n,...envPointers,0n,...aux.flat(),0n,0n];
  cursor-=words.length*8; cursor&=~15;
  words.forEach((word,index)=>view.setBigUint64(cursor+index*8,BigInt.asUintN(64,word),true));
  const remoteSp=remoteTop-BigInt(capacity-cursor);
  writeBytes(memory,pid,remoteSp,local.subarray(cursor));
  return remoteSp;
}

function startGuest(pid, trampoline, images, guest) {
  const sp=buildGuestStack(pid,trampoline,images,guest), state=getRegisters(pid);
  setPc(state.regs,images.interpreter?.entry??images.main.entry);
  state.regs.view.setBigUint64(31*8,sp,true);
  setX(state.regs,0,0n);
  putRegisters(pid,state);
  return sp;
}

// arm64 overrides the asm-generic open(2) flags (arch/arm64/include/uapi/asm/
// fcntl.h): O_NOFOLLOW is 0100000 here, not 0400000.  0x20000 is O_LARGEFILE on
// this architecture, and musl sets it on every open, so reading it as
// O_NOFOLLOW suppressed final-symlink dereferencing for every guest open.
const O_NOFOLLOW = 0x8000n;
// The group upstream translates as SYMLINK when this bit is set: fchownat,
// newfstatat, utimensat and name_to_handle_at (src/syscall/enter.c:2645).
// fchmodat, faccessat and mknodat are not in it -- the kernel does not honour
// the flag for them -- so they stay REGULAR here too.
const AT_SYMLINK_NOFOLLOW = 0x100n;

// Linux arm64 syscall -> pathname registers. Symlink targets are intentionally
// not translated; only the directory entry being created is a host pathname.
const PATH_ARGUMENTS = new Map([
  [33,[{path:1,dirfd:0,deref:false}]], [34,[{path:1,dirfd:0,deref:false}]], [35,[{path:1,dirfd:0,deref:false,preserveL2s:true}]],
  [36,[{path:2,dirfd:1,deref:false,preserveL2s:true}]], [37,[{path:1,dirfd:0,deref:false,preserveL2s:true},{path:3,dirfd:2,deref:false,preserveL2s:true}]],
  [38,[{path:1,dirfd:0,deref:false,preserveL2s:true},{path:3,dirfd:2,deref:false,preserveL2s:true}]], [43,[{path:0}]], [45,[{path:0}]],
  [48,[{path:1,dirfd:0}]], [49,[{path:0}]], [51,[{path:0}]],
  [53,[{path:1,dirfd:0}]], [54,[{path:1,dirfd:0,nofollow:{arg:4,mask:AT_SYMLINK_NOFOLLOW}}]],
  [56,[{path:1,dirfd:0,nofollow:{arg:2,mask:O_NOFOLLOW}}]],
  [78,[{path:1,dirfd:0,deref:false}]],
  [79,[{path:1,dirfd:0,nofollow:{arg:3,mask:AT_SYMLINK_NOFOLLOW}}]],
  [88,[{path:1,dirfd:0,nofollow:{arg:3,mask:AT_SYMLINK_NOFOLLOW}}]],
  [89,[{path:0}]], [276,[{path:1,dirfd:0,deref:false,preserveL2s:true},{path:3,dirfd:2,deref:false,preserveL2s:true}]],
  [281,[{path:1,dirfd:0}]],
  [291,[{path:1,dirfd:0,nofollow:{arg:2,mask:AT_SYMLINK_NOFOLLOW}}]],
  [437,[{path:1,dirfd:0}]], [439,[{path:1,dirfd:0}]],
]);

// Every syscall the enter stage looks at: the pathname table plus the calls
// that are emulated, translated or recorded outright.
const HANDLED_ON_ENTER=new Set([...PATH_ARGUMENTS.keys(),
  SYS_MUNMAP, SYS_GETCWD, SYS_CLOSE, SYS_GETDENTS64, SYS_READLINKAT, SYS_FCHDIR,
  SYS_FCHOWNAT, SYS_FCHOWN,
  SYS_BIND, SYS_CONNECT,
  39,40,41,97,268,       // umount2, mount, pivot_root, unshare, setns
  79, 80, 291,          // fstat, newfstatat, statx
  144,145,146,147,148,149,150,151,152,158,159, // set*id, getres*id, getgroups
  174,175,176,177,      // getuid, geteuid, getgid, getegid
  220,221,435,          // clone, execve, clone3
]);

// Trace only what this port translates and let the kernel run the rest without
// a stop.  The filter is inherited across fork and execve, so it is installed
// once on the bootstrap and every guest afterwards is covered.
function installSyscallFilter(pid,trampoline) {
  if (noSeccomp) return false;
  const { program,length }=buildFilter([...HANDLED_ON_ENTER]);
  const filterAddress=trampoline+3072n;
  const headerAddress=filterAddress+BigInt(program.length);
  if (headerAddress+16n>trampoline+4096n) throw new Error("seccomp filter does not fit the scratch page");
  writeBytes(memory,pid,filterAddress,program);
  writeBytes(memory,pid,headerAddress,buildProgramHeader(length,filterAddress));
  // Without NO_NEW_PRIVS an unprivileged process may not install a filter.
  if (remoteCall(pid,trampoline,SYS_PRCTL,[BigInt(PR_SET_NO_NEW_PRIVS),1n,0n,0n,0n])<0n) return false;
  return remoteCall(pid,trampoline,SYS_PRCTL,
    [BigInt(PR_SET_SECCOMP),BigInt(SECCOMP_MODE_FILTER),headerAddress,0n,0n])===0n;
}

function fdGuestBase(pid,mounts,task,fd) {
  if (fd===-100) return task.cwd;
  const host=readlinkSync(`/proc/${pid}/fd/${fd}`);
  const guest=mounts.toGuest(host);
  // Descriptors for the pass-through kernel trees deliberately point outside
  // the rootfs.  They still name the same absolute path in the guest, and may
  // be used as dirfds for a more-specific explicit binding below that tree.
  if (guest===null && isKernelFilesystem(host)) return host;
  if (guest===null) throw new Error(`dirfd ${fd} points outside the guest namespace: ${host}`);
  return guest;
}

function resolveGuestInput(pid,mounts,task,state,path,spec) {
  return path.startsWith("/")?posix.normalize(path):posix.resolve(
    spec.dirfd===undefined?task.cwd:fdGuestBase(pid,mounts,task,
      Number(BigInt.asIntN(32,getX(state.regs,spec.dirfd)))),path);
}
function resolveGuestPath(pid,mounts,task,state,path,spec) {
  const absolute=resolveGuestInput(pid,mounts,task,state,path,spec);
  const flagSaysNoFollow=spec.nofollow!==undefined &&
    (getX(state.regs,spec.nofollow.arg)&spec.nofollow.mask)!==0n;
  return canonicalizeGuestPath(mounts,absolute,
    {derefFinal:spec.deref!==false&&!flagSaysNoFollow,preserveInternalFinal:spec.preserveL2s===true});
}

function emulateNamespaceFilesystem(pid,mounts,task,state,syscall) {
  if (syscall===40) { // mount(source, target, fstype, flags, data)
    const sourceAddress=getX(state.regs,0), targetAddress=getX(state.regs,1);
    if (targetAddress<4096n) return;
    let target=resolveGuestInput(pid,mounts,task,state,readCString(memory,pid,targetAddress),{});
    const targetFd=/^\/proc\/self\/fd\/(\d+)$/.exec(target);
    let descriptorSourceHost=null;
    if (targetFd!==null) {
      try {
        const targetNumber=Number(targetFd[1]);
        const targetHost=readlinkSync(`/proc/${pid}/fd/${targetNumber}`);
        target=mounts.toGuest(targetHost)??target;
        const stagedRoot=mounts.toHost("/newroot");
        const candidates=readdirSync(`/proc/${pid}/fd`).map(Number)
          .filter((fd)=>Number.isInteger(fd)&&fd>targetNumber).sort((a,b)=>a-b);
        const eligible=[];
        for (const fd of candidates) {
          let candidate;
          try { candidate=readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
          const mountingDev=target==="/newroot/dev" || target.startsWith("/newroot/dev/");
          if (candidate==="/proc" || candidate.startsWith("/proc/") ||
              (!mountingDev && (candidate==="/dev" || candidate.startsWith("/dev/"))) ||
              candidate.startsWith("/memfd:") ||
              candidate.startsWith("pipe:") || candidate.startsWith("socket:") ||
              candidate.startsWith("anon_inode:") || candidate.endsWith(" (deleted)") ||
              candidate===stagedRoot || candidate.startsWith(`${stagedRoot}/`)) continue;
          eligible.push({fd,candidate});
        }
        const bwrapDestination=target==="/newroot"?"/":target.slice("/newroot".length);
        const wantedFd=task.bwrapFdMounts?.get(bwrapDestination);
        const targetName=posix.basename(target);
        const selected=eligible.find(({fd})=>fd===wantedFd)??
          eligible.find(({candidate})=>posix.basename(candidate)===targetName)??eligible[0];
        if (selected) {
          const {fd,candidate}=selected;
          const candidateGuest=mounts.toGuest(candidate);
          const kernelOld=candidateGuest===null?null:/^\/oldroot(\/proc|\/dev|\/sys)(?:\/|$)/.exec(candidateGuest);
          descriptorSourceHost=kernelOld?candidateGuest.slice("/oldroot".length):candidate;
        }
      } catch {}
    }
    const flags=getX(state.regs,3);
    if (verbose) console.error(`[ptrace] pid=${pid} mount source=0x${sourceAddress.toString(16)} target=${target} flags=0x${flags.toString(16)}`);
    if ((flags&0x1000n)!==0n) { // MS_BIND
      if ((flags&0x20n)!==0n) return; // remount only changes flags
      let source=null;
      if (sourceAddress>=4096n) {
        try { source=resolveGuestPath(pid,mounts,task,state,readCString(memory,pid,sourceAddress),{}); }
        catch {}
      }
      const oldKernel=source===null?null:/^\/oldroot(\/proc|\/dev|\/sys)(?:\/|$)/.exec(source);
      let host=oldKernel?source.slice("/oldroot".length):source===null?null:mounts.toHost(source);
      // For bwrap's fd-to-fd form, the opened descriptors are authoritative.
      // Android's outer seccomp SIGSYS frame can expose an unrelated pathname
      // through x0 (observed as both /proc/<pid>/statm and trace_marker).
      if (descriptorSourceHost!==null) host=descriptorSourceHost;
      // Android's seccomp-generated SIGSYS stop can expose a cleared source
      // register for bwrap's /proc/self/fd/N bind.  The immediately preceding
      // O_PATH open is the authoritative source in that form.
      const sourceFd=source===null?null:/^\/proc\/self\/fd\/(\d+)$/.exec(source);
      if (sourceFd!==null) host=task.openedHostFds?.get(Number(sourceFd[1]))??host;
      if (source===null && task.lastExternalSourceHost) host=task.lastExternalSourceHost;
      if (target==="/newroot" && task.lastExternalSourceHost) host=task.lastExternalSourceHost;
      if (host===null) return;
      // --bind-data/--ro-bind-data stages an ordinary /bindfileXXXXXX and
      // unlinks it immediately after mount(2). A real mount pins the inode;
      // an emulated pathname binding must make its own stable snapshot first.
      if (/\/bindfile[^/]+$/.test(host)) {
        try {
          const snapshotDir=mkdtempSync(posix.join(process.env.TMPDIR??tmpdir(),
            "bunproot-bind-data-"));
          const snapshot=posix.join(snapshotDir,"payload");
          copyFileSync(host,snapshot);
          host=snapshot;
        } catch {}
      }
      if (target.startsWith("/proc/self/fd/")) return;
      mounts.bind(host,target);
      if (verbose) console.error(`[ptrace] pid=${pid} emulated bind ${source??"<fd>"} (${host}) -> ${target}`);
    } else {
      const fstypeAddress=getX(state.regs,2);
      const fstype=fstypeAddress>=4096n?readCString(memory,pid,fstypeAddress):"";
      const host=fstype==="tmpfs"
        ?mkdtempSync(posix.join(process.env.TMPDIR??tmpdir(),"bunproot-tmpfs-"))
        :{proc:"/proc",sysfs:"/sys",devtmpfs:"/dev",devpts:"/dev/pts"}[fstype];
      if (host) {
        mounts.bind(host,target);
        if (verbose) console.error(`[ptrace] pid=${pid} emulated ${fstype} ${host} -> ${target}`);
      }
    }
    return;
  }
  if (syscall===41) { // pivot_root(new_root, put_old)
    const newRoot=resolveGuestInput(pid,mounts,task,state,readCString(memory,pid,getX(state.regs,0)),{});
    const oldArg=readCString(memory,pid,getX(state.regs,1));
    const oldAbsolute=oldArg.startsWith("/")?oldArg:posix.resolve(newRoot,oldArg);
    const putOld=oldArg===readCString(memory,pid,getX(state.regs,0))?null:
      (oldAbsolute===newRoot?"/":oldAbsolute.startsWith(`${newRoot}/`)
        ?oldAbsolute.slice(newRoot.length):oldAbsolute);
    mounts.pivot(newRoot,putOld);
    task.pivoted=true;
    task.cwd=task.cwd===newRoot?"/":task.cwd.startsWith(`${newRoot}/`)?task.cwd.slice(newRoot.length):task.cwd;
    if (verbose) console.error(`[ptrace] pid=${pid} emulated pivot_root ${newRoot} -> /`);
    return;
  }
  if (syscall===39) { // umount2(target, flags)
    const address=getX(state.regs,0);
    if (address>=4096n) {
      const target=resolveGuestInput(pid,mounts,task,state,readCString(memory,pid,address),{});
      mounts.unbind(target);
    }
  }
}

function isKernelFilesystem(path) {
  return ["/proc","/dev","/sys"].some((prefix)=>path===prefix||path.startsWith(`${prefix}/`));
}

// Kernel filesystems normally stay in the host namespace, but an explicit
// binding below /proc, /dev or /sys must still win.  enter_rootfs uses this
// for Android's unreadable overflowuid/overflowgid sysctls, and upstream
// PRoot likewise resolves the most-specific binding before its /proc special
// handling.
function hasKernelFilesystemBinding(mounts,path) {
  return mounts.entries.some(({guest})=>guest!=="/" &&
    (path===guest || path.startsWith(`${guest}/`)));
}

// writeBytes() stores whole 8-byte words. A readlink(2) result lands in a
// caller-sized buffer, so the trailing partial word has to keep whatever the
// tracee already had there instead of being zero-filled past the limit.
function writeTraceeBytes(pid,address,bytes,capacity) {
  const aligned=bytes.length&~7;
  if (aligned>0) writeBytes(memory,pid,address,bytes.subarray(0,aligned));
  if (bytes.length===aligned) return;
  const base=address+BigInt(aligned), merged=new Uint8Array(8);
  if (BigInt(aligned+8)>capacity) {
    const existing=BigInt.asUintN(64,memory.peek(pid,base));
    for (let index=0; index<8; index++) merged[index]=Number((existing>>BigInt(index*8))&0xffn);
  }
  merged.set(bytes.subarray(aligned),0);
  writeBytes(memory,pid,base,merged);
}

function readTraceeBytes(pid,address,length) {
  const direct=memory.read(pid,address,length);
  if (direct!==null && direct.length===length) return direct;
  const output=new Uint8Array(length);
  for (let offset=0; offset<length; offset+=8) {
    const word=BigInt.asUintN(64,memory.peek(pid,address+BigInt(offset)));
    for (let byte=0; byte<8 && offset+byte<length; byte++)
      output[offset+byte]=Number((word>>BigInt(byte*8))&0xffn);
  }
  return output;
}

function readTraceeFd(pid,task,fd,limit=1024*1024) {
  const original=remoteCall(pid,task.trampoline,SYS_LSEEK,[BigInt(fd),0n,1n]);
  if (remoteCall(pid,task.trampoline,SYS_LSEEK,[BigInt(fd),0n,0n])<0n)
    throw new Error(`cannot seek tracee fd ${fd}`);
  const chunks=[];
  let total=0;
  try {
    while (total<limit) {
      const amount=Number(remoteCall(pid,task.trampoline,SYS_READ,
        [BigInt(fd),task.scratch,2048n]));
      if (amount<=0) break;
      chunks.push(readTraceeBytes(pid,task.scratch,amount));
      total+=amount;
    }
  } finally {
    if (original>=0n) remoteCall(pid,task.trampoline,SYS_LSEEK,[BigInt(fd),original,0n]);
  }
  const output=new Uint8Array(total);
  let offset=0;
  for (const chunk of chunks) { output.set(chunk,offset); offset+=chunk.length; }
  return output;
}

// The kernel reports a descriptor opened through an emulated hard link under
// the storage name no tracee ever used, so remember the name the tracee did
// use.  Upstream does the same in link2symlink's READLINK_PROC_FD callback
// (src/extension/link2symlink/link2symlink.c:readlink_proc_fd).
const L2S_OBJS="/.proot.l2s/objs/";
const openedAliases=new Map();

function recallOpenedAlias(mounts,procFd,objectGuest) {
  const accept=(alias)=>{
    if (alias===undefined) return null;
    // Descriptor numbers are reused and links are removed, so the remembered
    // name still has to lead to this very object.
    try {
      const resolved=canonicalizeGuestPath(mounts,alias);
      return mounts.toHost(resolved)===mounts.toHost(objectGuest)?alias:null;
    }
    catch { return null; }
  };
  if (procFd!==null) {
    const exact=accept(openedAliases.get(`${procFd.pid}:${procFd.fd}`));
    if (exact!==null) return exact;
  }
  // Threads share one descriptor table while being tracked as separate tasks,
  // so the opener is not necessarily the reader. Any remembered name that
  // still resolves to this object names the same file.
  for (const alias of openedAliases.values()) {
    const value=accept(alias);
    if (value!==null) return value;
  }
  return null;
}

function guestPathOf(mounts,hostPath) {
  return mounts.toGuest(hostPath)??hostPath;
}

// Upstream substitutes "/proc/<PID>/{exe,cwd,root}" with tracee->exe,
// tracee->fs->cwd and get_root() (path/proc.c:readlink_proc). Here the
// substitution is mandatory rather than cosmetic: the guest image is mapped in
// by the loader instead of being execve()d, so the kernel still reports the
// Android bootstrap binary -- /apex/com.android.runtime/bin/linker64 -- as the
// process executable. Anything that re-executes itself through
// /proc/self/exe (bun x re-running itself as `node`) would otherwise exec a
// host path that does not exist inside the guest namespace.
const PROC_LINK=/^\/proc\/(self|thread-self|\d+)\/(exe|cwd|root)$/;
const PROC_FD_LINK=/^\/proc\/(self|thread-self|\d+)\/fd\/(\d+)$/;
function resolveProcLink(taskPid,tasks,guestPath) {
  if (!guestPath.startsWith("/proc/")) return null;
  const match=PROC_LINK.exec(posix.normalize(guestPath));
  if (match===null) return null;
  const owner=match[1]==="self"||match[1]==="thread-self"?taskPid:Number(match[1]);
  const known=tasks.get(owner);
  if (known===undefined) return null;
  if (match[2]==="root") return "/";
  if (match[2]==="cwd") return known.cwd;
  return known.exe??null;
}

export function traceProcess(pid, mounts, guest = null, { killOnExit = false } = {}) {
  const started=performance.now();
  const mountinfoPaths=new Set();
  const mountinfoPathFor=(taskPid)=>{
    const path=posix.join(process.env.TMPDIR??tmpdir(),`.bunproot-mountinfo-${pid}-${taskPid}`);
    mountinfoPaths.add(path);
    return path;
  };
  const initial = wait(pid, 2); // WUNTRACED: observe the pre-exec SIGSTOP.
  if ((initial & 0xff) !== 0x7f) throw new Error("tracee did not stop before exec");
  if (call(PTRACE_ATTACH, pid) < 0n) throw new Error("PTRACE_ATTACH failed");
  wait(pid);
  // TRACESYSGOOD distinguishes syscall stops; EXITKILL prevents a bootstrap
  // loop from surviving if the Bun tracer crashes or is interrupted.
  if (call(PTRACE_SETOPTIONS, pid, 0n, 0x10008fn) < 0n) throw new Error("PTRACE_SETOPTIONS failed");
  if (verbose && guest !== null)
    console.error(`[ptrace] bootstrap pid=${pid} executable=${guest.executable} interpreter=${guest.interpreter ?? "static"}`);
  let trampoline = initializeRemoteSyscalls(pid);
  if (verbose)
    console.error(`[ptrace] remote getpid=${pid}; trampoline mmap=0x${trampoline.toString(16)}`);
  const images = loadGuestImages(pid, trampoline, guest);
  if (verbose)
    console.error(`[ptrace] mapped guest entry=0x${images.main.entry.toString(16)} interpreter entry=${images.interpreter ? `0x${images.interpreter.entry.toString(16)}` : "static"}`);
  resetGuestSignals(pid,trampoline);
  if (guest!==null) setGuestName(pid,trampoline,guest.name??posix.basename(guest.executable));
  setKernelRootCwd(pid,trampoline,mounts.rootfs);
  const filtering=installSyscallFilter(pid,trampoline);
  // Without a filter every syscall has to be stopped to find the few that
  // matter, which is correct but costs two stops per syscall.
  const restartRequest=filtering?PTRACE_CONT:PTRACE_SYSCALL;
  if (verbose) console.error(`[ptrace] syscall filter ${filtering?"installed":"unavailable; stopping on every syscall"}`);
  const guestSp=startGuest(pid,trampoline,images,guest);
  if (verbose) console.error(`[ptrace] guest sp=0x${guestSp.toString(16)}`);
  let nextScratchSlot=1n;
  const freeScratchSlots=[];
  const tasks=new Map([[pid,{ entering:true, pendingSignal:0n, pendingExec:null,
    pendingCwd:null, pendingGetcwd:null, cwd:"/", configured:true, seenStop:true,
    openedHostFds:new Map(), openedGuestFds:new Map(), mounts,
    scratch:trampoline+4096n+512n, scratchSlot:1n,
    exe:guest===null?null:guest.guestPath??guestPathOf(mounts,guest.executable) }]]);
  tasks.get(pid).trampoline=trampoline;
  tasks.get(pid).borrowPc=images.interpreter?.entry??images.main.entry;
  const deleteTask=(taskPid)=>{
    const removed=tasks.get(taskPid);
    if (removed?.scratchSlot!==undefined) freeScratchSlots.push(removed.scratchSlot);
    tasks.delete(taskPid);
  };
  let rootExit=1;
  traceLoop: while (tasks.size>0) {
    for (const [taskPid,task] of tasks) {
      // A new tracee is restartable only once both halves have arrived: the
      // parent's fork event, which carries the cwd and scratch page it
      // inherits, and its own first stop. They race, either can be reaped
      // first, and restarting before the stop fails with ESRCH -- which used
      // to be read as "the tracee died" and dropped it, leaving a shell's
      // pipeline hung about one run in ten.
      if (!task.configured || !task.seenStop) continue;
      if (!task.running) {
        if (call(task.restart??restartRequest,taskPid,0n,task.pendingSignal)<0n) {
          // Match upstream restart_tracee(): a task can die after its last
          // wait status but before the tracer restarts it. This is a normal
          // lifecycle race, especially for Git's short-lived helpers.
          deleteTask(taskPid);
          if (verbose)
            console.error(`[ptrace] tracee ${taskPid} disappeared before restart`);
          continue;
        }
        task.pendingSignal=0n; task.restart=undefined; task.running=true;
      }
    }
    const result=timed("wait",()=>waitResult(-1)), taskPid=result.pid, status=result.status;
    count("stops");
    let task=tasks.get(taskPid);
    if (!task) {
      // The new tracee's own stop and its parent's PTRACE_EVENT_FORK race, and
      // either can be reaped first. Dropping the stop leaves the tracee in
      // ptrace-stop forever, because nothing else ever restarts it -- an
      // intermittent hang whenever a shell builds a pipeline. Upstream creates
      // the tracee on first sight instead (get_tracee(NULL, pid, true),
      // src/tracee/event.c:417); the parent's event fills in the rest.
      task={ entering:true, pendingSignal:0n, pendingExec:null, pendingCwd:null,
        pendingGetcwd:null, cwd:"/", exe:null, running:false, configured:false, seenStop:false };
      tasks.set(taskPid,task);
      if (verbose) console.error(`[ptrace] tracee ${taskPid} stopped before its parent's fork event`);
    }
    task.running=false;
    task.seenStop=true;
    mounts=task.mounts;
    if ((status&0x7f)===0) {
      if (verbose) console.error(`[ptrace] tracee ${taskPid} exited status=${(status>>8)&0xff}`);
      if (taskPid===pid && killOnExit) {
        rootExit=(status>>8)&0xff;
        if (verbose && tasks.size>1)
          console.error(`[ptrace] root tracee exited; tracer exit will kill ${tasks.size-1} remaining task(s)`);
        break traceLoop;
      }
      deleteTask(taskPid); continue;
    }
    if ((status&0x7f)!==0x7f) {
      const terminatingSignal=status&0x7f;
      if (verbose) console.error(`[ptrace] tracee ${taskPid} terminated signal=${terminatingSignal}`);
      if (taskPid===pid && killOnExit) {
        rootExit=128+terminatingSignal;
        if (verbose && tasks.size>1)
          console.error(`[ptrace] root tracee terminated; tracer exit will kill ${tasks.size-1} remaining task(s)`);
        break traceLoop;
      }
      deleteTask(taskPid); continue;
    }
    const signal=(status>>8)&0xff, event=status>>>16;
    const seccompStop=signal===5 && event===PTRACE_EVENT_SECCOMP;
    if (signal!==0x85 && !seccompStop) {
      if (signal===5 && event>=1 && event<=3) {
        const child=eventMessage(taskPid);
        // This event does not mean the child has stopped yet, only that it
        // exists. Its own stop is reported separately and may be reaped either
        // side of this one, so record what it inherits and let the restart
        // loop wait for the stop.
        const scratchSlot=freeScratchSlots.pop()??++nextScratchSlot;
        if (scratchSlot*4096n>=TRAMPOLINE_REGION_SIZE) throw new Error("tracee scratch space exhausted");
        const inherited={ pendingExec:null, pendingCwd:null, pendingGetcwd:null,
          cwd:task.cwd, exe:task.exe, trampoline:task.trampoline, borrowPc:task.borrowPc,
          scratch:task.trampoline+scratchSlot*4096n+512n, scratchSlot, configured:true,
          namespaceEmulated:task.namespaceEmulated, pivoted:task.pivoted };
        inherited.usernsLimitFaked=task.usernsLimitFaked;
        inherited.usernsAfterLimit=task.usernsAfterLimit;
        inherited.openedHostFds=new Map(task.openedHostFds??[]);
        inherited.openedGuestFds=new Map(task.openedGuestFds??[]);
        inherited.bwrapFdMounts=new Map(task.bwrapFdMounts??[]);
        inherited.mounts=task.pendingChildMountNamespace?task.mounts.clone():task.mounts;
        task.pendingChildMountNamespace=false;
        // The child may already be tracked, having stopped before this event
        // arrived; then it is only missing what it could not know, and its own
        // run state is the accurate one.
        const existing=tasks.get(child);
        if (existing) Object.assign(existing,inherited);
        else tasks.set(child,{ entering:true, pendingSignal:0n, running:false, seenStop:false, ...inherited });
        if (verbose) console.error(`[ptrace] new tracee pid=${child} event=${event}`);
        continue;
      }
      // A tracee can die between its wait status and this fetch -- firefox's
      // crash handler re-raises, and the process is gone by the time the
      // signal is inspected. Upstream treats that as an ordinary lifecycle
      // race in restart_tracee(); here it must not take the tracer with it.
      let stopped;
      try { stopped=getRegisters(taskPid); }
      catch {
        deleteTask(taskPid);
        if (verbose) console.error(`[ptrace] tracee ${taskPid} died before its signal could be read`);
        continue;
      }
      if (verbose)
        console.error(`[ptrace] pid=${taskPid} signal=${signal} pc=0x${getPc(stopped.regs).toString(16)} syscall=${getSyscallNumber(stopped.regs)}${describeFault(taskPid,signal,getPc(stopped.regs),getX(stopped.regs,30))}`);
      if (signal===31 && [39,40,41,97,268].includes(getSyscallNumber(stopped.regs))) {
        // Android's platform seccomp can reject namespace syscalls before our
        // SECCOMP_RET_TRACE filter gets an entry stop.  A consumed SIGSYS is
        // already past the svc instruction, so supply the emulated success
        // directly, matching the normal handled-on-enter path below.
        const blockedSyscall=getSyscallNumber(stopped.regs);
        if (blockedSyscall===97 && (getX(stopped.regs,0)&0x10000000n)!==0n &&
            task.usernsLimitFaked && ++task.usernsAfterLimit>1) {
          setX(stopped.regs,0,BigInt.asUintN(64,-1n)); putRegisters(taskPid,stopped);
          task.entering=true;
          continue;
        }
        task.namespaceEmulated=true;
        if (blockedSyscall===97 && (getX(stopped.regs,0)&0x20000n)!==0n) {
          task.mounts=task.mounts.clone();
          mounts=task.mounts;
        }
        if ([39,40,41].includes(blockedSyscall))
          emulateNamespaceFilesystem(taskPid,mounts,task,stopped,blockedSyscall);
        setX(stopped.regs,0,0n); putRegisters(taskPid,stopped);
        task.entering=true;
        continue;
      }
      if (signal===31 && getSyscallNumber(stopped.regs)===439) { // faccessat2
        // This syscall is absent from older Android allowlists. Its SIGSYS
        // frame is already past svc, so perform the access check against the
        // translated guest pathname and place the result straight in x0.
        let result=0n;
        try {
          const path=readCString(memory,taskPid,getX(stopped.regs,1));
          const guestPath=resolveGuestPath(taskPid,mounts,task,stopped,path,
            {dirfd:0,nofollow:{arg:3,mask:0x100n}});
          accessSync(mounts.toHost(guestPath),Number(getX(stopped.regs,2)));
        } catch (error) { result=BigInt(error.errno??-13); }
        setX(stopped.regs,0,BigInt.asUintN(64,result)); putRegisters(taskPid,stopped);
        task.entering=true;
        continue;
      }
      // Android's app seccomp reports blocked syscalls as SIGSYS.  A guest
      // with the default disposition needs ENOSYS so libc can fall back, but
      // sandboxes such as Firefox's deliberately install a SIGSYS handler to
      // broker the syscall.  Let that handler see the signal.
      if (signal===31 && !catchesSignal(taskPid,signal)) {
        setX(stopped.regs,0,BigInt.asUintN(64,-38n)); putRegisters(taskPid,stopped); continue;
      }
      if (signal===19) continue; // consume ptrace/vfork bootstrap SIGSTOP
      task.pendingSignal=BigInt(signal); continue;
    }
    const phase=timed("syscallPhase",()=>syscallInfo(taskPid));
    // Registers are only needed by the syscalls this tracer actually handles;
    // for the overwhelming majority the info block above is the whole story.
    let fetched=null;
    const registers=()=>fetched??=getRegisters(taskPid);
    const isExit=!seccompStop && (phase===2 || (phase===0 && !task.entering));
    if (isExit) {
      task.entering=true;
      if (task.forcedResult!==undefined) {
        const exited=registers();
        setX(exited.regs,0,task.forcedResult); putRegisters(taskPid,exited);
        task.forcedResult=undefined;
      }
      if (task.idWrites!==undefined) {
        // A uid_t is four bytes and PTRACE_POKEDATA writes eight, so these
        // must go through the read-modify-write path or each one zeroes the
        // four bytes after it. getresuid(2) is handed three adjacent locals,
        // which puts the third write past the end of them: GTK's
        // check_setugid() calls it, and the overrun tripped the stack
        // protector before any window could open.
        for (const address of task.idWrites) if (address!==0n)
          writeTraceeBytes(taskPid,address,new Uint8Array(4),4n);
        task.idWrites=undefined;
      }
      if (task.pendingStat!==undefined) {
        const exited=registers();
        if (BigInt.asIntN(64,getX(exited.regs,0))===0n) {
          const { buffer,kind }=task.pendingStat;
          const uidOffset=kind==="statx"?20n:24n;
          writeBytes(memory,taskPid,buffer+uidOffset,new Uint8Array(8));
          if (task.pendingStat.nlink!==undefined) {
            const count=new Uint8Array(4);
            new DataView(count.buffer).setUint32(0,Number(task.pendingStat.nlink),true);
            writeBytes(memory,taskPid,buffer+(kind==="statx"?16n:20n),count);
          }
        }
        task.pendingStat=undefined;
      }
      if (task.pendingGetdents!==undefined) {
        // stat(2) already reports an emulated hard link as the regular file it
        // stands for, but getdents64(2) hands out the raw directory entry, so
        // the symlink leaks as DT_LNK. Readers that trust d_type instead of
        // stat()ing -- bun's package installer walking its own cache -- then
        // skip every emulated file.
        const { fd,buffer,size }=task.pendingGetdents;
        task.pendingGetdents=undefined;
const exited=registers(), result=exitResult(phase,exited);
        let directory=null;
        if (result>0n) { try { directory=readlinkSync(`/proc/${taskPid}/fd/${fd}`); } catch {} }
        if (directory!==null && mounts.toGuest(directory)!==null) {
          count("getdents");
          count("getdentsBytes",Number(result));
          const bytes=timed("getdents",()=>readTraceeBytes(taskPid,buffer,Number(result)));
          const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
          let rewritten=false;
          for (let offset=0; offset+19<=bytes.length; ) {
            const reclen=view.getUint16(offset+16,true); // struct linux_dirent64.d_reclen
            if (reclen<19 || offset+reclen>bytes.length) break;
            if (bytes[offset+18]===DT_LNK) {
              count("getdentsLinks");
              let end=offset+19;
              while (end<offset+reclen && bytes[end]!==0) end++;
              const name=new TextDecoder().decode(bytes.subarray(offset+19,end));
              if (timed("getdentsAlias",()=>isEmulatedAlias(mounts.rootfs,`${directory}/${name}`))) { bytes[offset+18]=DT_REG; rewritten=true; }
            }
            offset+=reclen;
          }
          if (rewritten) writeTraceeBytes(taskPid,buffer,bytes,size);
        }
      }
      if (task.pendingReadlink!==undefined) {
        const { buffer,size,value,procFd }=task.pendingReadlink;
        task.pendingReadlink=undefined;
        const exited=registers();
        if (value!==null) {
          // The substituted syscall never ran, so produce readlinkat(2)'s own
          // result: the target is copied without a terminating NUL and the
          // return value is the number of bytes that fit.
          const encoded=new TextEncoder().encode(value);
          if (size===0n) setX(exited.regs,0,BigInt.asUintN(64,-22n)); // EINVAL
          else {
            const length=Math.min(encoded.length,Number(size));
            writeTraceeBytes(taskPid,buffer,encoded.subarray(0,length),size);
            setX(exited.regs,0,BigInt(length));
          }
          putRegisters(taskPid,exited);
        } else {
          // Detranslate a host target the kernel reported, e.g. through
          // /proc/<PID>/fd/<FD>, back into the guest namespace.
          const result=BigInt.asIntN(64,getX(exited.regs,0));
          if (result>0n) {
            const host=new TextDecoder().decode(readTraceeBytes(taskPid,buffer,Number(result)));
            if (mounts.toGuest(host)!==null) {
              let guest=guestPathOf(mounts,host);
              if (guest.startsWith(L2S_OBJS))
                guest=recallOpenedAlias(mounts,procFd,guest)??guest;
              const encoded=new TextEncoder().encode(guest);
              const length=Math.min(encoded.length,Number(size));
              writeTraceeBytes(taskPid,buffer,encoded.subarray(0,length),size);
              setX(exited.regs,0,BigInt(length)); putRegisters(taskPid,exited);
              if (verbose)
                console.error(`[ptrace] pid=${taskPid} readlink target ${host} -> ${guest}`);
            }
          }
        }
      }
      if (task.pendingPathSyscall!==undefined) {
const exited=registers(), result=exitResult(phase,exited);
        let finalResult=result;
        if (task.pendingOpenAlias!==undefined) {
          if (result>=0n) openedAliases.set(`${taskPid}:${result}`,task.pendingOpenAlias);
          task.pendingOpenAlias=undefined;
        }
        if (task.pendingPathSyscall===SYS_OPENAT && result>=0n && task.pendingHostPaths?.length) {
          task.openedHostFds.set(Number(result),task.pendingHostPaths[0]);
          if (task.pendingGuestPaths?.length)
            task.openedGuestFds.set(Number(result),task.pendingGuestPaths[0]);
        }
        if (task.pendingL2sUnlink && result===0n) {
          try { commitEmulatedUnlink(mounts.rootfs,task.pendingL2sUnlink); }
          catch (error) {
            if (verbose)
              console.error(`[ptrace] pid=${taskPid} link2symlink unlink cleanup failed: ${error.message}`);
          }
        }
        if (task.pendingL2sRename && result===0n) {
          try {
            const rename=task.pendingL2sRename;
            commitEmulatedRename(mounts.rootfs,rename.source,rename.targetHost,rename.targetGuest,rename.replaced);
          } catch (error) {
            if (verbose)
              console.error(`[ptrace] pid=${taskPid} link2symlink rename cleanup failed: ${error.message}`);
          }
        }
        if (task.pendingL2sDirectoryRename && result===0n) {
          try {
            const rename=task.pendingL2sDirectoryRename;
            commitEmulatedDirectoryRename(mounts.rootfs,rename.sourceGuest,rename.targetGuest);
          } catch (error) {
            if (verbose)
              console.error(`[ptrace] pid=${taskPid} link2symlink directory rename cleanup failed: ${error.message}`);
          }
        }
        if (task.pendingPathSyscall===37 && result===-13n && task.pendingLinkPaths?.length===2) {
          try {
            const emulated=emulateHardLink(mounts.rootfs,task.pendingLinkPaths[0],task.pendingLinkPaths[1],
              task.pendingLinkGuestPaths?.[0],task.pendingLinkGuestPaths?.[1]);
            if (!emulated) copyFileSync(task.pendingLinkPaths[0],task.pendingLinkPaths[1],fsConstants.COPYFILE_EXCL);
            setX(exited.regs,0,0n); putRegisters(taskPid,exited); finalResult=0n;
            if (verbose)
              console.error(`[ptrace] pid=${taskPid} linkat EACCES -> ${emulated?"link2symlink":"exclusive copy"} fallback`);
          } catch (error) {
            finalResult=BigInt(error.errno??-13);
            if (verbose)
              console.error(`[ptrace] pid=${taskPid} linkat fallback failed: ${error.message}; paths=${task.pendingLinkPaths.join(" -> ")}`);
            setX(exited.regs,0,BigInt.asUintN(64,finalResult)); putRegisters(taskPid,exited);
          }
        }
        if (task.pendingPathSyscall===34 && finalResult<0n && task.namespaceEmulated &&
            task.pendingHostPaths?.length && existsSync(task.pendingHostPaths[0])) {
          setX(exited.regs,0,0n); putRegisters(taskPid,exited); finalResult=0n;
        }
        if (finalResult<0n && verbose)
          console.error(`[ptrace] pid=${taskPid} syscall=${task.pendingPathSyscall} result=${finalResult}`+
            (task.pendingPaths?.length?` paths=${task.pendingPaths.join(" -> ")}`:""));
        task.pendingPathSyscall=undefined;
        task.pendingPaths=undefined;
        task.pendingHostPaths=undefined;
        task.pendingGuestPaths=undefined;
        task.pendingLinkPaths=undefined;
        task.pendingLinkGuestPaths=undefined;
        task.pendingL2sUnlink=undefined;
        task.pendingL2sRename=undefined;
        task.pendingL2sDirectoryRename=undefined;
      }
      if (task.pendingCwd!==null || task.pendingGetcwd!==null) {
const exited=registers(), result=exitResult(phase,exited);
        if (task.pendingCwd!==null) {
          if (result===0n) task.cwd=task.pendingCwd;
          task.pendingCwd=null;
        }
        if (task.pendingGetcwd!==null) {
          if (result>0n) {
            const hostCwd=readCString(memory,taskPid,task.pendingGetcwd.buffer);
            const guestCwd=mounts.toGuest(hostCwd)??hostCwd;
            const encoded=new TextEncoder().encode(`${guestCwd}\0`);
            if (BigInt(encoded.length)<=task.pendingGetcwd.size) {
              writeBytes(memory,taskPid,task.pendingGetcwd.buffer,encoded);
              setX(exited.regs,0,encoded.length); putRegisters(taskPid,exited);
            }
          }
          task.pendingGetcwd=null;
        }
      }
      if (task.pendingExec!==null) {
        const next=task.pendingExec; task.pendingExec=null;
        if (verbose) console.error(`[ptrace] pid=${taskPid} emulating execve ${next.argv.join(" ")}`);
        if (!isMapped(taskPid,task.trampoline)) {
          task.trampoline=allocateRemoteSyscalls(taskPid,task.borrowPc);
          task.scratch=task.trampoline+4096n+512n;
          if (verbose)
            console.error(`[ptrace] pid=${taskPid} renewed trampoline=0x${task.trampoline.toString(16)}`);
        }
        closeExecDescriptors(taskPid,task.trampoline);
        resetGuestSignals(taskPid,task.trampoline);
        resetExecAddressSpace(taskPid,task.trampoline);
        const nextImages=loadGuestImages(taskPid,task.trampoline,next);
        startGuest(taskPid,task.trampoline,nextImages,next);
        setGuestName(taskPid,task.trampoline,next.name);
        task.borrowPc=nextImages.interpreter?.entry??nextImages.main.entry;
        task.exe=next.guestPath??guestPathOf(mounts,next.executable);
      }
      continue;
    }
    task.entering=false;
    const syscall=(phase===1||phase===3)?syscallInfoNumber():getSyscallNumber(registers().regs);
    // Nothing to do for a syscall this tracer does not translate, and by far
    // the most syscalls a guest makes are of that kind: reading the registers
    // for every one of them was the single biggest cost per stop.
    if (!HANDLED_ON_ENTER.has(syscall)) continue;
    count("handled");
    // A seccomp stop is the entry stop; ask for this syscall's exit stop too,
    // then fall back to running free until the filter traps the next one.
    if (seccompStop) task.restart=PTRACE_SYSCALL;
    const state=registers();
    if ([39,40,41,97,268].includes(syscall)) {
      // Android denies unprivileged namespaces and mounts.  Like the upstream
      // Android PRoot branch, keep bwrap's setup state machine moving while
      // pathname isolation remains enforced by this tracer's runtime binding
      // table, including mount/pivot/umount transitions.
      task.namespaceEmulated=true;
      if (syscall===97 && (getX(state.regs,0)&0x10000000n)!==0n &&
          task.usernsLimitFaked && ++task.usernsAfterLimit>1) {
        setKernelSyscallNumber(taskPid,state,SYS_GETPID);
        task.forcedResult=BigInt.asUintN(64,-1n);
        continue;
      }
      if (syscall===97 && (getX(state.regs,0)&0x20000n)!==0n) {
        task.mounts=task.mounts.clone();
        mounts=task.mounts;
      }
      if ([39,40,41].includes(syscall)) emulateNamespaceFilesystem(taskPid,mounts,task,state,syscall);
      setKernelSyscallNumber(taskPid,state,SYS_GETPID);
      task.forcedResult=0n;
      continue;
    }
    if (syscall===SYS_BIND || syscall===SYS_CONNECT) {
      // Unlike ordinary pathname syscalls, AF_UNIX carries its pathname in a
      // sockaddr.  The kernel never sees openat-style path translation for
      // these, so sockets created in a rootfs would otherwise be attempted at
      // Android's literal /tmp and rejected by SELinux.  Abstract sockets have
      // a leading NUL and deliberately remain in the host namespace.
      const address=getX(state.regs,1), supplied=Number(getX(state.regs,2));
      if (address>=4096n && supplied>=3) {
        const bytes=readTraceeBytes(taskPid,address,Math.min(supplied,110));
        const family=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(0,true);
        if (family===1 && bytes[2]!==0) { // AF_UNIX, pathname rather than abstract
          let end=2;
          while (end<bytes.length && bytes[end]!==0) end++;
          const pathname=new TextDecoder().decode(bytes.subarray(2,end));
          const guestPath=pathname.startsWith("/")?posix.normalize(pathname):posix.resolve(task.cwd,pathname);
          const host=mounts.toHost(guestPath);
          const encoded=new TextEncoder().encode(host);
          if (encoded.length>107) {
            setKernelSyscallNumber(taskPid,state,SYS_GETPID);
            task.forcedResult=BigInt.asUintN(64,-36n); // ENAMETOOLONG
          } else {
            const translated=new Uint8Array(2+encoded.length+1);
            new DataView(translated.buffer).setUint16(0,1,true);
            translated.set(encoded,2);
            writeBytes(memory,taskPid,task.scratch,translated);
            setX(state.regs,1,task.scratch);
            setX(state.regs,2,BigInt(translated.length));
            putRegisters(taskPid,state);
            if (verbose) console.error(`[ptrace] pid=${taskPid} unix socket ${pathname} -> ${host}`);
          }
        }
      }
      continue;
    }
    if (syscall===SYS_MUNMAP) {
      const start=getX(state.regs,0), end=start+getX(state.regs,1);
      const protectedEnd=task.trampoline+TRAMPOLINE_REGION_SIZE;
      if (start<protectedEnd && end>task.trampoline) {
        // The injected loader is process infrastructure, not guest memory.
        // Pretend an overlapping munmap succeeded while keeping it available
        // for later exec replacement and pathname scratch storage.
        setKernelSyscallNumber(taskPid,state,SYS_GETPID);
        task.forcedResult=0n;
        continue;
      }
    }
    if (syscall>=174 && syscall<=177) {
      setKernelSyscallNumber(taskPid,state,SYS_GETPID);
      task.forcedResult=0n;
      continue;
    }
    if ([144,145,146,147,149,151,152,159].includes(syscall)) {
      setKernelSyscallNumber(taskPid,state,SYS_GETPID);
      task.forcedResult=0n;
      continue;
    }
    if (syscall===148 || syscall===150) { // getresuid/getresgid
      setKernelSyscallNumber(taskPid,state,SYS_GETPID);
      task.idWrites=[getX(state.regs,0),getX(state.regs,1),getX(state.regs,2)];
      task.forcedResult=0n;
      continue;
    }
    if (syscall===158) { // getgroups
      const size=getX(state.regs,0);
      setKernelSyscallNumber(taskPid,state,SYS_GETPID);
      task.idWrites=size>0n?[getX(state.regs,1)]:[];
      task.forcedResult=1n;
      continue;
    }
    if (syscall===79) task.pendingStat={buffer:getX(state.regs,2),kind:"stat"};
    if (syscall===80) {
      task.pendingStat={buffer:getX(state.regs,1),kind:"stat"};
      try {
        const object=inspectEmulatedObject(mounts.rootfs,readlinkSync(`/proc/${taskPid}/fd/${Number(getX(state.regs,0))}`));
        if (object) task.pendingStat.nlink=object.nlink;
      } catch {}
    }
    if (syscall===291) task.pendingStat={buffer:getX(state.regs,4),kind:"statx"};
    if (syscall===SYS_GETCWD) {
      task.pendingGetcwd={ buffer:getX(state.regs,0), size:getX(state.regs,1) };
      continue;
    }
    if (syscall===221) {
      if (verbose)
        console.error(`[ptrace] pid=${taskPid} execve path=0x${getX(state.regs,0).toString(16)} argv=0x${getX(state.regs,1).toString(16)}`);
      try { task.pendingExec=prepareExecGuest(taskPid,mounts,task,state,tasks); }
      catch (error) {
        if (verbose) console.error(`[ptrace] pid=${taskPid} exec capture failed phase=${phase}: ${error.message}`);
        continue;
      }
      // Substitute a harmless, universally available syscall. Using -1 as a
      // cancellation sentinel is not reliable on every Android/musl ptrace
      // path and can allow the real execve to replace the address space first.
      setKernelSyscallNumber(taskPid,state,SYS_GETPID); continue;
    }
    if (syscall===220) {
      const flags=getX(state.regs,0), unsafe=0x4100n; // CLONE_VM | CLONE_VFORK
      if ((flags&0x20000n)!==0n) task.pendingChildMountNamespace=true;
      let translated=flags&~CLONE_NS_MASK;
      if ((flags&0x4000n)!==0n) { // only vfork; CLONE_VM alone is a real thread
        translated&=~unsafe;
      }
      if (translated!==flags) {
        setX(state.regs,0,translated); putRegisters(taskPid,state);
        if (verbose) console.error(`[ptrace] pid=${taskPid} clone flags 0x${flags.toString(16)} -> 0x${translated.toString(16)}`);
      }
      continue;
    }
    if (syscall===435) {
      // clone3(&clone_args, size): flags is the first u64.  Do not emulate an
      // absent syscall: an old Android kernel's ENOSYS is required so libc can
      // select its own clone/fork fallback.
      const args=getX(state.regs,0);
      if (args!==0n) {
        const flags=BigInt.asUintN(64,memory.peek(taskPid,args));
        let translated=flags&~CLONE_NS_MASK;
        if ((flags&0x4000n)!==0n) translated&=~0x4100n; // VFORK -> private fork
        if (translated!==flags) {
          memory.poke(taskPid,args,translated);
          if (verbose) console.error(`[ptrace] pid=${taskPid} clone3 flags 0x${flags.toString(16)} -> 0x${translated.toString(16)}`);
        }
      }
      continue;
    }
    if (syscall===SYS_FCHOWNAT || syscall===SYS_FCHOWN) {
      // Substitute the real ids so the kernel has a chance of accepting the
      // call; upstream fake_id0 does the same for its own emulated ids
      // (src/extension/fake_id0/chown.c:handle_chown_enter_end).  Chowning a
      // file to the ids it already carries is permitted without CAP_CHOWN,
      // while nothing the guest asks for ever is: it believes it is root, and
      // it is not.  This layer already answers every stat with uid 0 and gid 0,
      // so an ownership the guest cannot observe costs nothing to drop, while
      // failing the call makes an ordinary archive extraction report that it
      // could not preserve ownership -- Alpine's shadow and linux-pam ship
      // root:shadow files and apk counts one error per file.  -1 keeps its
      // "leave this id alone" meaning.
      const uidArgument=syscall===SYS_FCHOWNAT?2:1;
      for (const [argument,real] of [[uidArgument,process.getuid()],[uidArgument+1,process.getgid()]])
        if (BigInt.asUintN(32,getX(state.regs,argument))!==0xffffffffn)
          setX(state.regs,argument,BigInt(real));
      putRegisters(taskPid,state);
    }
    if (syscall===SYS_FCHDIR) {
      // A shell may change directory through a descriptor rather than a
      // pathname -- fish does -- and chdir(2) alone then leaves this tracer's
      // idea of the cwd behind, so every later relative path is translated
      // against the directory the guest has already left. Upstream resolves
      // "." against the descriptor for the same reason
      // (src/syscall/enter.c:2048, `case PR_fchdir`).
      const fd=Number(BigInt.asIntN(32,getX(state.regs,0)));
      // An unresolvable descriptor leaves the cwd alone rather than guessing:
      // the exit stage only commits a pendingCwd that is not null.
      try { task.pendingCwd=fdGuestBase(taskPid,mounts,task,fd); }
      catch { task.pendingCwd=null; }
      continue;
    }
    if (syscall===SYS_CLOSE) {
      // Keep the alias record after close: a descriptor can already have been
      // inherited by a cloned bwrap child. recallOpenedAlias revalidates the
      // pathname against the backing object, so stale records are harmless.
      task.openedHostFds?.delete(Number(BigInt.asIntN(32,getX(state.regs,0))));
      task.openedGuestFds?.delete(Number(BigInt.asIntN(32,getX(state.regs,0))));
      continue;
    }
    if (syscall===SYS_GETDENTS64) {
      task.pendingGetdents={ fd:Number(BigInt.asIntN(32,getX(state.regs,0))),
        buffer:getX(state.regs,1), size:getX(state.regs,2) };
      continue;
    }
    if (syscall===SYS_READLINKAT) {
      let linkPath=null;
      const address=getX(state.regs,1);
      if (address>=4096n) { try { linkPath=readCString(memory,taskPid,address); } catch {} }
      const substitute=linkPath!==null&&linkPath.startsWith("/proc/")
        ?resolveProcLink(taskPid,tasks,linkPath):null;
      const descriptor=linkPath===null?null:PROC_FD_LINK.exec(posix.normalize(linkPath));
      const descriptorOwner=descriptor===null?null:
        descriptor[1]==="self"||descriptor[1]==="thread-self"?taskPid:Number(descriptor[1]);
      let fdSubstitute=null;
      if (descriptorOwner!==null) {
        try {
          const host=readlinkSync(`/proc/${descriptorOwner}/fd/${Number(descriptor[2])}`);
          const remembered=descriptorOwner===taskPid
            ?task.openedGuestFds?.get(Number(descriptor[2])):null;
          const oldRoot=task.pivoted?mounts.entries.find((entry)=>entry.guest==="/oldroot"):null;
          fdSubstitute=remembered??(oldRoot &&
            (host===oldRoot.host || host.startsWith(`${oldRoot.host}/`))
            ?`/oldroot${host.slice(oldRoot.host.length)}`:mounts.toGuest(host));
          if (fdSubstitute!==null && /(?:^|\/)\.proot\.l2s\/objs\//.test(fdSubstitute))
            fdSubstitute=recallOpenedAlias(mounts,
              {pid:descriptorOwner,fd:Number(descriptor[2])},
              mounts.toGuest(host)??fdSubstitute)??fdSubstitute;
        } catch {}
      }
      const readlinkValue=substitute??fdSubstitute;
      task.pendingReadlink={ buffer:getX(state.regs,2), size:getX(state.regs,3), value:substitute,
        procFd:descriptor===null?null:
          { pid:descriptor[1]==="self"||descriptor[1]==="thread-self"?taskPid:Number(descriptor[1]),
            fd:Number(descriptor[2]) } };
      task.pendingReadlink.value=readlinkValue;
      if (readlinkValue!==null) {
        if (verbose)
          console.error(`[ptrace] pid=${taskPid} readlink ${linkPath} -> ${readlinkValue}`);
        setKernelSyscallNumber(taskPid,state,SYS_GETPID);
        continue;
      }
    }
    const arguments_=PATH_ARGUMENTS.get(syscall);
    if (arguments_===undefined) continue;
    task.pendingPathSyscall=syscall;
    if (syscall===SYS_OPENAT) {
      const address=getX(state.regs,1);
      let path=null;
      if (address>=4096n) { try { path=readCString(memory,taskPid,address); } catch {} }
      const descriptor=path===null?null:PROC_FD_LINK.exec(posix.normalize(path));
      const owner=descriptor===null?null:
        descriptor[1]==="self"||descriptor[1]==="thread-self"?taskPid:Number(descriptor[1]);
      if (descriptor!==null && owner===taskPid) {
        const fd=Number(descriptor[2]);
        let existingFlags=0;
        try {
          const match=/^flags:\s+([0-7]+)/m.exec(readFileSync(`/proc/${taskPid}/fdinfo/${fd}`,"utf8"));
          if (match!==null) existingFlags=parseInt(match[1],8);
        } catch {}
        // Reopening a tracee's descriptor through procfs is denied by Android
        // even for /proc/self/fd/N.  Upstream fake_id0 substitutes dup(N).
        // An O_PATH descriptor is the exception: dup would preserve O_PATH
        // instead of applying the access mode requested by openat.
        if ((existingFlags&0x200000)===0) {
          task.pendingPaths=[path];
          setX(state.regs,0,BigInt(fd));
          setKernelSyscallNumber(taskPid,state,SYS_DUP);
          if (verbose) console.error(`[ptrace] pid=${taskPid} openat ${path} -> dup(${fd})`);
          continue;
        }
      }
    }
    let scratch=task.scratch, changed=false, hostPaths=[], guestPaths=[];
    for (const spec of arguments_) {
      const address=getX(state.regs,spec.path);
      if (syscall===37 && spec.path===1 && (getX(state.regs,4)&0x1000n)!==0n) {
        hostPaths.push(`/proc/${taskPid}/fd/${Number(BigInt.asIntN(32,getX(state.regs,0)))}`);
        guestPaths.push(null);
        continue;
      }
      if (address<4096n) continue;
      let guestPath;
      try { guestPath=readCString(memory,taskPid,address); }
      catch (error) { if (verbose) console.error(`[ptrace] skipped pid=${taskPid} syscall=${syscall}: ${error.message}`); continue; }
      if (syscall===SYS_OPENAT) {
        let procMapPath=null;
        try { procMapPath=resolveGuestInput(taskPid,mounts,task,state,guestPath,spec); } catch {}
        const namespaceMap=procMapPath!==null &&
          /^\/proc\/(?:self|thread-self|\d+)\/(?:uid_map|gid_map|setgroups)$/.test(procMapPath);
        const namespaceLimit=procMapPath==="/proc/sys/user/max_user_namespaces" &&
          (Number(getX(state.regs,2)&3n)!==0);
        if (namespaceMap || namespaceLimit) {
          if (namespaceLimit) {
            task.usernsLimitFaked=true;
            task.usernsAfterLimit=0;
          }
          const sink="/dev/null";
          writeCString(memory,taskPid,scratch,sink);
          setX(state.regs,0,BigInt.asUintN(64,-100n));
          setX(state.regs,spec.path,scratch);
          scratch+=16n; changed=true;
          hostPaths.push(sink); guestPaths.push(procMapPath);
          if (verbose) console.error(`[ptrace] pid=${taskPid} namespace map ${procMapPath} -> ${sink}`);
          continue;
        }
      }
      // "/proc/<PID>/{exe,cwd,root}" names a guest object, so open(2), stat(2)
      // and execve(2) have to reach it through the mount table rather than through
      // the kernel's view of the Android bootstrap process.
      const procLink=guestPath.startsWith("/proc/")?resolveProcLink(taskPid,tasks,guestPath):null;
      if (procLink!==null) {
        const host=mounts.toHost(procLink);
        hostPaths.push(host); guestPaths.push(procLink);
        if (verbose)
          console.error(`[ptrace] pid=${taskPid} ${guestPath} (${procLink}) -> ${host}`);
        writeCString(memory,taskPid,scratch,host); setX(state.regs,spec.path,scratch);
        scratch+=BigInt((new TextEncoder().encode(host).length+8)&~7); changed=true;
        continue;
      }
      if ((isKernelFilesystem(guestPath)&&!task.pivoted&&!hasKernelFilesystemBinding(mounts,guestPath))||
          guestPath.startsWith(`${mounts.rootfs}/`)) {
        if (syscall===37)
          hostPaths.push(guestPath.replace(/^\/proc\/self(?=\/|$)/,`/proc/${taskPid}`));
        continue;
      }
      if (isKernelFilesystem(guestPath)&&hasKernelFilesystemBinding(mounts,guestPath)) {
        if (/^\/proc\/(?:self|thread-self|\d+)\/mountinfo$/.test(guestPath)) {
          const escape=(value)=>value.replace(/\\/g,"\\134").replace(/ /g,"\\040")
            .replace(/\t/g,"\\011").replace(/\n/g,"\\012");
          const lines=mounts.entries.map((entry,index)=>
            `${1000+index} 1 0:1 ${escape(entry.host)} ${escape(entry.guest)} rw - bind ${escape(entry.host)} rw`);
          const mountinfoPath=mountinfoPathFor(taskPid);
          writeFileSync(mountinfoPath,`${lines.join("\n")}\n`);
          hostPaths.push(mountinfoPath); guestPaths.push(guestPath);
          writeCString(memory,taskPid,scratch,mountinfoPath); setX(state.regs,spec.path,scratch);
          scratch+=BigInt((new TextEncoder().encode(mountinfoPath).length+8)&~7); changed=true;
          continue;
        }
        const kernelGuest=guestPath.replace(/^\/proc\/self(?=\/|$)/,`/proc/${taskPid}`);
        const host=mounts.toHost(kernelGuest);
        hostPaths.push(host); guestPaths.push(guestPath);
        writeCString(memory,taskPid,scratch,host); setX(state.regs,spec.path,scratch);
        scratch+=BigInt((new TextEncoder().encode(host).length+8)&~7); changed=true;
        continue;
      }
      let inputGuest, absoluteGuest;
      count("paths");
      try {
        inputGuest=timed("canon",()=>resolveGuestInput(taskPid,mounts,task,state,guestPath,spec));
        absoluteGuest=timed("canon",()=>resolveGuestPath(taskPid,mounts,task,state,guestPath,spec));
      }
      catch (error) { throw new Error(`pid ${taskPid} syscall ${syscall}: ${error.message}`); }
      if (/^\/proc\/(?:self|thread-self|\d+)\/mountinfo$/.test(absoluteGuest)) {
        const escape=(value)=>value.replace(/\\/g,"\\134").replace(/ /g,"\\040")
          .replace(/\t/g,"\\011").replace(/\n/g,"\\012");
        const lines=mounts.entries.map((entry,index)=>
          `${1000+index} 1 0:1 ${escape(entry.host)} ${escape(entry.guest)} rw - bind ${escape(entry.host)} rw`);
        const mountinfoPath=mountinfoPathFor(taskPid);
        writeFileSync(mountinfoPath,`${lines.join("\n")}\n`);
        hostPaths.push(mountinfoPath); guestPaths.push(absoluteGuest);
        writeCString(memory,taskPid,scratch,mountinfoPath); setX(state.regs,spec.path,scratch);
        scratch+=BigInt((new TextEncoder().encode(mountinfoPath).length+8)&~7); changed=true;
        continue;
      }
      // A relative pathname below a /proc, /dev or /sys dirfd reaches this
      // point without looking like a kernel path until the dirfd is resolved.
      // Keep it literal unless a more-specific binding intentionally replaces
      // it (for example /proc/sys/kernel/overflowuid).
      if (isKernelFilesystem(absoluteGuest)&&!task.pivoted&&!hasKernelFilesystemBinding(mounts,absoluteGuest)) {
        hostPaths.push(absoluteGuest);
        guestPaths.push(absoluteGuest);
        continue;
      }
      if (syscall===SYS_CHDIR && spec.path===0) task.pendingCwd=absoluteGuest;
      const canonicalHost=mounts.toHost(absoluteGuest);
      if (syscall===SYS_OPENAT &&
          (absoluteGuest.startsWith(L2S_OBJS) ||
           canonicalHost.startsWith(`${mounts.rootfs}${L2S_OBJS}`)))
        task.pendingOpenAlias=canonicalizeGuestPath(mounts,inputGuest,{preserveInternalFinal:true});
      const host=canonicalHost;
      if (syscall===SYS_OPENAT && task.pivoted && !host.startsWith(mounts.rootfs) &&
          !host.startsWith("/proc/") && !host.startsWith("/dev/") && !host.startsWith("/sys/"))
        task.lastExternalSourceHost=host;
      hostPaths.push(host);
      guestPaths.push(absoluteGuest);
      if ((syscall===79 || syscall===291) && task.pendingStat) {
        const alias=inspectEmulatedAlias(mounts.rootfs,mounts.toHost(inputGuest));
        const object=alias?null:inspectEmulatedObject(mounts.rootfs,mounts.toHost(inputGuest));
        if (alias||object) task.pendingStat.nlink=(alias??object).nlink;
      }
      if (verbose) console.error(`[ptrace] pid=${taskPid} ${guestPath} (${absoluteGuest}) -> ${host}`);
      writeCString(memory,taskPid,scratch,host); setX(state.regs,spec.path,scratch);
      scratch+=BigInt((new TextEncoder().encode(host).length+8)&~7); changed=true;
    }
    // Kept for the failure line below: a path syscall that returns an error is
    // only diagnosable next to the pathname it was given.
    task.pendingPaths=guestPaths;
    task.pendingHostPaths=hostPaths;
    task.pendingGuestPaths=guestPaths;
    if (syscall===439 && hostPaths.length===1) { // faccessat2
      let result=0n;
      try { accessSync(hostPaths[0],Number(getX(state.regs,2))); }
      catch (error) { result=BigInt(error.errno??-13); }
      setKernelSyscallNumber(taskPid,state,SYS_GETPID);
      task.forcedResult=BigInt.asUintN(64,result);
      continue;
    }
    if (syscall===37) { task.pendingLinkPaths=hostPaths; task.pendingLinkGuestPaths=guestPaths; }
    if (syscall===35 && hostPaths.length===1)
      task.pendingL2sUnlink=inspectEmulatedAlias(mounts.rootfs,hostPaths[0]);
    if ((syscall===38 || syscall===276) && hostPaths.length===2) {
      const source=inspectEmulatedAlias(mounts.rootfs,hostPaths[0]);
      const replaced=inspectEmulatedAlias(mounts.rootfs,hostPaths[1]);
      if (source && replaced?.id===source.id) {
        setKernelSyscallNumber(taskPid,state,SYS_GETPID); task.forcedResult=0n;
      } else if (source) {
        task.pendingL2sRename={source,replaced,targetHost:hostPaths[1],targetGuest:guestPaths[1]};
      } else if (hasEmulatedDirectory(mounts.rootfs,guestPaths[0])) {
        task.pendingL2sDirectoryRename={sourceGuest:guestPaths[0],targetGuest:guestPaths[1]};
      }
    }
    if (changed) putRegisters(taskPid,state);
  }
  report(performance.now()-started);
  for (const mountinfoPath of mountinfoPaths) try { unlinkSync(mountinfoPath); } catch {}
  return rootExit;
}
