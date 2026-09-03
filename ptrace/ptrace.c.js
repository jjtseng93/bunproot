import { FFIType, ptr } from "bun:ffi";
import { constants as fsConstants, copyFileSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { posix } from "node:path";
import { openLibrary } from "../ffi.js";
import { getPc, getSp, getSyscallNumber, getX, makeIovec, makeRegisterSet, NT_PRSTATUS, setPc, setX } from "../tracee/reg.c.js";
import { readCString, writeBytes, writeCString } from "../tracee/mem.c.js";
import { readElfLoadInfo, relocateElf } from "../execve/elf.c.js";
import { expandShebang } from "../execve/shebang.c.js";
import { canonicalizeGuestPath } from "../path/canon.c.js";
import { commitEmulatedDirectoryRename, commitEmulatedRename, commitEmulatedUnlink, emulateHardLink, hasEmulatedDirectory, inspectEmulatedAlias, inspectEmulatedObject, isEmulatedAlias } from "../extension/link2symlink/link2symlink.c.js";

const PTRACE_PEEKTEXT=1, PTRACE_PEEKDATA=2, PTRACE_POKETEXT=4, PTRACE_POKEDATA=5;
const PTRACE_CONT=7, PTRACE_ATTACH=16, PTRACE_SYSCALL=24;
const PTRACE_GETREGSET=0x4204, PTRACE_SETREGSET=0x4205, PTRACE_SETOPTIONS=0x4200;
const PTRACE_GET_SYSCALL_INFO=0x420e;
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
function syscallPhase(pid) {
  const info=new Uint8Array(88);
  const result=call(PTRACE_GET_SYSCALL_INFO,pid,BigInt(info.byteLength),BigInt(ptr(info)));
  return result<0n?0:info[0]; // NONE=0, ENTRY=1, EXIT=2, SECCOMP=3
}
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
    // PTRACE_ATTACH can leave the bootstrap's original group-stop queued.
    while (stoppedSignal(status) === 19) {
      if (call(PTRACE_CONT, pid) < 0n) throw new Error("failed to drain bootstrap SIGSTOP");
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
    if (result<0n && process.env.PROOT_BUN_VERBOSE==="1")
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
  return { rootfs, executable, guestPath, interpreter, loader, argv:argv.length?argv:[pathname], env };
}

function buildGuestStack(pid, trampoline, images, guest) {
  const stackSize=1024n*1024n;
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
  const guestEnvironment={...process.env,
    HOME:"/root", USER:"root", LOGNAME:"root", SHELL:"/bin/sh", PWD:"/",
    TMPDIR:"/tmp", PATH:"/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"};
  for (const name of ["LD_PRELOAD","LD_LIBRARY_PATH","PREFIX","TMPPREFIX",
    "BUN_INSTALL","NPM_CONFIG_PREFIX","OLDPWD"]) delete guestEnvironment[name];
  const envStrings=guest.env??Object.entries(guestEnvironment).map(([key,value])=>`${key}=${value}`);
  const envPointers=envStrings.map(putString);
  const argvPointers=guest.argv.map(putString);
  const execfn=argvPointers[0];
  // Pointer-valued auxv entries belong to the old Android bootstrap stack and
  // must never be copied verbatim across an emulated execve.
  const platform=putString("aarch64");
  const randomBytes=new Uint8Array(16); crypto.getRandomValues(randomBytes);
  const random=putBytes(randomBytes);
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
  const initial = wait(pid, 2); // WUNTRACED: observe the pre-exec SIGSTOP.
  if ((initial & 0xff) !== 0x7f) throw new Error("tracee did not stop before exec");
  if (call(PTRACE_ATTACH, pid) < 0n) throw new Error("PTRACE_ATTACH failed");
  wait(pid);
  // TRACESYSGOOD distinguishes syscall stops; EXITKILL prevents a bootstrap
  // loop from surviving if the Bun tracer crashes or is interrupted.
  if (call(PTRACE_SETOPTIONS, pid, 0n, 0x10000fn) < 0n) throw new Error("PTRACE_SETOPTIONS failed");
  if (process.env.PROOT_BUN_VERBOSE === "1" && guest !== null)
    console.error(`[ptrace] bootstrap pid=${pid} executable=${guest.executable} interpreter=${guest.interpreter ?? "static"}`);
  let trampoline = initializeRemoteSyscalls(pid);
  if (process.env.PROOT_BUN_VERBOSE === "1")
    console.error(`[ptrace] remote getpid=${pid}; trampoline mmap=0x${trampoline.toString(16)}`);
  const images = loadGuestImages(pid, trampoline, guest);
  if (process.env.PROOT_BUN_VERBOSE === "1")
    console.error(`[ptrace] mapped guest entry=0x${images.main.entry.toString(16)} interpreter entry=${images.interpreter ? `0x${images.interpreter.entry.toString(16)}` : "static"}`);
  setKernelRootCwd(pid,trampoline,rootfs);
  const guestSp=startGuest(pid,trampoline,images,guest);
  if (process.env.PROOT_BUN_VERBOSE === "1") console.error(`[ptrace] guest sp=0x${guestSp.toString(16)}`);
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
        if (call(PTRACE_SYSCALL,taskPid,0n,task.pendingSignal)<0n) {
          // Match upstream restart_tracee(): a task can die after its last
          // wait status but before the tracer restarts it. This is a normal
          // lifecycle race, especially for Git's short-lived helpers.
          tasks.delete(taskPid);
          if (process.env.PROOT_BUN_VERBOSE==="1")
            console.error(`[ptrace] tracee ${taskPid} disappeared before restart`);
          continue;
        }
        task.pendingSignal=0n; task.running=true;
      }
    }
    const result=waitResult(-1), taskPid=result.pid, status=result.status;
    const task=tasks.get(taskPid);
    if (!task) continue;
    task.running=false;
    if ((status&0x7f)===0) {
      if (taskPid===pid) rootExit=(status>>8)&0xff;
      tasks.delete(taskPid); continue;
    }
    if ((status&0x7f)!==0x7f) { tasks.delete(taskPid); continue; }
    const signal=(status>>8)&0xff, event=status>>>16;
    if (signal!==0x85) {
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
        if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] new tracee pid=${child} event=${event}`);
        continue;
      }
      const stopped=getRegisters(taskPid);
      if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] pid=${taskPid} signal=${signal} pc=0x${getPc(stopped.regs).toString(16)} syscall=${getSyscallNumber(stopped.regs)}`);
      if (signal===31) { setX(stopped.regs,0,BigInt.asUintN(64,-38n)); putRegisters(taskPid,stopped); continue; }
      if (signal===19) continue; // consume ptrace/vfork bootstrap SIGSTOP
      // Child state remains observable through wait4/waitid. Reinjecting the
      // ptrace-observed SIGCHLD currently enters a stale Android signal frame
      // after JS-controlled exec replacement on musl (BusyBox wget), which
      // crashes on handler return.
      if (signal===17) continue;
      task.pendingSignal=BigInt(signal); continue;
    }
    const phase=syscallPhase(taskPid);
    const isExit=phase===2 || (phase===0 && !task.entering);
    if (isExit) {
      task.entering=true;
      if (task.forcedResult!==undefined) {
        const exited=getRegisters(taskPid);
        setX(exited.regs,0,task.forcedResult); putRegisters(taskPid,exited);
        task.forcedResult=undefined;
      }
      if (task.idWrites!==undefined) {
        for (const address of task.idWrites) if (address!==0n)
          writeBytes(memory,taskPid,address,new Uint8Array(4));
        task.idWrites=undefined;
      }
      if (task.pendingStat!==undefined) {
        const exited=getRegisters(taskPid);
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
        const exited=getRegisters(taskPid), result=BigInt.asIntN(64,getX(exited.regs,0));
        let directory=null;
        if (result>0n) { try { directory=readlinkSync(`/proc/${taskPid}/fd/${fd}`); } catch {} }
        if (directory!==null && (directory===rootfs || directory.startsWith(`${rootfs}/`))) {
          const bytes=readTraceeBytes(taskPid,buffer,Number(result));
          const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
          let rewritten=false;
          for (let offset=0; offset+19<=bytes.length; ) {
            const reclen=view.getUint16(offset+16,true); // struct linux_dirent64.d_reclen
            if (reclen<19 || offset+reclen>bytes.length) break;
            if (bytes[offset+18]===DT_LNK) {
              let end=offset+19;
              while (end<offset+reclen && bytes[end]!==0) end++;
              const name=new TextDecoder().decode(bytes.subarray(offset+19,end));
              if (isEmulatedAlias(rootfs,`${directory}/${name}`)) { bytes[offset+18]=DT_REG; rewritten=true; }
            }
            offset+=reclen;
          }
          if (rewritten) writeTraceeBytes(taskPid,buffer,bytes,size);
        }
      }
      if (task.pendingReadlink!==undefined) {
        const { buffer,size,value }=task.pendingReadlink;
        task.pendingReadlink=undefined;
        const exited=getRegisters(taskPid);
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
              const encoded=new TextEncoder().encode(guestPathOf(rootfs,host));
              writeTraceeBytes(taskPid,buffer,encoded,size);
              setX(exited.regs,0,BigInt(encoded.length)); putRegisters(taskPid,exited);
              if (process.env.PROOT_BUN_VERBOSE==="1")
                console.error(`[ptrace] pid=${taskPid} readlink target ${host} -> ${guestPathOf(rootfs,host)}`);
            }
          }
        }
      }
      if (task.pendingPathSyscall!==undefined) {
        const exited=getRegisters(taskPid), result=BigInt.asIntN(64,getX(exited.regs,0));
        let finalResult=result;
        if (task.pendingL2sUnlink && result===0n) {
          try { commitEmulatedUnlink(rootfs,task.pendingL2sUnlink); }
          catch (error) {
            if (process.env.PROOT_BUN_VERBOSE==="1")
              console.error(`[ptrace] pid=${taskPid} link2symlink unlink cleanup failed: ${error.message}`);
          }
        }
        if (task.pendingL2sRename && result===0n) {
          try {
            const rename=task.pendingL2sRename;
            commitEmulatedRename(rootfs,rename.source,rename.targetHost,rename.targetGuest,rename.replaced);
          } catch (error) {
            if (process.env.PROOT_BUN_VERBOSE==="1")
              console.error(`[ptrace] pid=${taskPid} link2symlink rename cleanup failed: ${error.message}`);
          }
        }
        if (task.pendingL2sDirectoryRename && result===0n) {
          try {
            const rename=task.pendingL2sDirectoryRename;
            commitEmulatedDirectoryRename(rootfs,rename.sourceGuest,rename.targetGuest);
          } catch (error) {
            if (process.env.PROOT_BUN_VERBOSE==="1")
              console.error(`[ptrace] pid=${taskPid} link2symlink directory rename cleanup failed: ${error.message}`);
          }
        }
        if (task.pendingPathSyscall===37 && result===-13n && task.pendingLinkPaths?.length===2) {
          try {
            const emulated=emulateHardLink(rootfs,task.pendingLinkPaths[0],task.pendingLinkPaths[1],
              task.pendingLinkGuestPaths?.[0],task.pendingLinkGuestPaths?.[1]);
            if (!emulated) copyFileSync(task.pendingLinkPaths[0],task.pendingLinkPaths[1],fsConstants.COPYFILE_EXCL);
            setX(exited.regs,0,0n); putRegisters(taskPid,exited); finalResult=0n;
            if (process.env.PROOT_BUN_VERBOSE==="1")
              console.error(`[ptrace] pid=${taskPid} linkat EACCES -> ${emulated?"link2symlink":"exclusive copy"} fallback`);
          } catch (error) {
            finalResult=BigInt(error.errno??-13);
            if (process.env.PROOT_BUN_VERBOSE==="1")
              console.error(`[ptrace] pid=${taskPid} linkat fallback failed: ${error.message}; paths=${task.pendingLinkPaths.join(" -> ")}`);
            setX(exited.regs,0,BigInt.asUintN(64,finalResult)); putRegisters(taskPid,exited);
          }
        }
        if (finalResult<0n && process.env.PROOT_BUN_VERBOSE==="1")
          console.error(`[ptrace] pid=${taskPid} syscall=${task.pendingPathSyscall} result=${finalResult}`);
        task.pendingPathSyscall=undefined;
        task.pendingLinkPaths=undefined;
        task.pendingLinkGuestPaths=undefined;
        task.pendingL2sUnlink=undefined;
        task.pendingL2sRename=undefined;
        task.pendingL2sDirectoryRename=undefined;
      }
      if (task.pendingCwd!==null || task.pendingGetcwd!==null) {
        const exited=getRegisters(taskPid), result=BigInt.asIntN(64,getX(exited.regs,0));
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
        if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] pid=${taskPid} emulating execve ${next.argv.join(" ")}`);
        if (!isMapped(taskPid,task.trampoline)) {
          task.trampoline=allocateRemoteSyscalls(taskPid,task.borrowPc);
          task.scratch=task.trampoline+4096n+512n;
          if (process.env.PROOT_BUN_VERBOSE==="1")
            console.error(`[ptrace] pid=${taskPid} renewed trampoline=0x${task.trampoline.toString(16)}`);
        }
        closeExecDescriptors(taskPid,task.trampoline);
        resetExecAddressSpace(taskPid,task.trampoline);
        const nextImages=loadGuestImages(taskPid,task.trampoline,next);
        startGuest(taskPid,task.trampoline,nextImages,next);
        task.borrowPc=nextImages.interpreter?.entry??nextImages.main.entry;
        task.exe=next.guestPath??guestPathOf(rootfs,next.executable);
      }
      continue;
    }
    task.entering=false;
    const state=getRegisters(taskPid), syscall=getSyscallNumber(state.regs);
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
      if (process.env.PROOT_BUN_VERBOSE==="1")
        console.error(`[ptrace] pid=${taskPid} execve path=0x${getX(state.regs,0).toString(16)} argv=0x${getX(state.regs,1).toString(16)}`);
      try { task.pendingExec=prepareExecGuest(taskPid,rootfs,task,state,tasks); }
      catch (error) {
        if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] pid=${taskPid} exec capture failed phase=${phase}: ${error.message}`);
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
        if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] pid=${taskPid} clone flags 0x${flags.toString(16)} -> 0x${translated.toString(16)}`);
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
          if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] pid=${taskPid} clone3 flags 0x${flags.toString(16)} -> 0x${translated.toString(16)}`);
        }
      }
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
      task.pendingReadlink={ buffer:getX(state.regs,2), size:getX(state.regs,3), value:substitute };
      if (substitute!==null) {
        if (process.env.PROOT_BUN_VERBOSE==="1")
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
      catch (error) { if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] skipped pid=${taskPid} syscall=${syscall}: ${error.message}`); continue; }
      // "/proc/<PID>/{exe,cwd,root}" names a guest object, so open(2), stat(2)
      // and execve(2) have to reach it through the rootfs rather than through
      // the kernel's view of the Android bootstrap process.
      const procLink=guestPath.startsWith("/proc/")?resolveProcLink(taskPid,tasks,guestPath):null;
      if (procLink!==null) {
        const host=procLink==="/"?rootfs:`${rootfs}${procLink}`;
        hostPaths.push(host); guestPaths.push(procLink);
        if (process.env.PROOT_BUN_VERBOSE==="1")
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
      try {
        inputGuest=resolveGuestInput(taskPid,rootfs,task,state,guestPath,spec);
        absoluteGuest=resolveGuestPath(taskPid,rootfs,task,state,guestPath,spec);
      }
      catch (error) { throw new Error(`pid ${taskPid} syscall ${syscall}: ${error.message}`); }
      if (syscall===SYS_CHDIR && spec.path===0) task.pendingCwd=absoluteGuest;
      const host=absoluteGuest==="/"?rootfs:`${rootfs}${absoluteGuest}`;
      hostPaths.push(host);
      guestPaths.push(absoluteGuest);
      if ((syscall===79 || syscall===291) && task.pendingStat) {
        const alias=inspectEmulatedAlias(rootfs,inputGuest==="/"?rootfs:`${rootfs}${inputGuest}`);
        const object=alias?null:inspectEmulatedObject(rootfs,inputGuest==="/"?rootfs:`${rootfs}${inputGuest}`);
        if (alias||object) task.pendingStat.nlink=(alias??object).nlink;
      }
      if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] pid=${taskPid} ${guestPath} (${absoluteGuest}) -> ${host}`);
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
  return rootExit;
}
