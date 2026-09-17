import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { confirmInstall, parseGlobal, readme } from "./index.js";
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

test("--readme prints the guide next to the wrapper", async () => {
  const { commands }=await import("./commands.js");
  expect(parseGlobal(["--readme","ignored"])).toMatchObject({ command:"readme", argv:[] });
  const text=readme({ raw:true });
  expect(text.startsWith("# bunproot --git\n")).toBe(true);
  // Rendered for the terminal: ANSI styling, OSC 8 hyperlinks, no markdown.
  const rendered=readme({ columns:100 });
  expect(rendered).toContain("\x1b]8;;https://isomorphic-git.org/\x1b\\");
  expect(rendered).not.toContain("# bunproot --git");
  // Every command the wrapper dispatches has its own entry in the guide.
  const reference=text.slice(text.indexOf("## Commands"),text.indexOf("## A walk through"));
  for (const name of Object.keys(commands))
    expect(reference).toMatch(new RegExp(`^- \`${name}\\b`,"m"));
});

test("credentials come from the environment, credential helpers and the store file", async () => {
  const { context, credentials }=await import("./commands.js");
  const home=mkdtempSync(join(tmpdir(),"isogit-cred-"));
  const saved={ ...process.env };
  const reset=()=>{ for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env,saved); };
  try {
    process.env.HOME=home; process.env.XDG_CONFIG_HOME=join(home,".config");
    for (const key of ["GIT_USERNAME","GIT_PASSWORD","GIT_TOKEN","GITHUB_TOKEN"]) delete process.env[key];
    const ctx=(overrides={})=>context({ overrides, cwd:home });
    const url="https://github.com/owner/project.git";
    // Nothing configured: no credential, and no prompt.
    expect(await credentials(ctx(),url)).toBeUndefined();
    // The store helper's file, matched by host.
    writeFileSync(join(home,".git-credentials"),"https://alice:s%40cret@github.com\nhttps://bob:x@example.com\n");
    expect(await credentials(ctx(),url)).toEqual({ username:"alice", password:"s@cret" });
    expect(await credentials(ctx(),"https://example.com/r")).toEqual({ username:"bob", password:"x" });
    expect(await credentials(ctx(),"https://other.example/r")).toBeUndefined();
    // A helper program gets Git's request on stdin and answers in Git's form.
    const helper=join(home,"helper.sh");
    writeFileSync(helper,'#!/bin/sh\ncat > "$(dirname "$0")/asked.txt"\necho username=carol\necho password=from-helper\n');
    chmodSync(helper,0o755);
    expect(await credentials(ctx({ "credential.helper":`!${helper}` }),url)).toEqual({ username:"carol", password:"from-helper" });
    expect(await Bun.file(join(home,"asked.txt")).text()).toBe("protocol=https\nhost=github.com\npath=owner/project.git\n\n");
    expect(await credentials(ctx({ "credential.helper":helper }),url)).toEqual({ username:"carol", password:"from-helper" });
    // store --file=<path>, and a helper that has nothing falls through to the file.
    writeFileSync(join(home,"other"),"https://dave:pw@github.com\n");
    expect(await credentials(ctx({ "credential.helper":`store --file=${join(home,"other")}` }),url)).toEqual({ username:"dave", password:"pw" });
    expect(await credentials(ctx({ "credential.helper":"cache" }),url)).toEqual({ username:"alice", password:"s@cret" });
    // The environment wins over everything.
    process.env.GIT_TOKEN="tok";
    expect(await credentials(ctx({ "credential.helper":helper }),url)).toEqual({ username:"x-access-token", password:"tok" });
    process.env.GIT_USERNAME="erin"; process.env.GIT_PASSWORD="pass";
    expect(await credentials(ctx(),url)).toEqual({ username:"erin", password:"pass" });
  } finally { reset(); rmSync(home,{ recursive:true, force:true }); }
});
