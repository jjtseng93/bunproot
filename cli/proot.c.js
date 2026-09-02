import { probeNativePath } from "../ffi.js";
import { translateArgv } from "../path/path.c.js";

export function prepareCommand(argv) {
  if (argv.length === 0) throw new Error("usage: bun run index.js COMMAND [ARG ...]");
  const [command, ...args] = argv;
  return [command, ...translateArgv(args)];
}

export function run(argv) {
  const command = prepareCommand(argv);
  // Probe the translated path through Android's bionic before execution.
  const probe = probeNativePath(command[1] ?? "/");
  if (!probe.available) {
    throw new Error(`Android bionic FFI unavailable: ${probe.error.message}`);
  } else if (!probe.accessible) {
    throw new Error(`translated path is not accessible: ${command[1] ?? "/"}`);
  }
  const child = Bun.spawnSync({
    cmd: command,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (child.error) throw child.error;
  return child.exitCode;
}
