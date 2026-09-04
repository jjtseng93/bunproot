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
const USAGE = "usage: bunproot [-b HOST[:GUEST]]... -S ROOTFS COMMAND [ARG ...]";

const HELP = `${USAGE}

  -S, --rootfs ROOTFS      run COMMAND with ROOTFS as its root directory
  -b, --bind HOST[:GUEST]  make a host path visible inside the guest, at the
                           same pathname or at GUEST; repeatable
  -m, --mount              another name for --bind, not a different thing
  -h, --help               show this message
  -V, --version            show the version and exit
      --download-alpine    fetch and checksum an Alpine minirootfs into the
                           current directory, then exit

Either half of a binding may be relative to the current directory, and the
first colon separates them. The most specific binding wins; the rootfs is the
binding at "/". /proc, /dev and /sys reach the host kernel without one.

PROOT_BUN_VERBOSE=1   trace what the tracer does
PROOT_BUN_PROFILE=1   report stop counts and where the time went
PROOT_NO_SECCOMP      stop on every syscall instead of filtering
PROOT_IGNORE_MISSING_BINDINGS   do not warn about a binding that does not exist`;

export function parseArguments(argv) {
  const bindings = [];
  let rootfs = null, index = 0;
  for (; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "-b" || argument === "--bind" || argument === "-m" || argument === "--mount") {
      if (argv[++index] === undefined) throw new Error(`${argument} needs a binding\n${USAGE}`);
      bindings.push(argv[index]);
      continue;
    }
    if (argument.startsWith("--bind=") || argument.startsWith("--mount=")) {
      bindings.push(argument.slice(argument.indexOf("=") + 1));
      continue;
    }
    if (argument === "-h" || argument === "--help") return { help: true };
    if (argument === "-V" || argument === "--version") return { version: true };
    if (argument === "-S" || argument === "--rootfs") {
      if (argv[++index] === undefined) throw new Error(`${argument} needs a rootfs\n${USAGE}`);
      // Resolve this before the bootstrap changes cwd to the rootfs. Otherwise
      // a caller-relative rootfs is interpreted again from inside that rootfs
      // and subsequent host-path translations acquire the wrong prefix.
      rootfs = resolve(argv[index]);
      continue;
    }
    break;
  }
  const command = argv.slice(index);
  if (rootfs === null || command.length === 0) throw new Error(USAGE);
  return { rootfs, bindings, command };
}
export function run(argv) {
  const parsed = parseArguments(argv);
  // Only a --help before the command is ours; after it, it belongs to the guest.
  if (parsed.help) { console.log(HELP); return 0; }
  if (parsed.version) { console.log(`${pkg.name} ${pkg.version}`); return 0; }
  const { rootfs, bindings, command } = parsed;
  const mounts = createBindings(rootfs, bindings);
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
    name: basename(command[0]), interpreter, loader, argv: guestArgv });
}
