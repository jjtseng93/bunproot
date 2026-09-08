import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { FFIType, ptr } from "bun:ffi";
import { cString, lazySymbols } from "../ffi.js";
import { readElfInterpreter } from "../execve/elf.c.js";
import { expandShebang, makeGuestPaths } from "../execve/shebang.c.js";
import { canonicalizeGuestPath } from "../path/canon.c.js";
import { createBindings } from "../path/binding.c.js";
import { storeIsPinned } from "../extension/link2symlink/link2symlink.c.js";
import { traceProcess } from "../ptrace/ptrace.c.js";
import { bootstrapEnvironment, guestEnvironment, verbose } from "../env.js";
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
const DOCUMENT_FLAGS = {
  "--readme": "../README.md", "--l2s-docs": "../link2symlink.md",
};
const STORE_COMMANDS = {
  "--l2s-status": "status", "--l2s-pin": "pin", "--l2s-unpin": "unpin",
};
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
const USAGE = "Usage: bunproot [OPTION ...] (-S ROOTFS | --android-container ROOTFS) [COMMAND [ARG ...]]";
// Nothing about the usage line says where the rest is, and the rest includes
// the debug environment variables, so every way of getting the invocation
// wrong ends by naming --help.
const TRY_HELP = "try `bunproot --help` for the options and the debug environment variables";

const HELP = `${USAGE}

  -S, --rootfs ROOTFS
      run COMMAND with ROOTFS as its root directory; COMMAND defaults to
      /bin/sh

  --android-container ROOTFS
      use ROOTFS, which may be an empty directory, with Android's system,
      APEX, linker configuration and this Bun bound in; COMMAND defaults to
      /system/bin/sh

  -b, --bind HOST[:GUEST]
      bind HOST at GUEST, or at the same path; repeatable

  -m, --mount
      another name for --bind, not a different thing

  --dns MODE
      resolver binding: auto (default), simple, or off

  -koe, --kill-on-exit
      kill all remaining guest processes when COMMAND exits

Emulated hard links. The first four take a rootfs of their own, run nothing
inside it, and combine with nothing else; the last is an option to a normal
run:

  --l2s-status ROOTFS
      report the state of that rootfs's emulated hard-link store

  --l2s-pin ROOTFS
      rewrite the store so tools outside the rootfs can follow its
      emulated hard links. The rootfs can no longer be moved, and the
      guest cannot use them until it is unpinned

  --l2s-unpin ROOTFS
      rewrite it back to the portable form

  --l2s-docs
      render link2symlink.md, the on-disk format, in the terminal

  --l2s-ignore-pin
      enter a rootfs whose store is pinned, which is otherwise refused

These run without entering a rootfs, then exit:

  --download-alpine
      download and verify an Alpine minirootfs

  --readme
      render README.md in the terminal, with hyperlinks where it has links

  -h, --help
      show this message

  -V, --version
      show the version

Either half of a binding may be relative to the current directory, and the
first colon separates them. The most specific binding wins; the rootfs is the
binding at "/". /proc, /dev and /sys reach the host kernel without one.

PROOT_BUN_VERBOSE=1   trace what the tracer does
PROOT_BUN_STRACE=1    trace every guest syscall and substituted result/path
PROOT_BUN_PROFILE=1   report stop counts and where the time went
PROOT_NO_SECCOMP      stop on every syscall instead of filtering
PROOT_IGNORE_MISSING_BINDINGS   do not warn about a binding that does not exist`;

export function parseArguments(argv) {
  // A binding is a specification string; --dns contributes a token expanded
  // once the rootfs is known, in the place it was written.
  const bindings = [];
  let rootfs = null, androidContainer = false, sawDns = false, killOnExit = false, ignorePin = false, index = 0;
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
    if (DOCUMENT_FLAGS[argument] !== undefined) return { document: DOCUMENT_FLAGS[argument] };
    const storeAction = STORE_COMMANDS[argument.split("=")[0]];
    if (storeAction !== undefined) {
      // A whole command line of its own: `bunproot --l2s-status ROOTFS` and
      // nothing besides. It enters no rootfs and honours no binding, so any
      // other argument means the caller expected something this does not do
      // -- running a command in that rootfs, or reading the one -S names.
      // Both are worse discovered here than silently ignored.
      const flag = argument.split("=")[0];
      const inline = argument.includes("=");
      let target;
      if (inline) target = argument.slice(argument.indexOf("=") + 1);
      else if ((target = argv[++index]) === undefined)
        throw new Error(`${flag} needs a rootfs\n${USAGE}\n${TRY_HELP}`);
      // The rootfs they meant is the one they passed to -S, not whatever
      // happened to follow --l2s-status.
      if (rootfs !== null) throw new Error(
        `${flag} takes its own rootfs; it does not combine with -S\n` +
        `try \`bunproot ${flag} ${rootfs}\``);
      if ((inline ? index : index - 1) !== 0 || index + 1 !== argv.length)
        throw new Error(
          `${flag} is a command of its own and takes nothing else:\n` +
          `  bunproot ${flag} ${target}`);
      return { storeAction, storeRootfs: resolve(target) };
    }
    if (argument === "-V" || argument === "--version") return { version: true };
    if (argument === "-koe" || argument === "--kill-on-exit") { killOnExit = true; continue; }
    if (argument === "--l2s-ignore-pin") { ignorePin = true; continue; }
    if (argument === "--android-container" || argument.startsWith("--android-container=")) {
      if (rootfs !== null) throw new Error(`--android-container does not combine with -S\n${USAGE}\n${TRY_HELP}`);
      const target=argument.includes("=")?argument.slice(argument.indexOf("=")+1):argv[++index];
      if (!target) throw new Error(`--android-container needs a rootfs\n${USAGE}\n${TRY_HELP}`);
      rootfs=resolve(target); androidContainer=true;
      continue;
    }
    if (argument === "-S" || argument === "--rootfs") {
      if (argv[++index] === undefined) throw new Error(`${argument} needs a rootfs\n${USAGE}\n${TRY_HELP}`);
      if (androidContainer) throw new Error(`${argument} does not combine with --android-container\n${USAGE}\n${TRY_HELP}`);
      // Resolve this before the bootstrap changes cwd to the rootfs. Otherwise
      // a caller-relative rootfs is interpreted again from inside that rootfs
      // and subsequent host-path translations acquire the wrong prefix.
      rootfs = resolve(argv[index]);
      continue;
    }
    break;
  }
  let command = argv.slice(index);
  if (rootfs === null) throw new Error(`${USAGE}\n${TRY_HELP}`);
  if (command.length === 0) command=[androidContainer?"/system/bin/sh":"/bin/sh"];
  // The default sits ahead of everything the caller wrote, so any binding of
  // theirs on the same pathname is the later one and wins.
  if (!sawDns) bindings.unshift({ dns: "auto" });
  return { rootfs, bindings, command, killOnExit, ignorePin, ...(androidContainer && { androidContainer:true }) };
}
/**
 * `--l2s-status`: what state a rootfs's emulated hard-link store is in.
 *
 * Deliberately free of the tracer: it opens no library, starts no guest, and
 * writes nothing, so it answers on a host where the Android bionic this port
 * normally loads cannot be opened at all.
 */
async function runStoreCommand(rootfs, action) {
  try {
    if (!statSync(rootfs).isDirectory()) throw new Error("not a directory");
  } catch { throw new Error(`cannot read rootfs: ${rootfs}`); }

  const { scanStore, scanUpstreamStore, convertStore, pinnableRootfs } =
    await import("../extension/link2symlink/link2symlink.c.js");

  let converted = null;
  if (action !== "status") {
    // A rootfs whose own pathname carries the store's segment would produce
    // targets nothing could take apart again.
    if (action === "pin" && !pinnableRootfs(rootfs)) throw new Error(
      `cannot pin this rootfs: its pathname contains a .proot.l2s segment\n` +
      `  ${rootfs}\n` +
      "A pinned target would be indistinguishable from the store's own path,\n" +
      "and unpinning could not tell where the prefix ends.");
    converted = await convertStore(rootfs, action === "pin");
    if (converted === null) throw new Error(`no .proot.l2s store in ${rootfs}`);
  }

  const report = await scanStore(rootfs, { listStale: verbose });
  const upstream = scanUpstreamStore(rootfs);

  // A long pathname inside inline code gets hard-wrapped mid-word; in a code
  // block it stays whole and stays copyable.
  const blocks = [`# ${basename(rootfs) || rootfs}`, `    ${rootfs}`];

  if (report === null && upstream === null)
    blocks.push("No link2symlink store here. Nothing in this rootfs emulates a hard link.");
  else if (report === null) blocks.push(...describeUpstream(rootfs, upstream));
  else {
    if (converted !== null) blocks.push(...describeConversion(action, converted));
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

/** What a pin or unpin actually did. Every target is judged on its own, so a
 *  second run is harmless and finishes an interrupted first one. */
function describeConversion(action, converted) {
  const rows = [["refs", converted.refs], ["rewritten", converted.changed]];
  if (converted.already > 0)
    rows.push([action === "pin" ? "already pinned" : "already portable", converted.already]);
  if (converted.skipped > 0) rows.push(["skipped", converted.skipped]);
  const blocks = [`## ${action === "pin" ? "Pinned" : "Unpinned"}`, bullets(rows)];
  // The two readabilities are exclusive, and that is the whole trade: a
  // pinned store is for tools outside the rootfs, and costs the guest its
  // own hard links until it is unpinned again.
  blocks.push(action === "pin"
    ? "> Unpin before entering this rootfs again. The tracer identifies an emulated hard link by its guest-absolute target, so while it is pinned it recognises none of them."
    : "> Emulated hard links work inside the guest again, and no longer from outside it.");
  if (converted.skipped > 0)
    blocks.push("A skipped ref could not be read or rewritten: a stale alias, or a store this process cannot write to.");
  return blocks;
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
    blocks.push("Targets carry a host prefix, which is what lets tools outside the rootfs follow them. Moving the rootfs breaks every one.",
      "### Unpin before entering",
      "The tracer identifies an emulated hard link by its guest-absolute target, so it recognises none of these. They do not resolve inside the guest, and binding the rootfs onto itself only makes that worse: the files become readable while still not being hard links, reporting a link count of 1 and listing as symlinks. Anything that trusts either -- git, apk -- is then working from a false picture.",
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

  if (report.stale > 0) {
    blocks.push("## Stale refs",
      "A stale ref is one whose guest name no longer points back at it: the file was replaced or removed. It costs space, not correctness.");
    // The guest pathnames themselves, which is what a verbose run is for.
    if (report.stalePaths !== null)
      blocks.push("### Which ones",
        report.stalePaths.map((path) => `    ${path}`).join("\n"));
    else blocks.push("Set PROOT_BUN_VERBOSE=1 to list them.");
  }
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
  if (parsed.storeAction !== undefined)
    return runStoreCommand(parsed.storeRootfs, parsed.storeAction);
  if (parsed.document !== undefined) {
    const markdown = readFileSync(resolve(import.meta.dirname, parsed.document), "utf8");
    console.log(renderMarkdown(markdown));
    return 0;
  }
  const { rootfs, bindings, command, killOnExit, ignorePin, androidContainer } = parsed;
  // A pinned store is not merely unreadable from in here: the tracer
  // identifies an emulated hard link by its guest-absolute target, so while
  // it is pinned it recognises none of them. Reads fail, and writes are
  // worse -- a new link is written in the portable form beside the pinned
  // ones, and unlinking a pinned alias never decrements its object. Refuse,
  // rather than let a guest damage the store one operation at a time.
  if (!ignorePin && storeIsPinned(rootfs) === true) throw new Error(
    `this rootfs's link store is pinned, so its emulated hard links do not work\n` +
    `  bunproot --l2s-unpin ${rootfs}\n` +
    "puts it back; --l2s-status reports it in full, and --l2s-ignore-pin\n" +
    "enters anyway.");
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
  const androidBindings=androidContainer ? [
    "/system:/system", "/apex:/apex", "/linkerconfig/ld.config.txt:/linkerconfig/ld.config.txt",
    `${process.argv0}:/bin/bun`,
  ] : [];
  const mounts = createBindings(rootfs, [...compatibilityBindings,...androidBindings,...bindings.flatMap((entry) =>
    typeof entry === "string" ? [entry] : resolverBindings(rootfs, entry.dns))]);
  const environment=guestEnvironment();
  if (androidContainer) {
    const pathIndex=environment.findIndex((entry)=>entry.startsWith("PATH="));
    const path=pathIndex<0?"":environment[pathIndex].slice(5);
    const value=`PATH=/system/bin:${path}`;
    if (pathIndex<0) environment.push(value); else environment[pathIndex]=value;
  }
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
    environment.find((entry)=>entry.startsWith("PATH="))?.slice(5));
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
    name: basename(command[0]), interpreter, loader, argv: guestArgv, env:environment }, { killOnExit });
}
