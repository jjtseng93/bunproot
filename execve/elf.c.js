import { openSync, closeSync, readSync } from "node:fs";

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const ELFCLASS32 = 1, ELFCLASS64 = 2, ELFDATA2LSB = 1, ELFDATA2MSB = 2;
const PT_INTERP = 3;

function readAt(fd, length, position) {
  const bytes = new Uint8Array(length);
  const count = readSync(fd, bytes, 0, length, position);
  if (count !== length) throw new Error("truncated ELF file");
  return bytes;
}

/** Return the guest PT_INTERP pathname, or null for a static ELF. */
export function readElfInterpreter(filename) {
  const fd = openSync(filename, "r");
  try {
    const header = readAt(fd, 64, 0);
    if (!ELF_MAGIC.every((byte, index) => header[index] === byte)) throw new Error(`${filename}: not an ELF file`);
    const elfClass = header[4], encoding = header[5];
    if (elfClass !== ELFCLASS32 && elfClass !== ELFCLASS64) throw new Error(`${filename}: unsupported ELF class`);
    if (encoding !== ELFDATA2LSB && encoding !== ELFDATA2MSB) throw new Error(`${filename}: unsupported ELF byte order`);
    const littleEndian = encoding === ELFDATA2LSB;
    const view = new DataView(header.buffer);
    const is64 = elfClass === ELFCLASS64;
    const phoff = Number(is64 ? view.getBigUint64(32, littleEndian) : view.getUint32(28, littleEndian));
    const phentsize = view.getUint16(is64 ? 54 : 42, littleEndian);
    const phnum = view.getUint16(is64 ? 56 : 44, littleEndian);
    const minimumSize = is64 ? 56 : 32;
    if (phentsize < minimumSize) throw new Error(`${filename}: invalid program header size`);
    for (let index = 0; index < phnum; index++) {
      const program = readAt(fd, phentsize, phoff + index * phentsize);
      const ph = new DataView(program.buffer);
      if (ph.getUint32(0, littleEndian) !== PT_INTERP) continue;
      const offset = Number(is64 ? ph.getBigUint64(8, littleEndian) : ph.getUint32(4, littleEndian));
      const size = Number(is64 ? ph.getBigUint64(32, littleEndian) : ph.getUint32(16, littleEndian));
      if (size < 2 || size > 4096) throw new Error(`${filename}: invalid PT_INTERP size`);
      const value = readAt(fd, size, offset);
      if (value[value.length - 1] !== 0) throw new Error(`${filename}: unterminated PT_INTERP`);
      return new TextDecoder().decode(value.subarray(0, -1));
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

const alignDown = (value, alignment=0x1000n) => value & ~(alignment - 1n);
const alignUp = (value, alignment=0x1000n) => (value + alignment - 1n) & ~(alignment - 1n);

/** Extract the 64-bit load plan consumed by the ptrace remote loader. */
export function readElfLoadInfo(filename) {
  const fd = openSync(filename, "r");
  try {
    const header = readAt(fd, 64, 0);
    if (!ELF_MAGIC.every((byte, index) => header[index] === byte) || header[4] !== ELFCLASS64)
      throw new Error(`${filename}: remote loader currently requires ELF64`);
    const little = header[5] === ELFDATA2LSB;
    const view = new DataView(header.buffer);
    const type = view.getUint16(16, little);
    const entry = view.getBigUint64(24, little);
    const phoff = view.getBigUint64(32, little);
    const phentsize = view.getUint16(54, little), phnum = view.getUint16(56, little);
    const mappings = [];
    let interpreter = null, executableStack = false;
    for (let index = 0; index < phnum; index++) {
      const bytes = readAt(fd, phentsize, Number(phoff) + index * phentsize);
      const ph = new DataView(bytes.buffer), kind = ph.getUint32(0, little);
      const flags = ph.getUint32(4, little);
      const offset = ph.getBigUint64(8, little), vaddr = ph.getBigUint64(16, little);
      const filesz = ph.getBigUint64(32, little), memsz = ph.getBigUint64(40, little);
      if (kind === PT_INTERP) {
        const value = readAt(fd, Number(filesz), Number(offset));
        interpreter = new TextDecoder().decode(value.subarray(0, -1));
      } else if (kind === 1) {
        const start = alignDown(vaddr), fileEnd = alignUp(vaddr + filesz);
        mappings.push({ anonymous:false, address:start, length:fileEnd-start,
          protection:(flags&4?1:0)|(flags&2?2:0)|(flags&1?4:0), offset:alignDown(offset),
          clearLength:fileEnd-vaddr-filesz });
        const memoryEnd = alignUp(vaddr + memsz);
        if (memoryEnd > fileEnd) mappings.push({ anonymous:true, address:fileEnd,
          length:memoryEnd-fileEnd, protection:(flags&4?1:0)|(flags&2?2:0)|(flags&1?4:0), offset:0n, clearLength:0n });
      } else if (kind === 0x6474e551) executableStack ||= (flags & 1) !== 0;
    }
    if (type !== 2 && type !== 3) throw new Error(`${filename}: unsupported ELF type ${type}`);
    return { filename, type, entry, phoff, phentsize, phnum, mappings, interpreter, executableStack };
  } finally { closeSync(fd); }
}

export function relocateElf(info, base) {
  if (info.type !== 3 || info.mappings[0]?.address !== 0n) return info;
  return { ...info, entry:info.entry+base,
    mappings:info.mappings.map((mapping) => ({ ...mapping, address:mapping.address+base })) };
}
