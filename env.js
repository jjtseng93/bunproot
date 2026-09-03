// Every environment decision the port makes lives here: what the tracer reads
// from its own environment, what the Android bootstrap process is started with,
// and what a guest is allowed to inherit.

/** Show ELF loading, process events, signals, guest exec and path rewriting. */
export const verbose = process.env.PROOT_BUN_VERBOSE === "1";

/** Count and time the tracer's own work, and report it when the guest exits. */
export const profile = process.env.PROOT_BUN_PROFILE === "1";

/** Stop on every syscall instead of filtering with seccomp. Upstream's own
 *  knob, down to its semantics: set at all -- to any value -- disables the
 *  filter (src/tracee/event.c:130). The filter is the difference between one
 *  stop per syscall the guest makes and one stop per syscall this port
 *  translates; turn it off to compare behaviour, or on a kernel whose filter
 *  behaves unexpectedly. */
export const noSeccomp = process.env.PROOT_NO_SECCOMP !== undefined;

// What the guest is told about itself, whatever the caller happened to export.
// PATH is the guest's own, not the caller's: a host PATH names host binaries.
const GUEST_OVERRIDES = {
  HOME: "/root", USER: "root", LOGNAME: "root", SHELL: "/bin/sh", PWD: "/",
  TMPDIR: "/tmp",
  PATH: "/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
};

// A variable naming a host path describes something the guest cannot reach.
// npm and npx export a whole npm_config_* block describing the *host* npm --
// prefix, cache, execpath, node -- so a guest `npm i -g` silently installs into
// ROOTFS/<host prefix>/bin, a directory on no guest PATH, and `npm root -g`
// answers with the host's. Android's own variables and this tracer's knobs are
// as meaningless inside the rootfs. Everything else the caller exported is
// passed through: PRoot is not a container.
const HOST_ONLY = new Set([
  "LD_PRELOAD", "LD_LIBRARY_PATH", "PREFIX", "TMPPREFIX", "BUN_INSTALL",
  "NPM_CONFIG_PREFIX", "OLDPWD", "NODE", "NODE_PATH", "INIT_CWD", "TMP", "TEMP",
  "_", "TMUX", "TMUX_PANE", "TMUX_TMPDIR", "JAVA_HOME", "BOOTCLASSPATH",
  "DEX2OATBOOTCLASSPATH", "SYSTEMSERVERCLASSPATH", "ASEC_MOUNTPOINT",
  "EXTERNAL_STORAGE", "TERMUX_VERSION",
]);
const HOST_ONLY_PREFIXES = ["npm_", "ANDROID_", "PROOT_BUN_"];

function isHostOnly(name) {
  return HOST_ONLY.has(name) || HOST_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The initial guest environment, as the `KEY=value` strings execve(2) takes. */
export function guestEnvironment(base = process.env) {
  const environment = { ...base, ...GUEST_OVERRIDES };
  for (const name of Object.keys(environment)) if (isHostOnly(name)) delete environment[name];
  return Object.entries(environment).map(([key, value]) => `${key}=${value}`);
}

/** The Android bootstrap process runs before any guest exists; it only needs
 *  the host environment with the launcher's LD_PRELOAD cleared. */
export function bootstrapEnvironment(base = process.env) {
  return { ...base, LD_PRELOAD: "" };
}
