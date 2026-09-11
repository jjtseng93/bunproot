const LOW_PORT_LIMIT = 1024;
const DEFAULT_PORT_ADD = 2000;

function port(value) {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 65535 ? parsed : null;
}

export function isPublishedPort(value) {
  return typeof value === "string" && port(value) !== null;
}

/** Parse Docker's common HOST_PORT:CONTAINER_PORT[/PROTOCOL] spelling.
 *
 * The host address and automatic/range publishing forms need a network
 * namespace or a userspace proxy, neither of which PRoot provides.  Keeping
 * the accepted grammar to the form this syscall translator can implement
 * avoids claiming Docker semantics that it cannot deliver.
 */
export function parsePortMapping(value) {
  if (typeof value !== "string") return null;
  const match = /^(?:(?:\[([^\]]+)\]|([^:]+)):)?(\d+):(\d+)(?:\/(tcp|udp))?$/.exec(value);
  if (match === null) return null;
  const hostAddress=match[1]??match[2]??null;
  if (hostAddress!==null && isIP(hostAddress)===0) return null;
  const host = port(match[3]), guest = port(match[4]);
  if (host === null || guest === null) return null;
  return { host, guest, protocol: match[5] ?? "tcp", ...(hostAddress!==null && { hostAddress }) };
}

export function portAddition(value = process.env.PROOT_PORT_ADD) {
  if (value === undefined || value === "") return DEFAULT_PORT_ADD;
  if (!/^\d+$/.test(value)) return DEFAULT_PORT_ADD;
  const parsed = Number(value);
  return parsed <= 65535 ? parsed : DEFAULT_PORT_ADD;
}

export function offsetPortMode(value = process.env.PROOT_PORT_ADD) {
  return { kind: "offset", addition: portAddition(value) };
}

export function mappedPort(mode, guestPort, protocol = "tcp") {
  return mappedEndpoint(mode,guestPort,protocol).port;
}

export function mappedEndpoint(mode, guestPort, protocol = "tcp") {
  if (mode === null || mode === undefined || guestPort === 0)
    return { port:guestPort, hostAddress:null };
  if (mode.kind === "offset") {
    if (guestPort >= LOW_PORT_LIMIT) return { port:guestPort, hostAddress:null };
    const mapped = guestPort + mode.addition;
    return { port:mapped <= 65535 ? mapped : guestPort, hostAddress:null };
  }
  const mapping = mode.mappings.find((entry) =>
    entry.guest === guestPort && entry.protocol === protocol);
  return mapping===undefined
    ? { port:guestPort, hostAddress:null }
    : { port:mapping.host, hostAddress:mapping.hostAddress??null };
}

/** Convert an IP literal to its network-order sockaddr bytes. */
export function ipBytes(address) {
  if (isIP(address)===4) return Uint8Array.from(address.split(".").map(Number));
  if (isIP(address)!==6) return null;
  let source=address.toLowerCase();
  // Expand an IPv4 tail to two IPv6 words before handling :: compression.
  const tail=/([0-9]+(?:\.[0-9]+){3})$/.exec(source);
  if (tail!==null) {
    const bytes=tail[1].split(".").map(Number);
    source=source.slice(0,-tail[1].length)+
      ((bytes[0]<<8)|bytes[1]).toString(16)+":"+((bytes[2]<<8)|bytes[3]).toString(16);
  }
  const halves=source.split("::");
  if (halves.length>2) return null;
  const left=halves[0]?halves[0].split(":"):[];
  const right=halves.length===2 && halves[1]?halves[1].split(":"):[];
  const fill=halves.length===2?8-left.length-right.length:0;
  const words=[...left,...Array(fill).fill("0"),...right];
  if (words.length!==8) return null;
  const output=new Uint8Array(16), view=new DataView(output.buffer);
  words.forEach((word,index)=>view.setUint16(index*2,parseInt(word,16),false));
  return output;
}
import { isIP } from "node:net";
