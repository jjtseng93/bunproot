import { readFileSync } from "node:fs";

export function readShebang(filename) {
  const bytes=readFileSync(filename).subarray(0,4096);
  if (bytes[0]!==0x23||bytes[1]!==0x21) return null;
  const line=new TextDecoder().decode(bytes).split(/\r?\n/,1)[0].slice(2).trim();
  if (!line) throw Object.assign(new Error(`${filename}: empty shebang`),{code:"ENOEXEC"});
  const match=/^(\S+)(?:\s+(.*))?$/.exec(line);
  return { interpreter:match[1], argument:match[2]||null };
}

export function expandShebang(hostPath,guestPath,argv) {
  const shebang=readShebang(hostPath);
  if (shebang===null) return null;
  return {
    guestPath:shebang.interpreter,
    argv:[shebang.interpreter,...(shebang.argument?[shebang.argument]:[]),guestPath,...argv.slice(1)],
  };
}
