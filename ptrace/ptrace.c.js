import { FFIType, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";
import { openLibrary } from "../ffi.js";
import { getPc, getSp, getSyscallNumber, getX, makeIovec, makeRegisterSet, NT_PRSTATUS, setPc, setX } from "../tracee/reg.c.js";
import { readCString, writeBytes, writeCString } from "../tracee/mem.c.js";
import { readElfLoadInfo, relocateElf } from "../execve/elf.c.js";

const PTRACE_PEEKTEXT=1, PTRACE_PEEKDATA=2, PTRACE_POKETEXT=4, PTRACE_POKEDATA=5;
const PTRACE_CONT=7, PTRACE_ATTACH=16, PTRACE_SYSCALL=24;
const PTRACE_GETREGSET=0x4204, PTRACE_SETREGSET=0x4205, PTRACE_SETOPTIONS=0x4200;
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
  const bytes = new Uint8Array(4);
  if (native.waitpid(pid, ptr(bytes), options) < 0) throw new Error("waitpid failed");
  return new DataView(bytes.buffer).getInt32(0, true);
}
function getRegisters(pid) {
  const regs = makeRegisterSet(), iovec = makeIovec(regs);
  if (call(PTRACE_GETREGSET, pid, BigInt(NT_PRSTATUS), BigInt(iovec.pointer)) < 0n) throw new Error("PTRACE_GETREGSET failed");
  return { regs, iovec };
}
function putRegisters(pid, state) {
  if (call(PTRACE_SETREGSET, pid, BigInt(NT_PRSTATUS), BigInt(state.iovec.pointer)) < 0n) throw new Error("PTRACE_SETREGSET failed");
}

const ARM64_SYSCALL_TRAMPOLINE = 0xd4200000d4000001n; // svc #0; brk #0
const SYS_GETPID = 172, SYS_MMAP = 222;
const SYS_OPENAT = 56, SYS_CLOSE = 57;

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

function initializeRemoteSyscalls(pid) {
  const borrowedPc = getPc(getRegisters(pid).regs);
  const remotePid = remoteSyscallAt(pid, borrowedPc, SYS_GETPID);
  if (remotePid !== BigInt(pid)) throw new Error(`remote getpid mismatch: expected ${pid}, got ${remotePid}`);
  const page = remoteSyscallAt(pid, borrowedPc, SYS_MMAP, [0n, 4096n, 7n, 0x22n, -1n, 0n]);
  if (page < 0n) throw new Error(`remote mmap failed: ${page}`);
  memory.poke(pid, page, ARM64_SYSCALL_TRAMPOLINE);
  return page;
}

function remoteCall(pid, trampoline, syscall, args=[]) {
  return remoteSyscallAt(pid, trampoline, syscall, args);
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
  const envStrings=Object.entries(process.env).filter(([key])=>key!=="LD_PRELOAD").map(([key,value])=>`${key}=${value}`);
  const envPointers=envStrings.map(putString);
  const argvPointers=guest.argv.map(putString);
  const execfn=argvPointers[0];
  cursor&=~15;
  const replacements=new Map([[3n,images.main.phoff+images.main.mappings[0].address],[4n,BigInt(images.main.phentsize)],
    [5n,BigInt(images.main.phnum)],[7n,images.interpreter?.mappings[0].address??0n],[9n,images.main.entry],[31n,execfn]]);
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

// arm64 syscall -> pathname argument register. This is the first executable subset.
const PATH_ARGUMENT = new Map([
  [34,1], [35,1], [37,1], [38,1], [48,1], [49,0], [56,1],
  [78,1], [79,1], [221,0], [281,1], [291,1], [437,1],
]);

export function traceProcess(pid, rootfs, guest = null) {
  const initial = wait(pid, 2); // WUNTRACED: observe the pre-exec SIGSTOP.
  if ((initial & 0xff) !== 0x7f) throw new Error("tracee did not stop before exec");
  if (call(PTRACE_ATTACH, pid) < 0n) throw new Error("PTRACE_ATTACH failed");
  wait(pid);
  // TRACESYSGOOD distinguishes syscall stops; EXITKILL prevents a bootstrap
  // loop from surviving if the Bun tracer crashes or is interrupted.
  if (call(PTRACE_SETOPTIONS, pid, 0n, 0x100001n) < 0n) throw new Error("PTRACE_SETOPTIONS failed");
  if (process.env.PROOT_BUN_VERBOSE === "1" && guest !== null)
    console.error(`[ptrace] bootstrap pid=${pid} executable=${guest.executable} interpreter=${guest.interpreter ?? "static"}`);
  const trampoline = initializeRemoteSyscalls(pid);
  if (process.env.PROOT_BUN_VERBOSE === "1")
    console.error(`[ptrace] remote getpid=${pid}; trampoline mmap=0x${trampoline.toString(16)}`);
  const images = loadGuestImages(pid, trampoline, guest);
  if (process.env.PROOT_BUN_VERBOSE === "1")
    console.error(`[ptrace] mapped guest entry=0x${images.main.entry.toString(16)} interpreter entry=${images.interpreter ? `0x${images.interpreter.entry.toString(16)}` : "static"}`);
  const guestSp=startGuest(pid,trampoline,images,guest);
  if (process.env.PROOT_BUN_VERBOSE === "1") console.error(`[ptrace] guest sp=0x${guestSp.toString(16)}`);
  let entering = true;
  let pendingSignal = 0n;
  while (true) {
    if (call(PTRACE_SYSCALL, pid, 0n, pendingSignal) < 0n) throw new Error("PTRACE_SYSCALL failed");
    pendingSignal = 0n;
    const status = wait(pid);
    if ((status & 0x7f) === 0) return (status >> 8) & 0xff;
    if ((status & 0x7f) !== 0x7f) return 1;
    const signal = (status >> 8) & 0xff;
    if (signal !== 0x85) {
      const stopped = getRegisters(pid);
      if (process.env.PROOT_BUN_VERBOSE === "1")
        console.error(`[ptrace] signal=${signal} pc=0x${getPc(stopped.regs).toString(16)} syscall=${getSyscallNumber(stopped.regs)}`);
      if (signal === 31) { // SIGSYS from Android's app seccomp policy.
        setX(stopped.regs,0,BigInt.asUintN(64,-38n)); // expose ENOSYS to glibc
        putRegisters(pid,stopped);
        continue;
      }
      pendingSignal = BigInt(signal);
      continue;
    }
    if (!entering) { entering = true; continue; }
    entering = false;
    const state = getRegisters(pid);
    const argument = PATH_ARGUMENT.get(getSyscallNumber(state.regs));
    if (argument === undefined) continue;
    const address = getX(state.regs, argument);
    if (address === 0n) continue;
    if (address < 4096n) continue;
    let guest;
    try {
      guest = readCString(memory, pid, address);
    } catch (error) {
      if (process.env.PROOT_BUN_VERBOSE === "1")
        console.error(`[ptrace] skipped syscall ${getSyscallNumber(state.regs)} address 0x${address.toString(16)}: ${error.message}`);
      continue;
    }
    if (!guest.startsWith("/") || guest === "/dev/null" || guest.startsWith(`${rootfs}/`)) continue;
    const host = guest === "/" ? rootfs : `${rootfs}${guest}`;
    if (process.env.PROOT_BUN_VERBOSE === "1") console.error(`[ptrace] ${guest} -> ${host}`);
    const scratch = trampoline + 512n;
    writeCString(memory, pid, scratch, host);
    setX(state.regs, argument, scratch);
    putRegisters(pid, state);
  }
}
