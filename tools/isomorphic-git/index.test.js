import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { confirmInstall, parseGlobal } from "./index.js";
import { destination, list, parse, parseClone } from "./options.js";

test("--yes skips only the installation confirmation", () => {
  expect(parseGlobal(["--yes","clone","URL"])).toMatchObject({ yes:true,command:"clone",argv:["URL"] });
  let prompted=false;
  confirmInstall(true,()=>{ prompted=true; return "n"; });
  expect(prompted).toBe(false);
  expect(()=>confirmInstall(false,()=>"n")).toThrow("installation cancelled");
});

test("clone arguments use Git's repository then directory order", () => {
  expect(destination("https://example.com/owner/project.git")).toBe("project");
  expect(destination("git@example.com:owner/project.git")).toBe("project");
  expect(parseClone(["https://example.com/a.git"])).toMatchObject({
    url:"https://example.com/a.git", dir:resolve("a"), remote:"origin",
  });
  expect(parseClone(["URL","checkout"])).toMatchObject({ url:"URL",dir:resolve("checkout") });
});

test("clone accepts common Git clone options", () => {
  expect(parseClone(["--depth=1","-b","main","--single-branch","--no-tags","URL","dst"]))
    .toMatchObject({ depth:1,ref:"main",singleBranch:true,noTags:true,url:"URL",dir:resolve("dst") });
  expect(parseClone(["-q","-n","-o","upstream","--","-repo","dst"]))
    .toMatchObject({ quiet:true,noCheckout:true,remote:"upstream",url:"-repo",dir:resolve("dst") });
  expect(()=>parseClone(["--depth","0","URL"])).toThrow("positive integer");
  expect(()=>parseClone(["--mirror","URL"])).toThrow("unknown option");
});

test("the option parser follows Git's conventions", () => {
  const spec={ a:"all", m:["message",list], n:["max"], "<n>":["max"], quiet:"quiet" };
  expect(parse(["-am","one","-m","two","x"],spec))
    .toEqual({ options:{ all:true,message:["one","two"] }, positional:["x"], paths:null });
  expect(parse(["-n5","--quiet","-3","--","-y"],spec))
    .toEqual({ options:{ max:"3",quiet:true }, positional:["-y"], paths:["-y"] });
  expect(()=>parse(["--quiet=1"],spec)).toThrow("takes no value");
  const optional={ decorate:["decorate",null,true] };
  expect(parse(["--decorate"],optional).options).toEqual({ decorate:true });
  expect(parse(["--decorate=short"],optional).options).toEqual({ decorate:"short" });
  expect(()=>parse(["-m"],spec)).toThrow("requires a value");
});
