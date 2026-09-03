#!/usr/bin/env bun
// The npm entry point: what the `proot` shell script does, for an install where
// npm owns the bin link and the shebang is the only way to say "run this with
// Bun".
//
// It lives at the package root on purpose. `bun install -g` silently skips the
// bin link for a package whose `bin` target sits in a subdirectory, so a
// `./cli/proot.js` would install and then not be on PATH.
//
// `--no-orphans` is a runtime flag: Bun reads it at startup, so the process
// cannot turn it on for itself, and a shebang cannot portably carry a second
// argument. Bun exports BUN_FEATURE_FLAG_NO_ORPHANS whenever the flag is on,
// which is both the way to ask for it and the way to tell that it is already
// on, so the re-exec below happens at most once.
if (!process.env.BUN_FEATURE_FLAG_NO_ORPHANS) {
  // Drop LD_PRELOAD for the same reason the shell launcher does. The tracer
  // works with Termux's libtermux-exec loaded -- the bootstrap it spawns gets a
  // cleared environment either way -- but upstream reports exec failures on
  // Android when that library rewrites a pathname the guest asked for
  // (src/cli/cli.c:print_execve_help), and one line here is cheaper than the
  // error message it prevents.
  const environment = { ...process.env };
  delete environment.LD_PRELOAD;

  // The system bun first, the way the shell launcher does it, and only then
  // the one this process was started as.
  //
  // Never process.execPath. It is whatever /proc/self/exe resolves to, which is
  // not the command that started this process: on Termux it is the bun.exe
  // inside an npm-installed bun rather than the bun on PATH, and where Bun was
  // started through Android's linker -- `linker64 ./bun-android`, which is how
  // this port runs on a device with no Bun package -- it is the linker itself.
  // Re-execing that runs a linker with no arguments.
  const bun = Bun.which("bun") || process.argv0;

  const child = Bun.spawnSync({
    cmd: [bun, "--no-orphans", import.meta.path, ...process.argv.slice(2)],
    env: environment,
    stdio: ["inherit", "inherit", "inherit"],
  });
  // Report a signalled tracee the way a shell does.
  process.exit(child.signalCode ? 128 + (child.exitCode ?? 0) : (child.exitCode ?? 1));
}

await import("./index.js");
