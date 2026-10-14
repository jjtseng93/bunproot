import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readElfLoadInfo } from "./elf.c.js";

function mappings(vaddr, filesz, memsz) {
  const dir = mkdtempSync(join(tmpdir(), "elf-load-"));
  try {
    const bytes = Buffer.alloc(120);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    bytes.writeUInt16LE(2, 16);
    bytes.writeBigUInt64LE(64n, 32);
    bytes.writeUInt16LE(56, 54);
    bytes.writeUInt16LE(1, 56);
    bytes.writeUInt32LE(1, 64);
    bytes.writeUInt32LE(6, 68);
    bytes.writeBigUInt64LE(0x1000n + (vaddr & 0xfffn), 72);
    bytes.writeBigUInt64LE(vaddr, 80);
    bytes.writeBigUInt64LE(filesz, 96);
    bytes.writeBigUInt64LE(memsz, 104);
    const file = join(dir, "fixture");
    writeFileSync(file, bytes);
    return readElfLoadInfo(file).mappings;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("aligned pure BSS needs only anonymous memory", () => {
  expect(mappings(0x441000n, 0n, 8n)).toEqual([{
    anonymous: true, address: 0x441000n, length: 0x1000n,
    protection: 3, offset: 0n, clearLength: 0n,
  }]);
});

test("empty PT_LOAD needs no mapping, even when unaligned", () => {
  expect(mappings(0x441000n, 0n, 0n)).toEqual([]);
  expect(mappings(0x441008n, 0n, 0n)).toEqual([]);
});

test("unaligned BSS clears the partial file page and adds remaining pages", () => {
  const result = mappings(0x441008n, 0n, 0x2000n);
  expect(result).toEqual([
    { anonymous: false, address: 0x441000n, length: 0x1000n,
      protection: 3, offset: 0x1000n, clearLength: 0xff8n },
    { anonymous: true, address: 0x442000n, length: 0x2000n,
      protection: 3, offset: 0n, clearLength: 0n },
  ]);
});

test("initialized data preserves its bytes before the BSS tail", () => {
  const result = mappings(0x441000n, 16n, 0x1008n);
  expect(result[0].clearLength).toBe(0xff0n);
  expect(result[1].address).toBe(0x442000n);
  expect(result[1].length).toBe(0x1000n);
  expect(mappings(0x441000n, 16n, 16n)[0].clearLength).toBe(0n);
});
