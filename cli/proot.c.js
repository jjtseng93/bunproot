import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { FFIType, ptr } from "bun:ffi";
import { cString, openLibrary } from "../ffi.js";
import { readElfInterpreter } from "../execve/elf.c.js";
import { expandShebang, makeGuestPaths } from "../execve/shebang.c.js";
import { canonicalizeGuestPath } from "../path/canon.c.js";
import { createBindings } from "../path/binding.c.js";
import { traceProcess } from "../ptrace/ptrace.c.js";
import { bootstrapEnvironment, guestEnvironment } from "../env.js";
import pkg from "../package.json" with { type: "json" };
import { parseDnsMode, resolverBindings } from "../dns.js";

const OVERFLOW_ID = resolve(import.meta.dir,"../fakeid.txt");

const { posix_spawn } = openLibrary("libc", {
  posix_spawn: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
}).symbols;

function pointerVector(strings) {
  const storage = strings.map(cString);
  const vector = new Uint8Array((storage.length + 1) * 8);
  const view = new DataView(vector.buffer);
  storage.forEach((bytes, index) => view.setBigUint64(index * 8, BigInt(ptr(bytes)), true));
  return { storage, vector };
}

function spawnTracee(argv, env) {
  const path = cString(argv[0]);
  const args = pointerVector(argv);
  const environment = pointerVector(Object.entries(env).map(([key, value]) => `${key}=${value}`));
  const pidBytes = new Uint8Array(4);
  const status = posix_spawn(ptr(pidBytes), ptr(path), null, null, ptr(args.vector), ptr(environment.vector));
  if (status !== 0) throw new Error(`posix_spawn failed: ${status}`);
  return new DataView(pidBytes.buffer).getInt32(0, true);
}
const USAGE = "Usage: bunproot [OPTION ...] -S ROOTFS COMMAND [ARG ...]";
// Nothing about the usage line says where the rest is, and the rest includes
// the debug environment variables, so every way of getting the invocation
// wrong ends by naming --help.
const TRY_HELP = "try `bunproot --help` for the options and the debug environment variables";

const HELP = `${USAGE}

  -S, --rootfs ROOTFS
      run COMMAND with ROOTFS as its root directory

  -b, --bind HOST[:GUEST]
      bind HOST at GUEST, or at the same path; repeatable

  -m, --mount
      another name for --bind, not a different thing

  --dns MODE
      resolver binding: auto (default), simple, or off

  -koe, --kill-on-exit
      kill all remaining guest processes when COMMAND exits

  --download-alpine
      download and verify an Alpine minirootfs, then exit

  -h, --help
      show this message

  -V, --version
      show the version and exit

Either half of a binding may be relative to the current directory, and the
first colon separates them. The most specific binding wins; the rootfs is the
binding at "/". /proc, /dev and /sys reach the host kernel without one.

PROOT_BUN_VERBOSE=1   trace what the tracer does
PROOT_BUN_PROFILE=1   report stop counts and where the time went
PROOT_NO_SECCOMP      stop on every syscall instead of filtering
PROOT_IGNORE_MISSING_BINDINGS   do not warn about a binding that does not exist`;

export function parseArguments(argv) {
  // A binding is a specification string; --dns contributes a token expanded
  // once the rootfs is known, in the place it was written.
  const bindings = [];
  let rootfs = null, sawDns = false, killOnExit = false, index = 0;
  for (; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "-b" || argument === "--bind" || argument === "-m" || argument === "--mount") {
      if (argv[++index] === undefined) throw new Error(`${argument} needs a binding\n${USAGE}\n${TRY_HELP}`);
      bindings.push(argv[index]);
      continue;
    }
    if (argument.startsWith("--bind=") || argument.startsWith("--mount=")) {
      bindings.push(argument.slice(argument.indexOf("=") + 1));
      continue;
    }
    if (argument === "--dns") {
      if (argv[++index] === undefined) throw new Error(`--dns needs a mode\n${USAGE}\n${TRY_HELP}`);
      bindings.push({ dns: parseDnsMode(argv[index]) }); sawDns = true;
      continue;
    }
    if (argument.startsWith("--dns=")) {
      bindings.push({ dns: parseDnsMode(argument.slice(6)) }); sawDns = true;
      continue;
    }
    if (argument === "-h" || argument === "--help") return { help: true };
    if (argument === "-V" || argument === "--version") return { version: true };
    if (argument === "-koe" || argument === "--kill-on-exit") { killOnExit = true; continue; }
    if (argument === "-S" || argument === "--rootfs") {
      if (argv[++index] === undefined) throw new Error(`${argument} needs a rootfs\n${USAGE}\n${TRY_HELP}`);
      // Resolve this before the bootstrap changes cwd to the rootfs. Otherwise
      // a caller-relative rootfs is interpreted again from inside that rootfs
      // and subsequent host-path translations acquire the wrong prefix.
      rootfs = resolve(argv[index]);
      continue;
    }
    break;
  }
  const command = argv.slice(index);
  if (rootfs === null || command.length === 0) throw new Error(`${USAGE}\n${TRY_HELP}`);
  // The default sits ahead of everything the caller wrote, so any binding of
  // theirs on the same pathname is the later one and wins.
  if (!sawDns) bindings.unshift({ dns: "auto" });
  return { rootfs, bindings, command, killOnExit };
}
export function run(argv) {
  const parsed = parseArguments(argv);
  // Only a --help before the command is ours; after it, it belongs to the guest.
  if (parsed.help) { console.log(HELP); return 0; }
  if (parsed.version) { console.log(`${pkg.name} ${pkg.version}`); return 0; }
  const { rootfs, bindings, command, killOnExit } = parsed;
  const compatibilityBindings=[
    "/dev:/dev",
    // Android exposes /dev/udmabuf in directory listings but SELinux denies
    // app UIDs even a stat(2).  bubblewrap's --dev copies every visible node,
    // so present the harmless, accessible null device under that name.  Keep
    // this in the tracer instead of requiring every enter_rootfs launcher to
    // know about an Android-specific device.
    "/dev/null:/dev/udmabuf",
    `${OVERFLOW_ID}:/proc/sys/kernel/overflowuid`,
    `${OVERFLOW_ID}:/proc/sys/kernel/overflowgid`,
  ];
  const mounts = createBindings(rootfs, [...compatibilityBindings,...bindings.flatMap((entry) =>
    typeof entry === "string" ? [entry] : resolverBindings(rootfs, entry.dns))]);
  let guestExecutable=command[0].startsWith("/")
    ? canonicalizeGuestPath(mounts,command[0],{preserveInternalFinal:true})
    : command[0];
  let executable=guestExecutable.startsWith("/")?mounts.toHost(canonicalizeGuestPath(mounts,guestExecutable)):guestExecutable;
  if (!existsSync(executable)) throw new Error(`guest executable not found: ${executable}`);
  // The initial command goes through the same `#!` expansion as a nested
  // execve; without it `proot -S ROOTFS /usr/bin/script` reads the script as
  // an ELF and reports a truncated one.
  let guestArgv=command;
  const guestPaths=makeGuestPaths(mounts,
    guestEnvironment().find((entry)=>entry.startsWith("PATH="))?.slice(5));
  const script=expandShebang(executable,guestExecutable,guestArgv,guestPaths);
  if (script!==null) {
    guestExecutable=canonicalizeGuestPath(mounts,script.guestPath,{preserveInternalFinal:true});
    executable=mounts.toHost(canonicalizeGuestPath(mounts,guestExecutable));
    guestArgv=script.argv;
    if (!existsSync(executable)) throw new Error(`script interpreter not found: ${executable}`);
  }
  const interpreter = readElfInterpreter(executable);
  const loader = interpreter === null ? null : mounts.toHost(interpreter);
  if (loader !== null && !existsSync(loader)) throw new Error(`ELF interpreter not found: ${interpreter} (${loader})`);
  // Android only accepts the initial native ELF through its own linker. The
  // shell is a disposable bootstrap: it stops before any guest is loaded, and
  // will later be replaced in-place by the JS-controlled remote ELF loader.
  const childArgv = [
    "/system/bin/linker64", "/system/bin/sh", "-c",
    "kill -19 $$; while :; do :; done", "proot-bun",
  ];
  const pid = spawnTracee(childArgv, bootstrapEnvironment());
  return traceProcess(pid, mounts, { executable, guestPath: guestExecutable,
    name: basename(command[0]), interpreter, loader, argv: guestArgv }, { killOnExit });
}
