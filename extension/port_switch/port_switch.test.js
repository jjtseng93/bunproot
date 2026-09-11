import { expect, test } from "bun:test";
import { ipBytes, isPublishedPort, mappedPort, offsetPortMode, parsePortMapping, portAddition } from "./port_switch.c.js";
import { parseArguments } from "../../cli/proot.c.js";

test("Docker-style mappings use host:container order", () => {
  expect(parsePortMapping("8080:80")).toEqual({ host:8080, guest:80, protocol:"tcp" });
  expect(parsePortMapping("5353:53/udp")).toEqual({ host:5353, guest:53, protocol:"udp" });
  expect(parsePortMapping("127.0.0.1:8080:80")).toEqual({ host:8080, guest:80, protocol:"tcp", hostAddress:"127.0.0.1" });
  expect(parsePortMapping("[::1]:8443:443/tcp")).toEqual({ host:8443, guest:443, protocol:"tcp", hostAddress:"::1" });
  for (const invalid of ["80", "host:8080:80", "0:80", "8080:65536", "8080:80/sctp", "-x"])
    expect(parsePortMapping(invalid)).toBeNull();
  expect(isPublishedPort("80")).toBe(true);
  expect(isPublishedPort("0")).toBe(false);
  expect([...ipBytes("127.0.0.1")]).toEqual([127,0,0,1]);
  expect([...ipBytes("::1")]).toEqual([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]);
});

test("mapping and low-port fallback remain separate modes", () => {
  const mappings={ kind:"mapping", mappings:[
    { host:8080, guest:80, protocol:"tcp" }, { host:5353, guest:53, protocol:"udp" },
  ] };
  expect(mappedPort(mappings,80,"tcp")).toBe(8080);
  expect(mappedPort(mappings,80,"udp")).toBe(80);
  expect(mappedPort(mappings,53,"udp")).toBe(5353);
  expect(mappedPort(offsetPortMode("3000"),80)).toBe(3080);
  expect(mappedPort(offsetPortMode("3000"),1024)).toBe(1024);
  expect(portAddition("bad")).toBe(2000);
});

test("-p consumes only a valid mapping and otherwise falls back without eating flags or commands", () => {
  expect(parseArguments(["-S","/rootfs","-p","8080:80","-p","5353:53/udp","/bin/server"]))
    .toMatchObject({
      portMode:{ kind:"mapping", mappings:[
        { host:8080, guest:80, protocol:"tcp" }, { host:5353, guest:53, protocol:"udp" },
      ] }, command:["/bin/server"],
    });
  expect(parseArguments(["-p","-S","/rootfs","/bin/server"]))
    .toMatchObject({ portMode:{ kind:"offset" }, command:["/bin/server"] });
  expect(parseArguments(["-S","/rootfs","-p","8080","/bin/server"]))
    .toMatchObject({ command:["/bin/server"] });
  expect(parseArguments(["-S","/rootfs","-p","8080","/bin/server"])).not.toHaveProperty("portMode");
  expect(parseArguments(["-S","/rootfs","-p","80","/bin/server"]))
    .toMatchObject({ command:["/bin/server"], portWarnings:[expect.stringContaining("cannot allocate")] });
  expect(parseArguments(["-S","/rootfs","-p","not-a-map","argument"]))
    .toMatchObject({ portMode:{ kind:"offset" }, command:["not-a-map","argument"] });
});
