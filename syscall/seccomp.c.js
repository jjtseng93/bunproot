/** ESM port of src/syscall/seccomp.c.
 *
 * A tracer that restarts every tracee with PTRACE_SYSCALL stops twice for each
 * syscall the guest makes, and a guest makes overwhelmingly more syscalls than
 * this port translates: `bunx` against a warm cache took 45946 stops to reach
 * 509 that mattered. A seccomp filter answering SECCOMP_RET_TRACE for exactly
 * the translated syscalls and SECCOMP_RET_ALLOW for the rest moves that ratio
 * to one stop per syscall that needs one.
 */

export const AUDIT_ARCH_AARCH64 = 0xc00000b7;

const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_TRACE = 0x7ff00000;

// struct seccomp_data { int nr; __u32 arch; __u64 instruction_pointer; ... }
const OFFSET_NR = 0, OFFSET_ARCH = 4;

const BPF_LD_W_ABS = 0x20; // BPF_LD | BPF_W | BPF_ABS
const BPF_JEQ_K = 0x15;    // BPF_JMP | BPF_JEQ | BPF_K
const BPF_RET_K = 0x06;    // BPF_RET | BPF_K

export const SOCK_FILTER_BYTES = 8; // { u16 code; u8 jt; u8 jf; u32 k; }

/**
 * A classic-BPF program that traces `numbers` and allows everything else.
 * Foreign architectures are allowed rather than killed: this tracer only ever
 * translates the arm64 ABI, and a filter is inherited by every descendant.
 */
export function buildFilter(numbers) {
  const traced = [...new Set(numbers)].sort((a, b) => a - b);
  const instructions = [];
  const emit = (code, jt, jf, k) => instructions.push([code, jt, jf, k]);

  // 0: A = arch
  emit(BPF_LD_W_ABS, 0, 0, OFFSET_ARCH);
  // 1: if (A != AUDIT_ARCH_AARCH64) goto allow
  emit(BPF_JEQ_K, 0, traced.length + 1, AUDIT_ARCH_AARCH64);
  // 2: A = nr
  emit(BPF_LD_W_ABS, 0, 0, OFFSET_NR);
  // 3 .. 3+n-1: if (A == nr) goto trace
  traced.forEach((number, index) => emit(BPF_JEQ_K, traced.length - index, 0, number));
  // 3+n: allow, 3+n+1: trace
  emit(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW);
  emit(BPF_RET_K, 0, 0, SECCOMP_RET_TRACE);

  const program = new Uint8Array(instructions.length * SOCK_FILTER_BYTES);
  const view = new DataView(program.buffer);
  instructions.forEach(([code, jt, jf, k], index) => {
    const offset = index * SOCK_FILTER_BYTES;
    view.setUint16(offset, code, true);
    view.setUint8(offset + 2, jt);
    view.setUint8(offset + 3, jf);
    view.setUint32(offset + 4, k >>> 0, true);
  });
  return { program, length: instructions.length };
}

/** struct sock_fprog { unsigned short len; struct sock_filter *filter; } */
export function buildProgramHeader(length, filterAddress) {
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  view.setUint16(0, length, true);
  view.setBigUint64(8, filterAddress, true);
  return header;
}
