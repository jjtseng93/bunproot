import { FFIType, ptr } from "bun:ffi";
import { constants as fsConstants, copyFileSync, existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { posix } from "node:path";
import { openLibrary } from "../ffi.js";
import { getPc, getSp, getSyscallNumber, getX, makeIovec, makeRegisterSet, NT_PRSTATUS, setPc, setX } from "../tracee/reg.c.js";
import { readCString, writeBytes, writeCString } from "../tracee/mem.c.js";
import { readElfLoadInfo, relocateElf } from "../execve/elf.c.js";
import { expandShebang } from "../execve/shebang.c.js";
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
const SYS_GETPID = 172, SYS_MMAP = 222;
const SYS_GETCWD = 17, SYS_CHDIR = 49, SYS_OPENAT = 56, SYS_CLOSE = 57, SYS_MUNMAP=215;
const SYS_READLINKAT = 78, SYS_GETDENTS64 = 61;
const SYS_FCHOWNAT = 54, SYS_FCHOWN = 55;
const SYS_SIGALTSTACK = 132, SYS_RT_SIGACTION = 134, SYS_PRCTL = 167;
const PTRACE_EVENT_SECCOMP = 7;
const PR_SET_NO_NEW_PRIVS = 38, PR_SET_SECCOMP = 22, SECCOMP_MODE_FILTER = 2;
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
    [requested,1024n*1024n,7n,0x100022n,-1n,0n]); // FIXED_NOREPLACE|PRIVATE|ANON
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
  const trampolineEnd=trampoline+1024n*1024n;
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
function describeFault(pid,signal,pc) {
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

function prepareExecGuest(pid,rootfs,task,state,tasks) {
  const pathname=readCString(memory,pid,getX(state.regs,0));
  let argv=readPointerArray(pid,getX(state.regs,1));
  const env=readPointerArray(pid,getX(state.regs,2));
  const input=pathname.startsWith("/")?posix.normalize(pathname):posix.resolve(task.cwd,pathname);
  // Two names for one file: the guest-visible pathname, which goes into argv
  // and /proc/<PID>/exe, and the host pathname the loader actually reads.  They
  // differ for an emulated hard link, and an interpreter that resolves its
  // imports next to argv[1] must never be handed /.proot.l2s/objs/<id>.
  let guestPath=canonicalizeGuestPath(rootfs,resolveProcLink(pid,tasks,input)??input,
    {preserveInternalFinal:true});
  let executable=`${rootfs}${canonicalizeGuestPath(rootfs,guestPath)}`;
  const script=expandShebang(executable,guestPath,argv);
  if (script!==null) {
    guestPath=canonicalizeGuestPath(rootfs,script.guestPath,{preserveInternalFinal:true});
    executable=`${rootfs}${canonicalizeGuestPath(rootfs,guestPath)}`;
    argv=script.argv;
  }
  const info=readElfLoadInfo(executable);
  const interpreter=info.interpreter;
  const loader=interpreter===null?null:`${rootfs}${interpreter}`;
  // Refuse the exec here, while the caller can still let the real execve run
  // and report the error itself.  Once the commit stage has torn down the
  // address space there is nothing left to return an errno to -- and a guest
  // that probes binaries it cannot run is ordinary: npm installs both the
  // glibc and the musl build of a package and tries one of them.
  if (loader!==null && !existsSync(loader))
    throw Object.assign(new Error(`ELF interpreter not found: ${interpreter}`),{code:"ENOENT"});
  return { rootfs, executable, guestPath, interpreter, loader, argv:argv.length?argv:[pathname], env };
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

// Linux arm64 syscall -> pathname registers. Symlink targets are intentionally
// not translated; only the directory entry being created is a host pathname.
const PATH_ARGUMENTS = new Map([
  [33,[{path:1,dirfd:0,deref:false}]], [34,[{path:1,dirfd:0,deref:false}]], [35,[{path:1,dirfd:0,deref:false,preserveL2s:true}]],
  [36,[{path:2,dirfd:1,deref:false,preserveL2s:true}]], [37,[{path:1,dirfd:0,deref:false,preserveL2s:true},{path:3,dirfd:2,deref:false,preserveL2s:true}]],
  [38,[{path:1,dirfd:0,deref:false,preserveL2s:true},{path:3,dirfd:2,deref:false,preserveL2s:true}]], [43,[{path:0}]], [45,[{path:0}]],
  [48,[{path:1,dirfd:0}]], [49,[{path:0}]], [51,[{path:0}]],
  [53,[{path:1,dirfd:0}]], [54,[{path:1,dirfd:0}]],
  [56,[{path:1,dirfd:0,nofollow:{arg:2,mask:O_NOFOLLOW}}]],
  [78,[{path:1,dirfd:0,deref:false}]],
  [79,[{path:1,dirfd:0,nofollow:{arg:3,mask:0x100n}}]], [88,[{path:1,dirfd:0}]],
  [89,[{path:0}]], [276,[{path:1,dirfd:0,deref:false,preserveL2s:true},{path:3,dirfd:2,deref:false,preserveL2s:true}]],
  [281,[{path:1,dirfd:0}]],
  [291,[{path:1,dirfd:0,nofollow:{arg:2,mask:0x100n}}]],
  [437,[{path:1,dirfd:0}]], [439,[{path:1,dirfd:0}]],
]);

// Every syscall the enter stage looks at: the pathname table plus the calls
// that are emulated, translated or recorded outright.
const HANDLED_ON_ENTER=new Set([...PATH_ARGUMENTS.keys(),
  SYS_MUNMAP, SYS_GETCWD, SYS_CLOSE, SYS_GETDENTS64, SYS_READLINKAT,
  SYS_FCHOWNAT, SYS_FCHOWN,
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

function fdGuestBase(pid,rootfs,task,fd) {
  if (fd===-100) return task.cwd;
  const host=readlinkSync(`/proc/${pid}/fd/${fd}`);
  if (host===rootfs) return "/";
  if (host.startsWith(`${rootfs}/`)) return host.slice(rootfs.length);
  throw new Error(`dirfd ${fd} points outside rootfs: ${host}`);
}

function resolveGuestInput(pid,rootfs,task,state,path,spec) {
  return path.startsWith("/")?posix.normalize(path):posix.resolve(
    spec.dirfd===undefined?task.cwd:fdGuestBase(pid,rootfs,task,
      Number(BigInt.asIntN(32,getX(state.regs,spec.dirfd)))),path);
}
function resolveGuestPath(pid,rootfs,task,state,path,spec) {
  const absolute=resolveGuestInput(pid,rootfs,task,state,path,spec);
  const flagSaysNoFollow=spec.nofollow!==undefined &&
    (getX(state.regs,spec.nofollow.arg)&spec.nofollow.mask)!==0n;
  return canonicalizeGuestPath(rootfs,absolute,
    {derefFinal:spec.deref!==false&&!flagSaysNoFollow,preserveInternalFinal:spec.preserveL2s===true});
}

function isKernelFilesystem(path) {
  return ["/proc","/dev","/sys"].some((prefix)=>path===prefix||path.startsWith(`${prefix}/`));
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

// The kernel reports a descriptor opened through an emulated hard link under
// the storage name no tracee ever used, so remember the name the tracee did
// use.  Upstream does the same in link2symlink's READLINK_PROC_FD callback
// (src/extension/link2symlink/link2symlink.c:readlink_proc_fd).
const L2S_OBJS="/.proot.l2s/objs/";
const openedAliases=new Map();

function recallOpenedAlias(rootfs,procFd,objectGuest) {
  const accept=(alias)=>{
    if (alias===undefined) return null;
    // Descriptor numbers are reused and links are removed, so the remembered
    // name still has to lead to this very object.
    try { return canonicalizeGuestPath(rootfs,alias)===objectGuest?alias:null; }
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

function guestPathOf(rootfs,hostPath) {
  if (hostPath===rootfs) return "/";
  if (hostPath.startsWith(`${rootfs}/`)) return hostPath.slice(rootfs.length);
  return hostPath;
}

// Upstream substitutes "/proc/<PID>/{exe,cwd,root}" with tracee->exe,
// tracee->fs->cwd and get_root() (path/proc.c:readlink_proc). Here the
// substitution is mandatory rather than cosmetic: the guest image is mapped in
// by the loader instead of being execve()d, so the kernel still reports the
// Android bootstrap binary -- /apex/com.android.runtime/bin/linker64 -- as the
// process executable. Anything that re-executes itself through
// /proc/self/exe (bun x re-running itself as `node`) would otherwise exec a
// host path that does not exist inside the rootfs.
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

export function traceProcess(pid, rootfs, guest = null) {
  const started=performance.now();
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
  setKernelRootCwd(pid,trampoline,rootfs);
  const filtering=installSyscallFilter(pid,trampoline);
  // Without a filter every syscall has to be stopped to find the few that
  // matter, which is correct but costs two stops per syscall.
  const restartRequest=filtering?PTRACE_CONT:PTRACE_SYSCALL;
  if (verbose) console.error(`[ptrace] syscall filter ${filtering?"installed":"unavailable; stopping on every syscall"}`);
  const guestSp=startGuest(pid,trampoline,images,guest);
  if (verbose) console.error(`[ptrace] guest sp=0x${guestSp.toString(16)}`);
  let nextScratchSlot=1n;
  const tasks=new Map([[pid,{ entering:true, pendingSignal:0n, pendingExec:null,
    pendingCwd:null, pendingGetcwd:null, cwd:"/", scratch:trampoline+4096n+512n,
    exe:guest===null?null:guest.guestPath??guestPathOf(rootfs,guest.executable) }]]);
  tasks.get(pid).trampoline=trampoline;
  tasks.get(pid).borrowPc=images.interpreter?.entry??images.main.entry;
  let rootExit=1;
  while (tasks.size>0) {
    for (const [taskPid,task] of tasks) {
      if (!task.running) {
        if (call(task.restart??restartRequest,taskPid,0n,task.pendingSignal)<0n) {
          // Match upstream restart_tracee(): a task can die after its last
          // wait status but before the tracer restarts it. This is a normal
          // lifecycle race, especially for Git's short-lived helpers.
          tasks.delete(taskPid);
          if (verbose)
            console.error(`[ptrace] tracee ${taskPid} disappeared before restart`);
          continue;
        }
        task.pendingSignal=0n; task.restart=undefined; task.running=true;
      }
    }
    const result=timed("wait",()=>waitResult(-1)), taskPid=result.pid, status=result.status;
    count("stops");
    const task=tasks.get(taskPid);
    if (!task) continue;
    task.running=false;
    if ((status&0x7f)===0) {
      if (taskPid===pid) rootExit=(status>>8)&0xff;
      tasks.delete(taskPid); continue;
    }
    if ((status&0x7f)!==0x7f) { tasks.delete(taskPid); continue; }
    const signal=(status>>8)&0xff, event=status>>>16;
    const seccompStop=signal===5 && event===PTRACE_EVENT_SECCOMP;
    if (signal!==0x85 && !seccompStop) {
      if (signal===5 && event>=1 && event<=3) {
        const child=eventMessage(taskPid);
        tasks.set(child,{ entering:true, pendingSignal:0n, pendingExec:null,
          pendingCwd:null, pendingGetcwd:null, cwd:task.cwd, exe:task.exe,
          // At EVENT_CLONE/FORK the new tracee is stopped.  Some kernels also
          // report a separate SIGSTOP and some coalesce it with this event;
          // resume now and consume a later SIGSTOP if one is delivered.
          trampoline:task.trampoline,
          borrowPc:task.borrowPc,
          scratch:task.trampoline+(++nextScratchSlot)*4096n+512n, running:false });
        if (verbose) console.error(`[ptrace] new tracee pid=${child} event=${event}`);
        continue;
      }
      const stopped=getRegisters(taskPid);
      if (verbose)
        console.error(`[ptrace] pid=${taskPid} signal=${signal} pc=0x${getPc(stopped.regs).toString(16)} syscall=${getSyscallNumber(stopped.regs)}${describeFault(taskPid,signal,getPc(stopped.regs))}`);
      if (signal===31) { setX(stopped.regs,0,BigInt.asUintN(64,-38n)); putRegisters(taskPid,stopped); continue; }
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
        for (const address of task.idWrites) if (address!==0n)
          writeBytes(memory,taskPid,address,new Uint8Array(4));
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
const exited=registers(), result=syscallInfoResult();
        let directory=null;
        if (result>0n) { try { directory=readlinkSync(`/proc/${taskPid}/fd/${fd}`); } catch {} }
        if (directory!==null && (directory===rootfs || directory.startsWith(`${rootfs}/`))) {
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
              if (timed("getdentsAlias",()=>isEmulatedAlias(rootfs,`${directory}/${name}`))) { bytes[offset+18]=DT_REG; rewritten=true; }
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
            if (host===rootfs || host.startsWith(`${rootfs}/`)) {
              let guest=guestPathOf(rootfs,host);
              if (guest.startsWith(L2S_OBJS))
                guest=recallOpenedAlias(rootfs,procFd,guest)??guest;
              const encoded=new TextEncoder().encode(guest);
              writeTraceeBytes(taskPid,buffer,encoded,size);
              setX(exited.regs,0,BigInt(encoded.length)); putRegisters(taskPid,exited);
              if (verbose)
                console.error(`[ptrace] pid=${taskPid} readlink target ${host} -> ${guest}`);
            }
          }
        }
      }
      if (task.pendingPathSyscall!==undefined) {
const exited=registers(), result=syscallInfoResult();
        let finalResult=result;
        if (task.pendingOpenAlias!==undefined) {
          if (result>=0n) openedAliases.set(`${taskPid}:${result}`,task.pendingOpenAlias);
          task.pendingOpenAlias=undefined;
        }
        if (task.pendingL2sUnlink && result===0n) {
          try { commitEmulatedUnlink(rootfs,task.pendingL2sUnlink); }
          catch (error) {
            if (verbose)
              console.error(`[ptrace] pid=${taskPid} link2symlink unlink cleanup failed: ${error.message}`);
          }
        }
        if (task.pendingL2sRename && result===0n) {
          try {
            const rename=task.pendingL2sRename;
            commitEmulatedRename(rootfs,rename.source,rename.targetHost,rename.targetGuest,rename.replaced);
          } catch (error) {
            if (verbose)
              console.error(`[ptrace] pid=${taskPid} link2symlink rename cleanup failed: ${error.message}`);
          }
        }
        if (task.pendingL2sDirectoryRename && result===0n) {
          try {
            const rename=task.pendingL2sDirectoryRename;
            commitEmulatedDirectoryRename(rootfs,rename.sourceGuest,rename.targetGuest);
          } catch (error) {
            if (verbose)
              console.error(`[ptrace] pid=${taskPid} link2symlink directory rename cleanup failed: ${error.message}`);
          }
        }
        if (task.pendingPathSyscall===37 && result===-13n && task.pendingLinkPaths?.length===2) {
          try {
            const emulated=emulateHardLink(rootfs,task.pendingLinkPaths[0],task.pendingLinkPaths[1],
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
        if (finalResult<0n && verbose)
          console.error(`[ptrace] pid=${taskPid} syscall=${task.pendingPathSyscall} result=${finalResult}`);
        task.pendingPathSyscall=undefined;
        task.pendingLinkPaths=undefined;
        task.pendingLinkGuestPaths=undefined;
        task.pendingL2sUnlink=undefined;
        task.pendingL2sRename=undefined;
        task.pendingL2sDirectoryRename=undefined;
      }
      if (task.pendingCwd!==null || task.pendingGetcwd!==null) {
const exited=registers(), result=syscallInfoResult();
        if (task.pendingCwd!==null) {
          if (result===0n) task.cwd=task.pendingCwd;
          task.pendingCwd=null;
        }
        if (task.pendingGetcwd!==null) {
          if (result>0n) {
            const hostCwd=readCString(memory,taskPid,task.pendingGetcwd.buffer);
            const guestCwd=hostCwd===rootfs?"/":hostCwd.startsWith(`${rootfs}/`)?hostCwd.slice(rootfs.length):hostCwd;
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
        task.borrowPc=nextImages.interpreter?.entry??nextImages.main.entry;
        task.exe=next.guestPath??guestPathOf(rootfs,next.executable);
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
    if (syscall===SYS_MUNMAP) {
      const start=getX(state.regs,0), end=start+getX(state.regs,1);
      const protectedEnd=task.trampoline+1024n*1024n;
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
        const object=inspectEmulatedObject(rootfs,readlinkSync(`/proc/${taskPid}/fd/${Number(getX(state.regs,0))}`));
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
      try { task.pendingExec=prepareExecGuest(taskPid,rootfs,task,state,tasks); }
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
    if (syscall===SYS_CLOSE) {
      openedAliases.delete(`${taskPid}:${Number(BigInt.asIntN(32,getX(state.regs,0)))}`);
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
      task.pendingReadlink={ buffer:getX(state.regs,2), size:getX(state.regs,3), value:substitute,
        procFd:descriptor===null?null:
          { pid:descriptor[1]==="self"||descriptor[1]==="thread-self"?taskPid:Number(descriptor[1]),
            fd:Number(descriptor[2]) } };
      if (substitute!==null) {
        if (verbose)
          console.error(`[ptrace] pid=${taskPid} readlink ${linkPath} -> ${substitute}`);
        setKernelSyscallNumber(taskPid,state,SYS_GETPID);
        continue;
      }
    }
    const arguments_=PATH_ARGUMENTS.get(syscall);
    if (arguments_===undefined) continue;
    task.pendingPathSyscall=syscall;
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
      // "/proc/<PID>/{exe,cwd,root}" names a guest object, so open(2), stat(2)
      // and execve(2) have to reach it through the rootfs rather than through
      // the kernel's view of the Android bootstrap process.
      const procLink=guestPath.startsWith("/proc/")?resolveProcLink(taskPid,tasks,guestPath):null;
      if (procLink!==null) {
        const host=procLink==="/"?rootfs:`${rootfs}${procLink}`;
        hostPaths.push(host); guestPaths.push(procLink);
        if (verbose)
          console.error(`[ptrace] pid=${taskPid} ${guestPath} (${procLink}) -> ${host}`);
        writeCString(memory,taskPid,scratch,host); setX(state.regs,spec.path,scratch);
        scratch+=BigInt((new TextEncoder().encode(host).length+8)&~7); changed=true;
        continue;
      }
      if (isKernelFilesystem(guestPath)||guestPath.startsWith(`${rootfs}/`)) {
        if (syscall===37)
          hostPaths.push(guestPath.replace(/^\/proc\/self(?=\/|$)/,`/proc/${taskPid}`));
        continue;
      }
      let inputGuest, absoluteGuest;
      count("paths");
      try {
        inputGuest=timed("canon",()=>resolveGuestInput(taskPid,rootfs,task,state,guestPath,spec));
        absoluteGuest=timed("canon",()=>resolveGuestPath(taskPid,rootfs,task,state,guestPath,spec));
      }
      catch (error) { throw new Error(`pid ${taskPid} syscall ${syscall}: ${error.message}`); }
      if (syscall===SYS_CHDIR && spec.path===0) task.pendingCwd=absoluteGuest;
      if (syscall===SYS_OPENAT && absoluteGuest.startsWith(L2S_OBJS))
        task.pendingOpenAlias=canonicalizeGuestPath(rootfs,inputGuest,{preserveInternalFinal:true});
      const host=absoluteGuest==="/"?rootfs:`${rootfs}${absoluteGuest}`;
      hostPaths.push(host);
      guestPaths.push(absoluteGuest);
      if ((syscall===79 || syscall===291) && task.pendingStat) {
        const alias=inspectEmulatedAlias(rootfs,inputGuest==="/"?rootfs:`${rootfs}${inputGuest}`);
        const object=alias?null:inspectEmulatedObject(rootfs,inputGuest==="/"?rootfs:`${rootfs}${inputGuest}`);
        if (alias||object) task.pendingStat.nlink=(alias??object).nlink;
      }
      if (verbose) console.error(`[ptrace] pid=${taskPid} ${guestPath} (${absoluteGuest}) -> ${host}`);
      writeCString(memory,taskPid,scratch,host); setX(state.regs,spec.path,scratch);
      scratch+=BigInt((new TextEncoder().encode(host).length+8)&~7); changed=true;
    }
    if (syscall===37) { task.pendingLinkPaths=hostPaths; task.pendingLinkGuestPaths=guestPaths; }
    if (syscall===35 && hostPaths.length===1)
      task.pendingL2sUnlink=inspectEmulatedAlias(rootfs,hostPaths[0]);
    if ((syscall===38 || syscall===276) && hostPaths.length===2) {
      const source=inspectEmulatedAlias(rootfs,hostPaths[0]);
      const replaced=inspectEmulatedAlias(rootfs,hostPaths[1]);
      if (source && replaced?.id===source.id) {
        setKernelSyscallNumber(taskPid,state,SYS_GETPID); task.forcedResult=0n;
      } else if (source) {
        task.pendingL2sRename={source,replaced,targetHost:hostPaths[1],targetGuest:guestPaths[1]};
      } else if (hasEmulatedDirectory(rootfs,guestPaths[0])) {
        task.pendingL2sDirectoryRename={sourceGuest:guestPaths[0],targetGuest:guestPaths[1]};
      }
    }
    if (changed) putRegisters(taskPid,state);
  }
  report(performance.now()-started);
  return rootExit;
}
