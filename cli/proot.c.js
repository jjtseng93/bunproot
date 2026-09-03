import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { FFIType, ptr } from "bun:ffi";
import { cString, openLibrary } from "../ffi.js";
import { readElfInterpreter } from "../execve/elf.c.js";
import { canonicalizeGuestPath } from "../path/canon.c.js";
import { traceProcess } from "../ptrace/ptrace.c.js";
import { bootstrapEnvironment } from "../env.js";

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
export function parseArguments(argv) {
  if (argv[0] !== "-S" || !argv[1] || !argv[2]) throw new Error("usage: proot -S ROOTFS COMMAND [ARG ...]");
  // Resolve this before the bootstrap changes cwd to the rootfs. Otherwise a
  // caller-relative rootfs is interpreted again from inside that rootfs and
  // subsequent host-path translations acquire the wrong prefix.
  return { rootfs: resolve(argv[1]), command: argv.slice(2) };
}
export function run(argv) {
  const { rootfs, command } = parseArguments(argv);
  const guestExecutable=command[0].startsWith("/")
    ? canonicalizeGuestPath(rootfs,command[0])
    : command[0];
  const executable=guestExecutable.startsWith("/")?`${rootfs}${guestExecutable}`:guestExecutable;
  if (!existsSync(executable)) throw new Error(`guest executable not found: ${executable}`);
  const interpreter = readElfInterpreter(executable);
  const loader = interpreter === null ? null : `${rootfs}${interpreter}`;
  if (loader !== null && !existsSync(loader)) throw new Error(`ELF interpreter not found: ${interpreter} (${loader})`);
  // Android only accepts the initial native ELF through its own linker. The
  // shell is a disposable bootstrap: it stops before any guest is loaded, and
  // will later be replaced in-place by the JS-controlled remote ELF loader.
  const childArgv = [
    "/system/bin/linker64", "/system/bin/sh", "-c",
    "kill -19 $$; while :; do :; done", "proot-bun",
  ];
  const pid = spawnTracee(childArgv, bootstrapEnvironment());
  return traceProcess(pid, rootfs, { rootfs, executable, guestPath: guestExecutable, interpreter, loader, argv: command });
}
