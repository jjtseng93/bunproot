import { FFIType, ptr } from "bun:ffi";
import { readFileSync, readlinkSync } from "node:fs";
import { posix } from "node:path";
import { openLibrary } from "../ffi.js";
import { getPc, getSp, getSyscallNumber, getX, makeIovec, makeRegisterSet, NT_PRSTATUS, setPc, setX } from "../tracee/reg.c.js";
import { readCString, writeBytes, writeCString } from "../tracee/mem.c.js";
import { readElfLoadInfo, relocateElf } from "../execve/elf.c.js";
import { expandShebang } from "../execve/shebang.c.js";
import { canonicalizeGuestPath } from "../path/canon.c.js";

const PTRACE_PEEKTEXT=1, PTRACE_PEEKDATA=2, PTRACE_POKETEXT=4, PTRACE_POKEDATA=5;
const PTRACE_CONT=7, PTRACE_ATTACH=16, PTRACE_SYSCALL=24;
const PTRACE_GETREGSET=0x4204, PTRACE_SETREGSET=0x4205, PTRACE_SETOPTIONS=0x4200;
const PTRACE_GET_SYSCALL_INFO=0x420e;
const native = openLibrary("libc", {
  ptrace: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.u64], returns: FFIType.i64 },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
}).symbols;
const call = (request, pid, address=0n, data=0n) => native.ptrace(request, pid, address, data);
const memory = {
  peek: (pid, address) => call(PTRACE_PEEKDATA, pid, address),
  poke(pid, address, word) { if (call(PTRACE_POKEDATA, pid, address, word) === -1n) throw new Error("PTRACE_POKEDATA failed"); },
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

function prepareExecGuest(pid,rootfs,task,state) {
  const pathname=readCString(memory,pid,getX(state.regs,0));
  let argv=readPointerArray(pid,getX(state.regs,1));
  let guestPath=pathname.startsWith("/")?posix.normalize(pathname):posix.resolve(task.cwd,pathname);
  guestPath=canonicalizeGuestPath(rootfs,guestPath);
  const script=expandShebang(rootfs,guestPath,argv);
  if (script!==null) {
    guestPath=canonicalizeGuestPath(rootfs,script.guestPath);
    argv=script.argv;
  }
  const executable=`${rootfs}${guestPath}`;
  const info=readElfLoadInfo(executable);
  const interpreter=info.interpreter;
  const loader=interpreter===null?null:`${rootfs}${interpreter}`;
  return { rootfs, executable, interpreter, loader, argv:argv.length?argv:[pathname] };
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
  const envStrings=Object.entries(guestEnvironment).map(([key,value])=>`${key}=${value}`);
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

// Linux arm64 syscall -> pathname registers. Symlink targets are intentionally
// not translated; only the directory entry being created is a host pathname.
const PATH_ARGUMENTS = new Map([
  [33,[{path:1,dirfd:0,deref:false}]], [34,[{path:1,dirfd:0,deref:false}]], [35,[{path:1,dirfd:0,deref:false}]],
  [36,[{path:2,dirfd:1,deref:false}]], [37,[{path:1,dirfd:0,deref:false},{path:3,dirfd:2,deref:false}]],
  [38,[{path:1,dirfd:0,deref:false},{path:3,dirfd:2,deref:false}]], [43,[{path:0}]], [45,[{path:0}]],
  [48,[{path:1,dirfd:0}]], [49,[{path:0}]], [51,[{path:0}]],
  [53,[{path:1,dirfd:0}]], [54,[{path:1,dirfd:0}]],
  [56,[{path:1,dirfd:0,nofollow:{arg:2,mask:0x20000n}}]],
  [78,[{path:1,dirfd:0,deref:false}]],
  [79,[{path:1,dirfd:0,nofollow:{arg:3,mask:0x100n}}]], [88,[{path:1,dirfd:0}]],
  [89,[{path:0}]], [276,[{path:1,dirfd:0,deref:false},{path:3,dirfd:2,deref:false}]],
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

function resolveGuestPath(pid,rootfs,task,state,path,spec) {
  const absolute=path.startsWith("/")?posix.normalize(path):posix.resolve(
    spec.dirfd===undefined?task.cwd:fdGuestBase(pid,rootfs,task,
      Number(BigInt.asIntN(32,getX(state.regs,spec.dirfd)))),path);
  const flagSaysNoFollow=spec.nofollow!==undefined &&
    (getX(state.regs,spec.nofollow.arg)&spec.nofollow.mask)!==0n;
  return canonicalizeGuestPath(rootfs,absolute,
    {derefFinal:spec.deref!==false&&!flagSaysNoFollow});
}

function isKernelFilesystem(path) {
  return ["/proc","/dev","/sys"].some((prefix)=>path===prefix||path.startsWith(`${prefix}/`));
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
    pendingCwd:null, pendingGetcwd:null, cwd:"/", scratch:trampoline+4096n+512n }]]);
  tasks.get(pid).trampoline=trampoline;
  tasks.get(pid).borrowPc=images.interpreter?.entry??images.main.entry;
  let rootExit=1;
  while (tasks.size>0) {
    for (const [taskPid,task] of tasks) {
      if (!task.running) {
        if (call(PTRACE_SYSCALL,taskPid,0n,task.pendingSignal)<0n) throw new Error(`PTRACE_SYSCALL failed for ${taskPid}`);
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
          pendingCwd:null, pendingGetcwd:null, cwd:task.cwd,
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
        }
        task.pendingStat=undefined;
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
        resetExecAddressSpace(taskPid,task.trampoline);
        const nextImages=loadGuestImages(taskPid,task.trampoline,next);
        startGuest(taskPid,task.trampoline,nextImages,next);
        task.borrowPc=nextImages.interpreter?.entry??nextImages.main.entry;
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
    if (syscall===80) task.pendingStat={buffer:getX(state.regs,1),kind:"stat"};
    if (syscall===291) task.pendingStat={buffer:getX(state.regs,4),kind:"statx"};
    if (syscall===SYS_GETCWD) {
      task.pendingGetcwd={ buffer:getX(state.regs,0), size:getX(state.regs,1) };
      continue;
    }
    if (syscall===221) {
      if (process.env.PROOT_BUN_VERBOSE==="1")
        console.error(`[ptrace] pid=${taskPid} execve path=0x${getX(state.regs,0).toString(16)} argv=0x${getX(state.regs,1).toString(16)}`);
      try { task.pendingExec=prepareExecGuest(taskPid,rootfs,task,state); }
      catch (error) {
        if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] pid=${taskPid} exec capture failed: ${error.message}`);
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
        const translated=flags&~CLONE_NS_MASK;
        if (translated!==flags) {
          memory.poke(taskPid,args,translated);
          if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] pid=${taskPid} clone3 flags 0x${flags.toString(16)} -> 0x${translated.toString(16)}`);
        }
      }
      continue;
    }
    const arguments_=PATH_ARGUMENTS.get(syscall);
    if (arguments_===undefined) continue;
    let scratch=task.scratch, changed=false;
    for (const spec of arguments_) {
      const address=getX(state.regs,spec.path);
      if (address<4096n) continue;
      let guestPath;
      try { guestPath=readCString(memory,taskPid,address); }
      catch (error) { if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] skipped pid=${taskPid} syscall=${syscall}: ${error.message}`); continue; }
      if (isKernelFilesystem(guestPath)||guestPath.startsWith(`${rootfs}/`)) continue;
      let absoluteGuest;
      try { absoluteGuest=resolveGuestPath(taskPid,rootfs,task,state,guestPath,spec); }
      catch (error) { throw new Error(`pid ${taskPid} syscall ${syscall}: ${error.message}`); }
      if (syscall===SYS_CHDIR && spec.path===0) task.pendingCwd=absoluteGuest;
      const host=absoluteGuest==="/"?rootfs:`${rootfs}${absoluteGuest}`;
      if (process.env.PROOT_BUN_VERBOSE==="1") console.error(`[ptrace] pid=${taskPid} ${guestPath} (${absoluteGuest}) -> ${host}`);
      writeCString(memory,taskPid,scratch,host); setX(state.regs,spec.path,scratch);
      scratch+=BigInt((new TextEncoder().encode(host).length+8)&~7); changed=true;
    }
    if (changed) putRegisters(taskPid,state);
  }
  return rootExit;
}
