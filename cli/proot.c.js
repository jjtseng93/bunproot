import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { FFIType, ptr } from "bun:ffi";
import { cString, lazySymbols } from "../ffi.js";
import { readElfInterpreter } from "../execve/elf.c.js";
import { expandShebang, makeGuestPaths } from "../execve/shebang.c.js";
import { canonicalizeGuestPath } from "../path/canon.c.js";
import { createBindings } from "../path/binding.c.js";
import { traceProcess } from "../ptrace/ptrace.c.js";
import { bootstrapEnvironment, guestEnvironment } from "../env.js";
import pkg from "../package.json" with { type: "json" };
import { parseDnsMode, resolverBindings } from "../dns.js";

const OVERFLOW_ID = resolve(import.meta.dir,"../fakeid.txt");
/** Render markdown at the terminal's own width.
 *
 * Bun's renderer wraps near 79 and never asks the terminal how wide it is --
 * not even on a TTY that reports 30 columns -- so the width has to be handed
 * to it. Off a TTY there is nothing to ask, and its default is as good as any.
 */
function renderMarkdown(markdown) {
  const columns = process.stdout.columns;
  return Bun.markdown.ansi(markdown,
    columns ? { hyperlinks: true, columns } : { hyperlinks: true });
}
const FORMAT_DOCUMENTATION =
  "https://github.com/jjtseng93/bunproot/blob/main/link2symlink.md";

const libc = lazySymbols("libc", {
  posix_spawn: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
});

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
  const status = libc.posix_spawn(ptr(pidBytes), ptr(path), null, null, ptr(args.vector), ptr(environment.vector));
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

  --readme
      render README.md in the terminal, with hyperlinks where it has links

  --l2s-status ROOTFS
      report the state of a rootfs's emulated hard-link store, and exit.
      Reads only; takes a rootfs of its own and needs no -S

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
    if (argument === "--readme") return { readme: true };
    if (argument === "--l2s-status" || argument.startsWith("--l2s-status=")) {
      // A whole command line of its own: `bunproot --l2s-status ROOTFS` and
      // nothing besides. It enters no rootfs and honours no binding, so any
      // other argument means the caller expected something this does not do
      // -- running a command in that rootfs, or reading the one -S names.
      // Both are worse discovered here than silently ignored.
      const inline = argument.startsWith("--l2s-status=");
      let target;
      if (inline) target = argument.slice(13);
      else if ((target = argv[++index]) === undefined)
        throw new Error(`--l2s-status needs a rootfs\n${USAGE}\n${TRY_HELP}`);
      // The rootfs they meant is the one they passed to -S, not whatever
      // happened to follow --l2s-status.
      if (rootfs !== null) throw new Error(
        "--l2s-status takes its own rootfs; it does not combine with -S\n" +
        `try \`bunproot --l2s-status ${rootfs}\``);
      if ((inline ? index : index - 1) !== 0 || index + 1 !== argv.length)
        throw new Error(
          "--l2s-status is a command of its own and takes nothing else:\n" +
          `  bunproot --l2s-status ${target}`);
      return { l2sStatus: resolve(target) };
    }
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
/**
 * `--l2s-status`: what state a rootfs's emulated hard-link store is in.
 *
 * Deliberately free of the tracer: it opens no library, starts no guest, and
 * writes nothing, so it answers on a host where the Android bionic this port
 * normally loads cannot be opened at all.
 */
async function reportLinkStore(rootfs) {
  try {
    if (!statSync(rootfs).isDirectory()) throw new Error("not a directory");
  } catch { throw new Error(`cannot read rootfs: ${rootfs}`); }

  const { scanStore, scanUpstreamStore } =
    await import("../extension/link2symlink/link2symlink.c.js");
  const report = await scanStore(rootfs);
  const upstream = scanUpstreamStore(rootfs);

  // A long pathname inside inline code gets hard-wrapped mid-word; in a code
  // block it stays whole and stays copyable.
  const blocks = [`# ${basename(rootfs) || rootfs}`, `    ${rootfs}`];

  if (report === null && upstream === null)
    blocks.push("No link2symlink store here. Nothing in this rootfs emulates a hard link.");
  else if (report === null) blocks.push(...describeUpstream(rootfs, upstream));
  else {
    blocks.push(...describePort(report));
    if (upstream !== null) {
      // Both stores in one rootfs is the case worth shouting about: neither
      // knows the other exists, so a file written through one is invisible
      // to the other.
      blocks.push("# An original store is here too",
        ...describeUpstream(rootfs, upstream),
        "## Why that matters",
        "The two stores do not know about each other. A file written through one is invisible to the other, and neither repairs the other.");
    }
  }
  if (report !== null || upstream !== null)
    blocks.push("## Format reference", `- [link2symlink.md](${FORMAT_DOCUMENTATION})`);
  console.log(renderMarkdown(blocks.join("\n\n")));
  return 0;
}

/** A bulleted list of name/value pairs. Lighter than a table, and it does not
 *  carry a frame that a narrow terminal has to fit. */
const bullets = (rows) =>
  rows.map(([name, value]) => `- **${name}:** ${value}`).join("\n");

/** This port's store. Everything is read back out of the symlinks, so a
 *  rootfs that was copied, moved or half-converted describes what it is. */
function describePort(report) {
  const prefixes = [...report.prefixes].sort((a, b) => b[1] - a[1]);
  const form = report.pinned === 0 ? "portable"
    : report.portable === 0 ? "pinned" : "mixed";
  const blocks = ["## Format", bullets([
    ["store", ".proot.l2s, this port's own"],
    ["paths", form],
  ])];

  if (form === "portable")
    blocks.push("Every target is guest-absolute, so this rootfs can still be moved and the store follows it.");
  else if (form === "pinned")
    blocks.push("Targets carry a host prefix, so tools outside the rootfs can follow them. Moving the rootfs breaks every one.",
      "### Pinned to", `    ${prefixes[0][0]}`);
  else {
    blocks.push("A conversion stopped partway. Running it again completes it.", "### Pinned to");
    // Not a bullet: an indented pathname after one is read as that bullet's
    // continuation and gets reflowed, which breaks the path in half.
    for (const [prefix, count] of prefixes) blocks.push(`${count} refs to:`, `    ${prefix}`);
  }

  const rows = [["refs", report.refs], ["objects", report.objects.size]];
  if (report.pinned > 0 && report.portable > 0)
    rows.push(["portable", report.portable], ["pinned", report.pinned]);
  rows.push(["live aliases", report.live]);
  if (report.stale > 0) rows.push(["stale refs", report.stale]);
  if (report.malformed > 0) rows.push(["broken refs", report.malformed]);
  blocks.push("## Counts", bullets(rows));

  if (report.stale > 0)
    blocks.push("## Stale refs",
      "A stale ref is one whose guest name no longer points back at it: the file was replaced or removed. It costs space, not correctness.");
  return blocks;
}

/** The original PRoot's store: how big, and whether any of it is still
 *  reachable. Upstream bakes host pathnames into its targets, so that is
 *  decided by where the rootfs actually is now. */
function describeUpstream(rootfs, upstream) {
  const blocks = ["## Format", bullets([
    ["store", ".l2s, the original PRoot's"],
    ["paths", "host-absolute"],
  ]), "This port cannot read that format. Its targets carry host pathnames, which is also why moving such a rootfs breaks it."];
  if (!upstream.collected) {
    blocks.push("## Counts",
      "Its entries are not collected under /.l2s, so they sit beside the files they emulate. Counting them would mean walking the whole rootfs, which this does not do.");
    return blocks;
  }

  const rows = [["objects", upstream.finals], ["links", upstream.links]];
  if (upstream.intermediates !== upstream.finals)
    rows.push(["dangling", `${upstream.intermediates} inter.`]);
  blocks.push("## Counts", bullets(rows));

  if (upstream.prefix === null) {
    blocks.push("## Where it was written", "No target says where this store was made.");
    return blocks;
  }
  blocks.push("## Where it was written", `    ${upstream.prefix}`);
  // Through symlinks: a rootfs reached by another name has not moved, and its
  // files are perfectly reachable.
  const resolvePath = (path) => { try { return realpathSync(path); } catch { return path; } };
  if (resolvePath(upstream.prefix) === resolvePath(rootfs)) {
    const top = `/${upstream.prefix.split("/")[1] ?? ""}`;
    blocks.push(bullets([["status", "still there, so its files are reachable"]]),
      "### Reading it",
      "Bind that pathname back in and the targets resolve:", `    -b ${upstream.prefix}`);
    if (top !== upstream.prefix && top !== "/")
      blocks.push("or the mount point holding it:", `    -b ${top}`);
    blocks.push("> Read-only: writing through this port lays a second store beside the first.");
  } else {
    blocks.push(bullets([["status", "the rootfs has moved since"]]),
      "Those targets resolve to nothing now. The original PRoot cannot read it here either: the pathnames are baked into the store.",
      "### Recovering it",
      "Move the rootfs back to that pathname, or make the pathname lead here again and bind it in:",
      `    ln -s ${rootfs} ${upstream.prefix}`,
      "then run with:", `    -b ${upstream.prefix}`,
      "The parent of that pathname has to exist and be writable.",
      "> Binding the current location under the old name does not work. A symlink inside a binding keeps its absolute target, and the tracer does not translate that a second time.");
  }
  return blocks;
}

export function run(argv) {
  const parsed = parseArguments(argv);
  // Only a --help before the command is ours; after it, it belongs to the guest.
  if (parsed.help) { console.log(HELP); return 0; }
  if (parsed.version) { console.log(`${pkg.name} ${pkg.version}`); return 0; }
  if (parsed.l2sStatus !== undefined) return reportLinkStore(parsed.l2sStatus);
  if (parsed.readme) {
    const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8");
    console.log(renderMarkdown(readme));
    return 0;
  }
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
