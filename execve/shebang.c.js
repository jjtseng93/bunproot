import { readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { canonicalizeGuestPath } from "../path/canon.c.js";

export function readShebang(filename) {
  const bytes=readFileSync(filename).subarray(0,4096);
  if (bytes[0]!==0x23||bytes[1]!==0x21) return null;
  const line=new TextDecoder().decode(bytes).split(/\r?\n/,1)[0].slice(2).trim();
  if (!line) throw Object.assign(new Error(`${filename}: empty shebang`),{code:"ENOEXEC"});
  const match=/^(\S+)(?:\s+(.*))?$/.exec(line);
  return { interpreter:match[1], argument:match[2]||null };
}

/**
 * The guest's own view of "does this exist" and "where is this on PATH".
 * Bun.which() cannot answer either: it searches the tracer's PATH and reports
 * host pathnames, while every question here is about the guest namespace and
 * has to go through the mount table.
 */
export function makeGuestPaths(mounts,searchPath,cwd="/") {
  const host=(guestPath)=>mounts.toHost(canonicalizeGuestPath(mounts,guestPath));
  return {
    exists(guestPath) {
      try { statSync(host(guestPath)); return true; } catch { return false; }
    },
    which(name) {
      for (const entry of (searchPath??"").split(":")) {
        // An empty entry means the working directory to a shell; treat it as
        // one rather than as "/", which would search the guest root.
        const directory=entry===""?cwd:entry.startsWith("/")?entry:posix.resolve(cwd,entry);
        const candidate=posix.resolve(directory,name);
        try {
          const stat=statSync(host(candidate));
          if (stat.isFile() && (stat.mode&0o111)!==0) return canonicalizeGuestPath(mounts,candidate);
        } catch {}
      }
      return null;
    },
  };
}

// `#!/usr/bin/env NAME` asks for a PATH search, which is the one thing a
// shebang line cannot express on its own. The kernel satisfies it by execing
// /usr/bin/env, so a rootfs that ships no coreutils cannot run such a script
// at all -- even when the interpreter it names is right there on PATH. The
// search is the whole of env's job here and the tracer can do it directly.
//
// Only the exact `env NAME` shape qualifies. A name containing a slash is
// already a pathname and needs no search; an option such as `-S` means env has
// work of its own to do; and a real env on the guest keeps its job, so a rootfs
// that ships one behaves exactly as before.
const ENV_INTERPRETERS = new Set(["/usr/bin/env", "/bin/env", "/usr/local/bin/env"]);

function resolveEnvInterpreter(shebang,guest) {
  if (guest===null || !ENV_INTERPRETERS.has(shebang.interpreter)) return null;
  if (guest.exists(shebang.interpreter)) return null;
  const name=shebang.argument;
  if (name===null || name.startsWith("-") || name.includes("/") || /\s/.test(name)) return null;
  return guest.which(name);
}

export function expandShebang(hostPath,guestPath,argv,guest=null) {
  const shebang=readShebang(hostPath);
  if (shebang===null) return null;
  const resolved=resolveEnvInterpreter(shebang,guest);
  // env(1) execs the program under the name it was given, not under the
  // pathname it resolved to, so argv[0] stays `NAME`.
  if (resolved!==null)
    return { guestPath:resolved, argv:[shebang.argument,guestPath,...argv.slice(1)] };
  return {
    guestPath:shebang.interpreter,
    argv:[shebang.interpreter,...(shebang.argument?[shebang.argument]:[]),guestPath,...argv.slice(1)],
  };
}
