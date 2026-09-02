import { ptr } from "bun:ffi";
export const NT_PRSTATUS = 1;
export const REGISTER_BYTES = 34 * 8;
export function makeRegisterSet() {
  const bytes = new Uint8Array(REGISTER_BYTES);
  return { bytes, view: new DataView(bytes.buffer), pointer: ptr(bytes) };
}
export function makeIovec(registers) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(registers.pointer), true);
  view.setBigUint64(8, BigInt(REGISTER_BYTES), true);
  return { bytes, pointer: ptr(bytes) };
}
export const getX = (registers, index) => registers.view.getBigUint64(index * 8, true);
export const setX = (registers, index, value) => registers.view.setBigUint64(index * 8, BigInt(value), true);
export const getSp = (registers) => getX(registers, 31);
export const getPc = (registers) => registers.view.getBigUint64(32 * 8, true);
export const setPc = (registers, value) => registers.view.setBigUint64(32 * 8, BigInt(value), true);
export const getSyscallNumber = (registers) => Number(getX(registers, 8));
