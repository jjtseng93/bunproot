#!/usr/bin/env bun
/** Regenerate syscall/names.js from the kernel's own header.
 *
 * Usage: bun tools/generate-syscall-names.mjs [path-to-asm-generic/unistd.h]
 *
 * Defaults to the header Termux ships. Any sysroot's copy works: arm64 takes
 * its numbering straight from asm-generic, so the file is the authority here
 * rather than a transcription of one. See NOTICE.md for its licensing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const header = process.argv[2] ??
  "/data/data/com.termux/files/usr/include/asm-generic/unistd.h";
const text = readFileSync(header, "utf8");

// Two passes: the plain numbers first, then the __NR3264_* indirections that
// 32/64-bit shared names go through.
const direct = new Map(), alias = new Map();
for (const line of text.split("\n")) {
  const numbered = /^#define __NR(3264)?_(\w+)\s+(\d+)\s*$/.exec(line);
  if (numbered !== null) {
    direct.set(`${numbered[1] ? "__NR3264_" : ""}${numbered[2]}`, Number(numbered[3]));
    continue;
  }
  const indirect = /^#define __NR_(\w+)\s+(__NR3264_\w+)\s*$/.exec(line);
  if (indirect !== null) alias.set(indirect[1], indirect[2]);
}

const names = new Map();
for (const [key, number] of direct) if (!key.startsWith("__NR3264_")) names.set(number, key);
for (const [name, target] of alias) {
  if (direct.has(target) && !names.has(direct.get(target))) names.set(direct.get(target), name);
}

const existing = readFileSync(join(dirname(import.meta.dirname), "syscall/names.js"), "utf8");
const head = existing.slice(0, existing.indexOf("export const SYSCALL_NAMES"));
const rows = [...names].sort((a, b) => a[0] - b[0])
  .map(([number, name]) => `  [${number}, "${name}"],`).join("\n");
writeFileSync(join(dirname(import.meta.dirname), "syscall/names.js"),
  `${head}export const SYSCALL_NAMES = new Map([\n${rows}\n]);\n\n` +
  "export const syscallName = (number) =>\n  SYSCALL_NAMES.get(number) ?? `syscall_${number}`;\n");
console.error(`syscall/names.js: ${names.size} entries from ${header}`);
