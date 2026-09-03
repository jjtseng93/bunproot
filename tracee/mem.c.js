const WORD_SIZE = 8;
export function readCString(ptrace, pid, address, limit = 4096) {
  if (ptrace.read) {
    const bytes=ptrace.read(pid,address,limit);
    if (bytes) {
      const end=bytes.indexOf(0);
      if (end>=0) return new TextDecoder().decode(bytes.subarray(0,end));
    }
  }
  const output = [];
  for (let offset = 0; offset < limit; offset += WORD_SIZE) {
    const word = BigInt.asUintN(64, ptrace.peek(pid, address + BigInt(offset)));
    for (let byte = 0; byte < WORD_SIZE; byte++) {
      const value = Number((word >> BigInt(byte * 8)) & 0xffn);
      if (value === 0) return new TextDecoder().decode(Uint8Array.from(output));
      output.push(value);
    }
  }
  throw new Error("unterminated pathname in tracee memory");
}
export function writeCString(ptrace, pid, address, value) {
  const encoded = new TextEncoder().encode(`${value}\0`);
  writeBytes(ptrace, pid, address, encoded);
}
export function writeBytes(ptrace, pid, address, encoded) {
  for (let offset = 0; offset < encoded.length; offset += WORD_SIZE) {
    let word = 0n;
    for (let byte = 0; byte < WORD_SIZE; byte++) word |= BigInt(encoded[offset + byte] ?? 0) << BigInt(byte * 8);
    ptrace.poke(pid, address + BigInt(offset), word);
  }
}
