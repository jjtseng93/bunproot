/** Rendering a syscall stop the way strace would.
 *
 * Not an upstream PRoot feature. The tracer already stands at the entry and
 * exit of every syscall when the seccomp filter is off, with the arguments in
 * registers and the pathname translation in hand -- everything a trace needs
 * is already there, and was simply not being written down. What made this
 * worth adding is that `PROOT_BUN_VERBOSE=1` only reports what the port
 * *handles*: a call it passes through untouched leaves no trace at all, which
 * is precisely the blind spot when a guest dies on a syscall the port does not
 * translate.
 *
 * The guest pathname and the host pathname it became are both shown, because
 * the difference between them is the one thing a real strace cannot tell you
 * here.
 */

import { syscallName } from "./names.js";

const AT_FDCWD = -100;
const ANSI={reset:"\x1b[0m",dim:"\x1b[2m",name:"\x1b[36m",number:"\x1b[33m",string:"\x1b[32m",symbol:"\x1b[35m",error:"\x1b[31m"};
const paint=(enabled,kind,value)=>enabled?`${ANSI[kind]}${value}${ANSI.reset}`:value;

// Only the flags worth reading at a glance. An unknown bit is kept as a
// number rather than dropped, so a decoded value never lies by omission.
const OPEN_FLAGS = [
  [0o4000000, "O_CLOEXEC"], [0o2000000, "O_CLOEXEC"], [0o1000000, "O_NOFOLLOW"],
  [0o400000, "O_LARGEFILE"], [0o200000, "O_DIRECTORY"], [0o100000, "O_NOFOLLOW"],
  [0o40000, "O_DIRECT"], [0o20000, "O_SYNC"], [0o4000, "O_NONBLOCK"],
  [0o2000, "O_APPEND"], [0o1000, "O_TRUNC"], [0o200, "O_EXCL"], [0o100, "O_CREAT"],
];
const ACCESS_MODE = ["O_RDONLY", "O_WRONLY", "O_RDWR", "O_ACCMODE"];

function openFlags(value) {
  const bits = Number(BigInt.asUintN(32, value));
  const parts = [ACCESS_MODE[bits & 3]];
  let rest = bits & ~3;
  for (const [bit, name] of OPEN_FLAGS) {
    if ((rest & bit) === bit) { parts.push(name); rest &= ~bit; }
  }
  if (rest !== 0) parts.push(`0x${rest.toString(16)}`);
  return parts.join("|");
}

const dirfd = (value) => {
  const fd = Number(BigInt.asIntN(32, value));
  return fd === AT_FDCWD ? "AT_FDCWD" : String(fd);
};

/** How many arguments a call actually takes.
 *
 * Registers past that hold whatever the last call left there, and printing
 * them is worse than useless -- `set_tid_address` reading as if it took six
 * arguments is noise that hides the one that matters. Only the calls seen
 * often enough to be worth the line are listed; anything absent falls back to
 * showing every register that is not zero, which is at least honest.
 */
const ARITY = new Map([
  [124, 0], [157, 0], [172, 0], [173, 0], [174, 0], [175, 0], [176, 0], [177, 0], [178, 0],
  [23, 1], [49, 1], [50, 1], [57, 1], [92, 1], [93, 1], [94, 1], [96, 1], [97, 1],
  [166, 1], [214, 1],
  [45, 2], [46, 2], [80, 2], [101, 2], [113, 2], [129, 2], [169, 2], [201, 2], [215, 2],
  [29, 3], [61, 3], [62, 3], [63, 3], [64, 3], [65, 3], [66, 3], [131, 3], [198, 3],
  [200, 3], [203, 3], [221, 3], [226, 3], [227, 3], [233, 3],
  [35, 3], [48, 3],
  [56, 4], [78, 4], [79, 4], [134, 4], [135, 4], [260, 4], [261, 4], [439, 4],
  [38, 4],
  [37, 5], [40, 5], [220, 5], [276, 5], [281, 5], [291, 5],
  [72, 6], [98, 6], [206, 6], [207, 6], [222, 6], [270, 6],
]);

/** Which arguments are worth naming, per syscall. Everything else prints as a
 *  number, which is honest and costs nothing to maintain. */
const SHAPES = new Map([
  [56, ["dirfd", "path", "openflags", "mode"]],          // openat
  [48, ["dirfd", "path", "mode", "flags"]],              // faccessat
  [439, ["dirfd", "path", "mode", "flags"]],             // faccessat2
  [79, ["dirfd", "path", "buf", "flags"]],               // newfstatat
  [291, ["dirfd", "path", "flags", "mask", "buf"]],      // statx
  [78, ["dirfd", "path", "buf", "size"]],                // readlinkat
  [35, ["dirfd", "path", "flags"]],                      // unlinkat
  [37, ["olddirfd", "path", "newdirfd", "path", "flags"]], // linkat
  [38, ["olddirfd", "path", "newdirfd", "path"]],        // renameat
  [276, ["olddirfd", "path", "newdirfd", "path", "flags"]], // renameat2
  [221, ["path", "argv", "envp"]],                       // execve
  [281, ["dirfd", "path", "argv", "envp", "flags"]],     // execveat
  [49, ["path"]], [161, ["buf"]],                        // chdir, uname
]);

/**
 * Format one call. `read` turns a pointer into the guest string it holds, and
 * `translate` reports what that pathname was rewritten to, or null when the
 * port left it alone.
 */
export function formatCall(number, args, read, translate, color=false) {
  const shape = SHAPES.get(number) ?? [];
  const rendered = args.map((value, index) => {
    switch (shape[index]) {
      case "dirfd": case "olddirfd": case "newdirfd": {
        const rendered=dirfd(value);
        return paint(color,rendered==="AT_FDCWD"?"symbol":"number",rendered);
      }
      case "openflags": return paint(color,"symbol",openFlags(value));
      case "path": {
        const guest = read(value);
        if (guest === null) return paint(color,"number",`0x${value.toString(16)}`);
        const host = translate(guest);
        return host === null || host === guest
          ? paint(color,"string",JSON.stringify(guest))
          : `${paint(color,"string",JSON.stringify(guest))} ${paint(color,"dim","->")} ${paint(color,"string",JSON.stringify(host))}`;
      }
      case "mode": return paint(color,"number",`0o${BigInt.asUintN(32, value).toString(8)}`);
      // No shape for this position: show the value rather than nothing. A
      // number is honest, and for the calls nobody has described yet it is
      // still the difference between `mmap()` and knowing what was asked for.
      case undefined:
        return paint(color,"number",value === 0n ? "0" : `0x${value.toString(16)}`);
      default: return paint(color,"number",`0x${value.toString(16)}`);
    }
  });
  const arity = ARITY.get(number) ?? SHAPES.get(number)?.length;
  if (arity !== undefined) rendered.length = Math.min(rendered.length, arity);
  else {
    // Unknown arity: trailing zeros are far more likely to be leftovers than
    // real arguments, so they go.
    while (rendered.length > 0 && rendered[rendered.length - 1] === "0") rendered.pop();
  }
  return `${paint(color,"name",syscallName(number))}(${rendered.join(", ")})`;
}

/** The result, as strace prints it: a value, or -ERRNO. */
export function formatResult(value,color=false) {
  const signed = BigInt.asIntN(64, value);
  if (signed >= 0n) return paint(color,"number",signed > 0xffffn ? `0x${signed.toString(16)}` : String(signed));
  return paint(color,"error",`-${ERRNO.get(Number(-signed)) ?? -signed}`);
}

const ERRNO = new Map([
  [1, "EPERM"], [2, "ENOENT"], [3, "ESRCH"], [4, "EINTR"], [5, "EIO"], [9, "EBADF"],
  [11, "EAGAIN"], [12, "ENOMEM"], [13, "EACCES"], [14, "EFAULT"], [16, "EBUSY"],
  [17, "EEXIST"], [18, "EXDEV"], [20, "ENOTDIR"], [21, "EISDIR"], [22, "EINVAL"],
  [24, "EMFILE"], [28, "ENOSPC"], [32, "EPIPE"], [34, "ERANGE"], [38, "ENOSYS"],
  [39, "ENOTEMPTY"], [40, "ELOOP"], [61, "ENODATA"], [95, "EOPNOTSUPP"], [110, "ETIMEDOUT"],
]);
