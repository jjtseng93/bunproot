// `bunproot --git` against the system git, command for command, in a scratch
// directory.  Every step runs the same command line through both, compares
// what they print, and then asks the system git to describe both repositories
// so the on-disk result is compared independently of what either printed.
//
// Needs `git` on PATH and the locked isomorphic-git already installed under
// tools/isomorphic-git (the port prompts before installing it, and a test
// must not answer prompts).  Nothing here touches a real remote: push, fetch
// and pull go to bare repositories created below in the scratch directory
// and served by a local git-http-backend, and the one contact with github.com
// is a read-only clone, skipped when the host is unreachable.  HOME is
// redirected to the scratch directory, so no real credentials are in reach.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROOT=resolve(import.meta.dir,"../proot.js");
const BUN=Bun.which("bun")||process.argv0;
const SYSTEM_GIT=Bun.which("git");
const INSTALLED=existsSync(resolve(import.meta.dir,"../tools/isomorphic-git/node_modules/isomorphic-git/package.json"));
const BUNMSH="https://github.com/jjtseng93/bunmsh";

// Termux on recent Android cannot exec a binary from the app's data
// directory directly; libtermux-exec rewrites every exec to go through the
// system linker.  `LD_PRELOAD= bun test`, which the tracer's tests need, drops
// that from this process, so its own spawns fall back to the same trick, and
// the children get the library back so that Git's helper processes work.
const LINKER="/system/bin/linker64";
const TERMUX_EXEC=join(process.env.PREFIX||"/data/data/com.termux/files/usr","lib","libtermux-exec.so");
// True only where a plain spawn is refused: not inside a glibc PRoot, where
// the Termux prefix may be visible but its bionic library must not be loaded.
const NEEDS_LINKER=(()=>{
  try { Bun.spawnSync({ cmd:[BUN,"--version"], stdout:"pipe", stderr:"pipe" }); return false; }
  catch (error) { return error.code==="EACCES" && existsSync(LINKER) && existsSync(TERMUX_EXEC); }
})();
function spawn(options) {
  try { return Bun.spawnSync(options); }
  catch (error) {
    if (error.code!=="EACCES" || !NEEDS_LINKER) throw error;
    return Bun.spawnSync({ ...options, cmd:[LINKER,...options.cmd] });
  }
}

const scratch=mkdtempSync(join(tmpdir(),"isogit-"));
const home=join(scratch,"home");
const roots={ sys:join(scratch,"sys"), iso:join(scratch,"iso") };
let clock=1700000000;

function environment(step,extra={}) {
  const date=`${clock+step} +0000`;
  return {
    ...process.env, HOME:home, XDG_CONFIG_HOME:join(home,".config"), LC_ALL:"C", LANG:"C", TZ:"UTC",
    GIT_CONFIG_NOSYSTEM:"1", GIT_TERMINAL_PROMPT:"0",
    GIT_AUTHOR_NAME:"Test Author", GIT_AUTHOR_EMAIL:"author@example.com",
    GIT_COMMITTER_NAME:"Test Committer", GIT_COMMITTER_EMAIL:"committer@example.com",
    GIT_AUTHOR_DATE:date, GIT_COMMITTER_DATE:date,
    LD_PRELOAD:NEEDS_LINKER?TERMUX_EXEC:process.env.LD_PRELOAD??"", ...extra,
  };
}

// The port colours and decorates its output whether or not it is piped, where
// Git only does so on a terminal; ask it for Git's terminal-sensing defaults
// so both sides print plain text into these pipes.  A later `-c` wins, so a
// step can still turn colour on for both.
function launch(side,cwd,args,step,envExtra) {
  const cmd=side==="sys"?[SYSTEM_GIT,...args]:[BUN,PROOT,"--git","-c","color.ui=auto","-c","log.decorate=auto",...args];
  const result=spawn({ cmd, cwd, env:environment(step,envExtra), stdin:"ignore", stdout:"pipe", stderr:"pipe" });
  const scrub=(text)=>text.toString().split(roots.sys).join("<root>").split(roots.iso).join("<root>");
  return { stdout:scrub(result.stdout), stderr:scrub(result.stderr), status:result.exitCode };
}

let step=0;
// Runs one command line through both implementations, in the same relative
// directory of each worktree, with the same fixed timestamps.
function both(args,{ cwd="" }={}) {
  step++;
  return {
    sys:launch("sys",join(roots.sys,cwd),args,step),
    iso:launch("iso",join(roots.iso,cwd),args,step),
  };
}
function bothStdin(args,input,{ cwd="" }={}) {
  step++;
  const run=(side)=>{
    const cmd=side==="sys"?[SYSTEM_GIT,...args]:[BUN,PROOT,"--git","-c","color.ui=auto","-c","log.decorate=auto",...args];
    const result=spawn({ cmd,cwd:join(roots[side],cwd),env:environment(step),stdin:Buffer.from(input),stdout:"pipe",stderr:"pipe" });
    return { stdout:result.stdout.toString(),stderr:result.stderr.toString(),status:result.exitCode };
  };
  return { sys:run("sys"),iso:run("iso") };
}
function sameStdin(args,input,options) {
  const { sys,iso }=bothStdin(args,input,options);
  const label=`git ${args.join(" ")}`;
  expect({ label,status:iso.status,stdout:iso.stdout,stderr:iso.stderr }).toEqual({ label,status:sys.status,stdout:sys.stdout,stderr:sys.stderr });
  return { sys,iso };
}
function same(args,options) {
  const { sys,iso }=both(args,options);
  const label=`git ${args.join(" ")}`;
  expect({ label, status:iso.status, stdout:iso.stdout }).toEqual({ label, status:sys.status, stdout:sys.stdout });
  return { sys,iso };
}
// Both agree and both succeeded; for steps where agreeing on a failure would
// hide a broken fixture.
function ok(args,options) {
  const result=same(args,options);
  expect({ label:`git ${args.join(" ")}`, status:result.sys.status, stderr:result.sys.stderr }).toMatchObject({ status:0 });
  return result;
}
// The system git's view of both repositories, which is the comparison that
// matters: identical commits, trees, refs and index regardless of output.
function crossCheck(cwd="") {
  const describe=(root)=>{
    const run=(...args)=>launch("sys",join(root,cwd),args,0).stdout;
    // The port follows Git 2.48 in creating refs/remotes/<remote>/HEAD on
    // fetch; an older system Git does not, so that ref is left out.
    return {
      status:run("status","--porcelain"),
      refs:run("show-ref").split("\n").filter((line)=>!/ refs\/remotes\/[^ ]+\/HEAD$/.test(line)).join("\n"),
      index:run("ls-files","-s"),
      history:run("log","--all","--format=%H %P %T %an %ae %at %cn %ce %ct%n%B"),
      head:run("rev-parse","HEAD"),
    };
  };
  expect(describe(roots.iso)).toEqual(describe(roots.sys));
}
function write(relative,content) {
  for (const root of Object.values(roots)) {
    mkdirSync(dirname(join(root,relative)),{ recursive:true });
    writeFileSync(join(root,relative),content);
  }
}
function remove(relative) {
  for (const root of Object.values(roots)) rmSync(join(root,relative),{ recursive:true, force:true });
}
function read(relative) {
  return Object.fromEntries(Object.entries(roots).map(([side,root])=>[side,readFileSync(join(root,relative),"utf8")]));
}

// A smart-HTTP server for the push/pull steps: git-http-backend over CGI.
// It runs as a separate process because the clients are spawned
// synchronously, and a server inside this process could never answer them.
const SERVER=String.raw`
const { ISOGIT_ROOT:root, ISOGIT_GIT:git }=process.env;
const server=Bun.serve({ port:0, hostname:"127.0.0.1", async fetch(request) {
  const url=new URL(request.url);
  let body=request.method==="POST"?new Uint8Array(await request.arrayBuffer()):undefined;
  let encoding=request.headers.get("content-encoding")??"";
  if (body && encoding==="gzip") { try { body=Bun.gunzipSync(body); encoding=""; } catch {} }
  const env={
    ...process.env, GIT_PROJECT_ROOT:root, GIT_HTTP_EXPORT_ALL:"1", GATEWAY_INTERFACE:"CGI/1.1", SERVER_PROTOCOL:"HTTP/1.1",
    REQUEST_METHOD:request.method, PATH_INFO:url.pathname, QUERY_STRING:url.search.slice(1), REMOTE_ADDR:"127.0.0.1",
    CONTENT_TYPE:request.headers.get("content-type")??"", CONTENT_LENGTH:body?String(body.length):"",
    HTTP_CONTENT_ENCODING:encoding, HTTP_GIT_PROTOCOL:request.headers.get("git-protocol")??"",
  };
  const backend=Bun.spawn({ cmd:[git,"http-backend"], env, stdin:body??"ignore", stdout:"pipe", stderr:"ignore" });
  const output=Buffer.from(await new Response(backend.stdout).arrayBuffer());
  const split=output.indexOf("\r\n\r\n");
  const headers=new Headers();
  let status=200;
  for (const line of output.subarray(0,split).toString().split("\r\n")) {
    const colon=line.indexOf(":");
    const name=line.slice(0,colon), value=line.slice(colon+1).trim();
    if (name.toLowerCase()==="status") status=parseInt(value); else headers.append(name,value);
  }
  return new Response(output.subarray(split+4),{ status,headers });
} });
console.log(server.port);
`;
async function serve(root) {
  const env={ ...environment(0), ISOGIT_ROOT:root, ISOGIT_GIT:SYSTEM_GIT };
  let child;
  try { child=Bun.spawn({ cmd:[BUN,"-e",SERVER], stdout:"pipe", stderr:"inherit", env }); }
  catch (error) {
    if (error.code!=="EACCES" || !NEEDS_LINKER) throw error;
    child=Bun.spawn({ cmd:[LINKER,BUN,"-e",SERVER], stdout:"pipe", stderr:"inherit", env });
  }
  const reader=child.stdout.getReader();
  let text="";
  while (!text.includes("\n")) {
    const { value,done }=await reader.read();
    if (done) throw new Error("the http-backend server exited before reporting its port");
    text+=Buffer.from(value).toString();
  }
  return { port:Number(text.trim()), stop:()=>child.kill() };
}

const READY=SYSTEM_GIT && INSTALLED;
// Each step spawns two processes, so a case is dozens of launches.
const SLOW=120000;
const it=READY?(name,fn,timeout=SLOW)=>test(name,fn,timeout):test.skip;
if (!READY) console.warn("isogit: needs git on PATH and tools/isomorphic-git installed; skipping");

beforeAll(()=>{
  mkdirSync(join(home,".config","git"),{ recursive:true });
  writeFileSync(join(home,".gitconfig"),"[init]\n\tdefaultBranch = main\n[user]\n\tname = Global Name\n\temail = global@example.com\n");
  for (const root of Object.values(roots)) mkdirSync(root,{ recursive:true });
});
afterAll(()=>{ rmSync(scratch,{ recursive:true, force:true }); });

describe("bunproot --git matches the system git",()=>{
  it("accepts --yes before the Git command",()=>{
    const result=spawn({
      cmd:[BUN,PROOT,"--git","--yes","--version"], cwd:roots.iso,
      env:environment(0), stdin:"ignore", stdout:"pipe", stderr:"pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("isomorphic-git.1.41.9 (bunproot)");
  });

  it("init, status and rev-parse in an empty repository",()=>{
    same(["init","."]);
    same(["status"]);
    same(["status","--porcelain"]);
    same(["status","-sb"]);
    same(["rev-parse","--is-inside-work-tree"]);
    same(["rev-parse","--show-toplevel"]);
    same(["rev-parse","--git-dir"]);
    same(["branch","--show-current"]);
    same(["config","--local","core.bare"]);
    same(["config","user.name"]);
    expect(both(["log"]).iso.status).toBe(both(["log"]).sys.status);
    crossCheck();
  });

  it("add and the first commit",()=>{
    write("a.txt","hello\n");
    write("dir/nested/b.txt","one\ntwo\n");
    write(".gitignore","*.log\nbuild/\n");
    write("debug.log","ignored\n");
    write("build/out","ignored\n");
    same(["status"]);
    same(["status","--porcelain"]);
    same(["add","a.txt"]);
    same(["status"]);
    same(["status","-s"]);
    same(["ls-files"]);
    same(["commit","-m","first commit"]);
    same(["log"]);
    same(["log","--oneline"]);
    same(["rev-parse","HEAD"]);
    same(["cat-file","-t","HEAD"]);
    same(["cat-file","-p","HEAD"]);
    same(["cat-file","-p","HEAD^{tree}"]);
    same(["ls-files","-s"]);
    same(["hash-object","a.txt"]);
    crossCheck();
  });

  it("add ., modified and untracked status, commit -a",()=>{
    same(["add","."]);
    same(["status"]);
    same(["status","--porcelain"]);
    same(["commit","-m","add the rest\n\nWith a body paragraph.\n"]);
    same(["log","--format=%H%n%P%n%T%n%an <%ae> %at%n%cn <%ce> %ct%n%s%n--%n%b--"]);
    write("a.txt","hello\nworld\n");
    write("dir/nested/b.txt","one\n");
    write("untracked/c.txt","c\n");
    same(["status"]);
    same(["status","--porcelain"]);
    same(["add","dir"]);
    write("dir/nested/b.txt","one\nthree\n");
    same(["status"]);
    same(["status","--porcelain"]);
    same(["commit","-am","edit both"]);
    same(["status","--porcelain"]);
    same(["log","--oneline"]);
    same(["log","-1","--format=%s"]);
    same(["log","-n","2","--format=%h %p"]);
    same(["log","--reverse","--format=%s"]);
    same(["log","--format=%s","--","a.txt"]);
    same(["cat-file","-p","HEAD:a.txt"].slice(0,2).concat([launch("sys",roots.sys,["rev-parse","HEAD:a.txt"],0).stdout.trim()]));
    crossCheck();
  });

  it("mv, rm, restore and reset",()=>{
    same(["mv","a.txt","renamed.txt"]);
    same(["status"]);
    same(["status","--porcelain"]);
    same(["commit","-m","rename a"]);
    same(["rm","renamed.txt"]);
    same(["status","--porcelain"]);
    same(["commit","-m","remove renamed"]);
    same(["rm","-r","--cached","dir"]);
    same(["status","--porcelain"]);
    same(["restore","--staged","dir"]);
    same(["status","--porcelain"]);
    write("dir/nested/b.txt","scribble\n");
    same(["restore","dir/nested/b.txt"]);
    same(["status","--porcelain"]);
    expect(read("dir/nested/b.txt").iso).toBe("one\nthree\n");
    same(["reset","--soft","HEAD~1"]);
    same(["status","--porcelain"]);
    same(["reset","HEAD~1"]);
    same(["status","--porcelain"]);
    same(["reset","--hard","HEAD"]);
    same(["status","--porcelain"]);
    same(["log","--oneline"]);
    remove("untracked");
    crossCheck();
  });

  it("branches, tags, fast-forward and true merges",()=>{
    same(["branch","dev"]);
    same(["branch"]);
    same(["checkout","dev"]);
    same(["branch","--show-current"]);
    write("dev.txt","dev\n");
    same(["add","dev.txt"]);
    same(["commit","-m","on dev"]);
    same(["checkout","main"]);
    same(["merge","dev"]);
    same(["log","--oneline"]);
    same(["rev-parse","--abbrev-ref","HEAD"]);
    write("main.txt","main\n");
    same(["add","main.txt"]);
    same(["commit","-m","on main"]);
    same(["switch","dev"]);
    write("dev.txt","dev\nmore\n");
    same(["commit","-am","more dev"]);
    same(["switch","main"]);
    same(["merge","--no-ff","-m","merge dev","dev"]);
    same(["log","--format=%H %P %s"]);
    same(["log","--oneline","-3"]);
    same(["rev-parse","HEAD^2"]);
    same(["rev-parse","--short","HEAD~2"]);
    same(["tag","v1"]);
    same(["tag","-a","v2","-m","annotated"]);
    same(["tag"]);
    same(["tag","-l","v*"]);
    same(["cat-file","-t","v2"]);
    same(["cat-file","-p","v2"]);
    same(["rev-parse","v2^{}"]);
    same(["show-ref"]);
    same(["show-ref","--tags"]);
    same(["branch","-d","dev"]);
    same(["branch"]);
    same(["tag","-d","v1"]);
    same(["tag"]);
    same(["checkout","-b","feature"]);
    same(["branch","-m","feature","renamed-feature"]);
    same(["branch"]);
    same(["switch","main"]);
    same(["branch","-D","renamed-feature"]);
    crossCheck();
  });

  it("a conflicting merge fails the same way and aborts cleanly",()=>{
    same(["checkout","-b","left"]);
    write("main.txt","left\n");
    same(["commit","-am","left side"]);
    same(["checkout","main"]);
    write("main.txt","right\n");
    same(["commit","-am","right side"]);
    const { sys,iso }=both(["merge","left"]);
    expect(iso.status).toBe(sys.status);
    expect(iso.stdout).toContain("CONFLICT (content): Merge conflict in main.txt");
    const merged=read("main.txt");
    expect(merged.iso).toContain("<<<<<<<");
    same(["merge","--abort"]);
    same(["status","--porcelain"]);
    expect(read("main.txt").iso).toBe("right\n");
    same(["branch","-D","left"]);
    crossCheck();
  });

  it("diff through bun pm diff, re-headed the way Git prints it",()=>{
    write("code.js","function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n\nfunction baz() {\n  return 3;\n}\n");
    write("numbers.txt",Array.from({ length:30 },(_,i)=>`line ${i+1}`).join("\n")+"\n");
    write("noeol.txt","no newline");
    write("blob.bin","\0\x01\x02\n");
    same(["add","."]);
    same(["commit","-m","diff fixtures"]);
    same(["diff"]);
    same(["diff","--exit-code"]);
    write("code.js","function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 22;\n}\n\nfunction baz() {\n  return 33;\n  // more\n}\n");
    write("numbers.txt",Array.from({ length:30 },(_,i)=>i===4?"changed 5":i===24?"changed 25":`line ${i+1}`).filter((l)=>l!=="line 15").join("\n")+"\nline 31\n");
    write("noeol.txt","still no newline");
    write("blob.bin","\0\x01\x03\n");
    write("untracked.txt","not shown\n");
    same(["diff"]);
    same(["diff","--stat"]);
    same(["diff","--name-only"]);
    same(["diff","--name-status"]);
    same(["diff","-U1","--","numbers.txt"]);
    same(["diff","--unified=0","numbers.txt"]);
    expect(both(["diff","--exit-code"]).iso.status).toBe(1);
    same(["diff","--quiet"]);
    same(["add","code.js","noeol.txt"]);
    same(["diff"]);
    same(["diff","--cached"]);
    same(["diff","--staged","--stat"]);
    same(["diff","HEAD"]);
    same(["diff","HEAD","--","code.js"]);
    remove("numbers.txt");
    same(["diff","--name-status"]);
    same(["diff"]);
    same(["commit","-am","diff changes"]);
    same(["diff","HEAD~1","HEAD"]);
    same(["diff","HEAD~1..HEAD","--stat"]);
    same(["diff","HEAD~1"]);
    same(["-c","color.ui=always","diff","HEAD~1","--","code.js"]);
    remove("untracked.txt");
    same(["status","--porcelain"]);
    crossCheck();
  });

  // `git diff <commit>` compares the commit with the worktree, but only for
  // the paths the index tracks: a file committed since then is new, one
  // removed from the index is deleted, and an untracked file is invisible.
  it("diff against an older commit sees the files the index tracks",()=>{
    const base=same(["rev-parse","HEAD"]).sys.stdout.trim();
    write("added.txt","added after base\n");
    write("nested/deep/added.txt","nested and added\n");
    write("tool.sh","#!/bin/sh\necho tool\n");
    for (const root of Object.values(roots)) chmodSync(join(root,"tool.sh"),0o755);
    same(["add","added.txt","nested","tool.sh"]);
    same(["commit","-m","files added after base"]);
    // The hash itself, the way it is pasted from `log`, and the relative names.
    same(["diff",base]);
    same(["diff",base.slice(0,7)]);
    same(["diff","HEAD~1"]);
    same(["diff","HEAD~1","--stat"]);
    same(["diff","--name-only","HEAD~1"]);
    same(["diff","--name-status","HEAD~1"]);
    same(["diff","HEAD~1","--","added.txt"]);
    same(["diff","HEAD~1","--","nested"]);
    same(["diff","HEAD~1","--","code.js"]);
    same(["diff","-U0","HEAD~1","nested/deep/added.txt"]);
    expect(same(["diff","--exit-code","HEAD~1"]).iso.status).toBe(1);
    same(["diff","--quiet","HEAD~1"]);
    same(["tag","base-plus-one"]);
    same(["diff","base-plus-one"]);
    // From a subdirectory: relative paths, and only that subtree.
    same(["diff","HEAD~1"],{ cwd:"nested" });
    same(["diff","HEAD~1","--stat"],{ cwd:"nested/deep" });
    same(["diff","HEAD~1","--","."],{ cwd:"nested" });
    // Worktree edits on top: a committed file changed again, a new file only
    // staged and then edited, a staged file gone from disk, an untracked one.
    write("added.txt","added after base\nand edited\n");
    write("staged.txt","staged\n");
    same(["add","staged.txt"]);
    write("staged.txt","staged\nthen edited\n");
    write("gone.txt","staged then deleted\n");
    same(["add","gone.txt"]);
    remove("gone.txt");
    write("untracked.txt","never added\n");
    same(["diff","HEAD~1"]);
    same(["diff","HEAD~1","--stat"]);
    same(["diff","--name-status","HEAD~1"]);
    same(["diff","HEAD"]);
    same(["diff","--cached","HEAD~1","--stat"]);
    same(["diff"]);
    // Committed files leaving the index or the disk read as deleted.
    same(["rm","--cached","noeol.txt"]);
    remove("code.js");
    same(["diff","HEAD~1","--name-status"]);
    same(["diff","HEAD~1","--","noeol.txt"]);
    same(["diff","HEAD~1","--","code.js"]);
    same(["diff","HEAD","--stat"]);
    same(["diff","--stat",base]);
    same(["status","--porcelain"]);
    // Back to a clean tree for the later steps.
    same(["reset","-q","--hard","HEAD"]);
    remove("staged.txt");
    remove("untracked.txt");
    same(["tag","-d","base-plus-one"]);
    same(["status","--porcelain"]);
    crossCheck();
  });

  it("colours like Git, and by default even in a pipe",()=>{
    write("colour.txt","colour\n");
    write("dir/nested/b.txt","one\nthree\nfour\n");
    same(["add","colour.txt"]);
    same(["tag","v3"]);
    // Without the terminal-sensing defaults launch() adds, the pipe still gets colour.
    const raw=(...args)=>spawn({ cmd:[BUN,PROOT,"--git",...args], cwd:roots.iso, env:environment(0), stdout:"pipe", stderr:"pipe" }).stdout.toString();
    const bare=raw("status","-s");
    expect(bare).not.toBe(Bun.stripANSI(bare));
    expect(Bun.stripANSI(bare)).toBe(launch("sys",roots.sys,["status","-s"],0).stdout);
    expect(raw("status","-s","--no-color")).toBe(Bun.stripANSI(bare));
    expect(raw("-c","color.ui=never","status","-s")).toBe(Bun.stripANSI(bare));
    expect(Bun.stripANSI(raw("log","--oneline","-1"))).toContain("(HEAD -> main, tag: v3)");
    expect(raw("log","--oneline","-1","--no-decorate")).not.toContain("HEAD");
    for (const args of [["status"],["status","-s"],["status","-sb"],["branch","-a"],["log","--oneline","-3"],["log","--decorate","-1"],["log","--oneline","--decorate","-2"],["log","--format=%h%d %s","-2"]]) {
      // Without colour.ui the pipe gets plain text, so the plain runs above
      // and below already cover that; force it on and compare both the
      // sequences and what they wrap.
      const { sys,iso }=both(["-c","color.ui=always",...args]);
      const label=`git -c color.ui=always ${args.join(" ")}`;
      expect({ label, status:iso.status, plain:Bun.stripANSI(iso.stdout) }).toEqual({ label, status:sys.status, plain:Bun.stripANSI(sys.stdout) });
      expect({ label, stdout:iso.stdout }).toEqual({ label, stdout:sys.stdout });
      if (args[0]==="status" || args[0]==="branch") expect({ label, coloured:iso.stdout!==Bun.stripANSI(iso.stdout) }).toEqual({ label, coloured:true });
    }
    same(["-c","color.ui=never","status","-s"]);
    same(["-c","color.ui=always","status","--porcelain"]);
    same(["reset","-q","colour.txt"]);
    same(["tag","-d","v3"]);
    remove("colour.txt");
    same(["restore","dir"]);
    same(["status","--porcelain"]);
    crossCheck();
  });

  it("config in the repository and the home directory",()=>{
    same(["config","--local","test.value","one"]);
    same(["config","test.value"]);
    same(["config","--get","test.value"]);
    same(["config","--local","--list"]);
    same(["config","--unset","test.value"]);
    expect(both(["config","test.value"]).iso.status).toBe(1);
    same(["config","--global","alias.co","checkout"]);
    same(["config","--global","--list"]);
    same(["config","--global","--unset","alias.co"]);
    same(["config","--global","--list"]);
    same(["-c","user.name=Override","config","user.name"]);
  });

  it("show, log --all, the commit editor and stash match Git",()=>{
    same(["show","--no-patch","HEAD"]);
    same(["show","--stat","HEAD"]);
    same(["show","--stat","--oneline","HEAD"]);
    same(["show","HEAD"]);
    const rootCommit=launch("sys",roots.sys,["rev-list","--max-parents=0","HEAD"],0).stdout.trim();
    same(["show",rootCommit]);
    same(["log","--all","--format=%H %P %s"]);
    write("edited-message.txt","edited through an editor\n");
    same(["add","edited-message.txt"]);
    process.env.GIT_EDITOR="sed -i '1i editor supplied message'";
    try { same(["commit"]); } finally { delete process.env.GIT_EDITOR; }
    write("timezone.txt","non-UTC date\n");
    same(["add","timezone.txt"]);
    const dated={ GIT_AUTHOR_DATE:"1700001000 +0800", GIT_COMMITTER_DATE:"1700001000 +0800" };
    const datedSys=launch("sys",roots.sys,["commit","-m","non-UTC date"],0,dated);
    const datedIso=launch("iso",roots.iso,["commit","-m","non-UTC date"],0,dated);
    expect({ status:datedIso.status,stdout:datedIso.stdout }).toEqual({ status:datedSys.status,stdout:datedSys.stdout });
    same(["show","--no-patch","HEAD"]);
    write("edited-message.txt","worktree stash change\n");
    same(["stash","push","-m","temporary work"]);
    same(["stash","list"]);
    same(["config","--local","user.name"]);
    same(["status","--porcelain"]);
    const popped=both(["stash","pop"]);
    for (const side of ["sys","iso"]) {
      expect(popped[side].status).toBe(0);
      expect(popped[side].stdout.replace(/\([0-9a-f]{40}\)\n$/, "(<stash-oid>)\n"))
        .toBe(popped.sys.stdout.replace(/\([0-9a-f]{40}\)\n$/, "(<stash-oid>)\n"));
    }
    same(["status","--porcelain"]);
    same(["restore","edited-message.txt"]);
    crossCheck();
  });

  it("check-ignore, merge-base and diff --check match Git",()=>{
    write("tracked.tmp","tracked despite later ignore rule\n");
    same(["add","tracked.tmp"]);
    write(".gitignore","ignored/\n*.tmp\n");
    write("ignored/file.txt","ignored\n");
    write("ignored.tmp","ignored\n");
    write("kept.txt","kept\n");
    same(["check-ignore","ignored/file.txt","kept.txt","ignored.tmp"]);
    expect(both(["check-ignore","-q","kept.txt"]).iso.status).toBe(1);
    expect(both(["check-ignore","-q","ignored.tmp"]).iso.status).toBe(0);
    same(["check-ignore","tracked.tmp"]);
    same(["check-ignore","--no-index","tracked.tmp"]);
    same(["merge-base","HEAD","HEAD~1"]);
    expect(both(["merge-base","--is-ancestor","HEAD~1","HEAD"]).iso.status).toBe(0);
    expect(both(["merge-base","--is-ancestor","HEAD","HEAD~1"]).iso.status).toBe(1);
    write("whitespace.txt","trailing  \nclean\n");
    same(["add","whitespace.txt"]);
    same(["diff","--cached","--check"]);
    same(["reset","-q","whitespace.txt"]);
    remove("whitespace.txt");
    remove("ignored");
    remove("ignored.tmp");
    remove("kept.txt");
    same(["reset","-q","tracked.tmp"]);
    remove("tracked.tmp");
    remove(".gitignore");
    crossCheck();
  });

  it("log filters, ignored status, notes and update-ref match Git",()=>{
    write("ignored-dir/file.txt","ignored\n");
    write(".gitignore","ignored-dir/\n");
    same(["status","--short","--ignored"]);
    same(["status","--ignored"]);
    same(["log","--oneline","--since=2023-11-14T22:21:40Z"]);
    same(["log","--follow","--oneline","--","renamed.txt"]);
    same(["notes","add","-m","a test note","HEAD"]);
    same(["notes","list"]);
    same(["notes","show","HEAD"]);
    same(["notes","remove","HEAD"]);
    same(["update-ref","-d","refs/notes/commits"]);
    same(["update-ref","refs/test/probe","HEAD"]);
    same(["rev-parse","refs/test/probe"]);
    same(["update-ref","-d","refs/test/probe"]);
    remove("ignored-dir");
    remove(".gitignore");
    crossCheck();
  });

  it("--amend keeps the author unless told otherwise",()=>{
    write("amend.txt","first\n");
    same(["add","amend.txt"]);
    same(["commit","-m","to be amended"]);
    write("amend.txt","second\n");
    same(["add","amend.txt"]);
    // Later steps have later dates: the author date must stay the original.
    same(["commit","--amend","--no-edit"]);
    same(["log","-1","--format=%an %ae %ad%n%cn %ce %cd"]);
    same(["commit","--amend","--no-edit","--author=Someone Else <else@example.com>"]);
    same(["log","-1","--format=%an %ae %ad"]);
    same(["commit","--amend","--no-edit","--date=2021-02-03T04:05:06+0000"]);
    same(["log","-1","--format=%an %ae %ad"]);
    same(["commit","--amend","--no-edit","--reset-author"]);
    same(["log","-1","--format=%an %ae %ad%n%cd"]);
    crossCheck();
  });

  it("a true merge updates the index and worktree and names the branch",()=>{
    same(["checkout","-b","topic"]);
    write("topic-only.txt","added on topic\n");
    write("main.txt","right\nand topic\n");
    same(["add","topic-only.txt","main.txt"]);
    same(["commit","-m","topic work"]);
    same(["checkout","main"]);
    write("main-only.txt","added on main\n");
    same(["add","main-only.txt"]);
    same(["commit","-m","main work"]);
    same(["merge","topic"]);
    // The file added on topic exists, the one it changed is updated, and
    // nothing is left staged or modified.
    expect(read("topic-only.txt").iso).toBe("added on topic\n");
    expect(read("main.txt").iso).toBe("right\nand topic\n");
    same(["status","--porcelain"]);
    same(["ls-files","-s"]);
    same(["log","-1","--format=%s%n%P"]);
    // Merging into a branch other than main/master says so, and other
    // argument forms are named as given.
    same(["checkout","topic"]);
    same(["merge","main"]);
    same(["log","-1","--format=%s"]);
    write("topic2.txt","more\n");
    same(["add","topic2.txt"]);
    same(["commit","-m","topic again"]);
    same(["checkout","main"]);
    same(["merge","--no-ff",same(["rev-parse","--short","topic"]).sys.stdout.trim()]);
    same(["log","-1","--format=%s"]);
    same(["merge","--no-ff","refs/heads/topic"]);
    same(["log","-3","--format=%s"]);
    same(["branch","-D","topic"]);
    crossCheck();
  });

  it("a conflicted merge is labelled, reported and concluded like Git",()=>{
    write("both.txt","1\n2\n3\n4\n5\n6\n7\n8\n9\n");
    write("gone.txt","to be deleted\n");
    same(["add","both.txt","gone.txt"]);
    same(["commit","-m","conflict fixtures"]);
    same(["checkout","-b","other"]);
    write("main.txt","other side\n");
    write("both.txt","1\n2\n3\n4\n5\n6\n7\n8\nnine\n");
    same(["rm","-q","gone.txt"]);
    same(["commit","-am","other side"]);
    same(["checkout","main"]);
    write("main.txt","main side\n");
    write("both.txt","one\n2\n3\n4\n5\n6\n7\n8\n9\n");
    write("gone.txt","modified here\n");
    same(["commit","-am","main side"]);
    // Auto-merging lines, content and modify/delete conflicts, HEAD and the
    // name as given on the conflict markers, and the clean merge of both.txt.
    same(["merge","other"]);
    expect(read("main.txt").iso).toBe("<<<<<<< HEAD\nmain side\n=======\nother side\n>>>>>>> other\n");
    expect(read("both.txt")).toEqual({ sys:"one\n2\n3\n4\n5\n6\n7\n8\nnine\n", iso:"one\n2\n3\n4\n5\n6\n7\n8\nnine\n" });
    same(["status"]);
    same(["status","-s"]);
    same(["status","--porcelain"]);
    same(["status","--","main.txt"]);
    // Neither committing nor merging over unresolved conflicts.
    same(["commit","-m","too early"]);
    same(["merge","other"]);
    same(["merge","--abort"]);
    same(["status","--porcelain"]);
    same(["merge","--abort"]);
    // Resolve, and the commit that concludes the merge has both parents.
    same(["merge","other"]);
    write("main.txt","both sides\n");
    same(["add","main.txt"]);
    same(["status"]);
    same(["rm","-q","gone.txt"]);
    same(["status"]);
    same(["status","-s"]);
    same(["commit","-m","resolved"]);
    same(["log","-1","--format=%s%n%P"]);
    same(["status","--porcelain"]);
    // Without -m the prepared merge message is used, comments and all.
    write("main.txt","main again\n");
    same(["commit","-am","main again"]);
    same(["checkout","other"]);
    write("main.txt","other again\n");
    same(["commit","-am","other again"]);
    same(["checkout","main"]);
    same(["merge","other"]);
    write("main.txt","resolved again\n");
    same(["add","main.txt"]);
    same(["commit","--no-edit"]);
    same(["log","-1","--format=%B%n%P"]);
    same(["branch","-D","other"]);
    crossCheck();
  });

  it("checkout carries local changes across branches like Git",()=>{
    write("carry-a.txt","a\n");
    write("carry-b.txt","b\n");
    write("carry-c.txt","c\n");
    same(["add","carry-a.txt","carry-b.txt","carry-c.txt"]);
    same(["commit","-m","carry fixtures"]);
    same(["checkout","-b","carry-other"]);
    write("carry-c.txt","c on other\n");
    write("carry-o.txt","o\n");
    same(["add","carry-o.txt"]);
    same(["commit","-am","carry other"]);
    same(["checkout","main"]);
    // Staged, unstaged and untracked changes survive -b at the same commit
    // and a switch to another commit, and are listed when the tree moved.
    write("carry-a.txt","a2\n");
    write("carry-n.txt","n\n");
    same(["add","carry-n.txt"]);
    write("carry-b.txt","b2\n");
    same(["add","carry-b.txt"]);
    write("carry-u.txt","untracked\n");
    same(["status","--porcelain"]);
    same(["checkout","-b","carry-topic"]);
    same(["status","--porcelain"]);
    same(["checkout","main"]);
    same(["switch","carry-topic"]);
    same(["switch","-c","carry-topic2"]);
    same(["checkout","-q","main"]);
    same(["checkout","carry-other"]);
    same(["status","--porcelain"]);
    expect(read("carry-b.txt").iso).toBe("b2\n");
    expect(read("carry-c.txt").iso).toBe("c on other\n");
    same(["checkout","main"]);
    same(["status","--porcelain"]);
    // A path the switch would change must not have local changes; an
    // untracked file must not be in the way; -f discards them.
    write("carry-c.txt","c local\n");
    same(["checkout","carry-other"]);
    same(["status","--porcelain"]);
    same(["checkout","-f","carry-other"]);
    same(["status","--porcelain"]);
    same(["checkout","main"]);
    write("carry-o.txt","in the way\n");
    same(["checkout","carry-other"]);
    remove("carry-o.txt");
    same(["checkout",same(["rev-parse","--short","carry-other"]).sys.stdout.trim()]);
    same(["status","--porcelain"]);
    same(["checkout","main"]);
    same(["commit","-m","carried"]);
    remove("carry-u.txt");
    same(["branch","-D","carry-other"]);
    same(["branch","-D","carry-topic"]);
    same(["branch","-D","carry-topic2"]);
    same(["status","--porcelain"]);
    crossCheck();
  });

  it("merge refuses or keeps local changes like Git and aborts cleanly",()=>{
    write("mg-a.txt","a\n");
    write("mg-keep.txt","k\n");
    write("mg-s.txt","s\n");
    write("mg-m.txt","m\n");
    write("mg-tool.sh","#!/bin/sh\n");
    for (const root of Object.values(roots)) chmodSync(join(root,"mg-tool.sh"),0o755);
    same(["add","mg-a.txt","mg-keep.txt","mg-s.txt","mg-m.txt","mg-tool.sh"]);
    same(["commit","-m","merge guard fixtures"]);
    same(["checkout","-b","mg-other"]);
    write("mg-a.txt","other\n");
    write("mg-add.txt","x\n");
    same(["add","mg-add.txt"]);
    same(["commit","-am","mg other"]);
    same(["checkout","main"]);
    same(["checkout","-b","mg-ffbase"]);
    same(["checkout","main"]);
    write("mg-m.txt","m2\n");
    same(["commit","-am","mg main"]);
    // A true merge: untracked in the way, a dirty index, a dirty touched file.
    write("mg-add.txt","u\n");
    same(["merge","mg-other"]);
    remove("mg-add.txt");
    write("mg-s.txt","st\n");
    same(["add","mg-s.txt"]);
    write("mg-a.txt","d\n");
    same(["merge","mg-other"]);
    same(["reset","-q","--hard"]);
    write("mg-a.txt","d\n");
    same(["merge","mg-other"]);
    same(["checkout","--","mg-a.txt"]);
    // Local changes to untouched paths survive a conflicted merge and its
    // abort, as does the executable bit of an untouched file.
    write("mg-keep.txt","edit\n");
    remove("mg-tool.sh");
    same(["merge","mg-other"]);
    same(["status","--porcelain"]);
    same(["ls-files","-s"]);
    expect(read("mg-keep.txt").iso).toBe("edit\n");
    same(["merge","--abort"]);
    same(["status","--porcelain"]);
    same(["ls-files","-s"]);
    same(["checkout","--","mg-keep.txt","mg-tool.sh"]);
    same(["merge","mg-other"]);
    same(["status","--porcelain"]);
    // A fast-forward: the same refusals with Git's other status, and a dirty
    // index on an untouched path is fine.
    same(["checkout","mg-ffbase"]);
    write("mg-add.txt","u\n");
    same(["merge","mg-other"]);
    remove("mg-add.txt");
    write("mg-a.txt","d\n");
    same(["merge","mg-other"]);
    same(["add","mg-a.txt"]);
    same(["merge","mg-other"]);
    same(["checkout","--","mg-a.txt"]);
    same(["reset","-q"]);
    same(["checkout","--","mg-a.txt"]);
    write("mg-s.txt","st\n");
    same(["add","mg-s.txt"]);
    write("mg-keep.txt","edit\n");
    same(["merge","mg-other"]);
    same(["status","--porcelain"]);
    same(["reset","-q","--hard"]);
    same(["checkout","main"]);
    same(["branch","-D","mg-other"]);
    same(["branch","-D","mg-ffbase"]);
    same(["status","--porcelain"]);
    crossCheck();
  });

  it("show prints an annotated tag before what it points to",()=>{
    // Tagging a merge commit would need Git's combined diff, which this port
    // does not produce; the tagged commit is a plain one.
    write("tagged.txt","tagged\n");
    same(["add","tagged.txt"]);
    same(["commit","-m","tagged commit\n\n\tindented with a tab"]);
    same(["tag","-a","shown","-m","shown tag\n\nwith a body"]);
    same(["show","shown"]);
    same(["show","shown","--stat"]);
    same(["show","-s","shown"]);
    same(["show","--oneline","-s","shown"]);
    same(["-c","color.ui=always","show","-s","shown"]);
    same(["tag","-d","shown"]);
  });

  it("status and ls-files are relative to the current directory",()=>{
    write("nested/one/inner.txt","inner\n");
    write("nested/two/other.txt","other\n");
    same(["add","nested"]);
    same(["commit","-m","nested files"]);
    write("nested/one/inner.txt","changed\n");
    write("main.txt","changed at the top\n");
    write("nested/one/new.txt","new\n");
    write("nested/untracked/x.txt","x\n");
    same(["mv","nested/two/other.txt","nested/one/moved.txt"]);
    for (const cwd of ["nested/one","nested"]) {
      same(["status"],{ cwd });
      same(["status","-s"],{ cwd });
      same(["status","-sb"],{ cwd });
      same(["status","--porcelain"],{ cwd });
      same(["ls-files"],{ cwd });
      same(["ls-files","."],{ cwd });
      same(["ls-files","-s"],{ cwd });
      same(["ls-files","-o"],{ cwd });
      same(["ls-files","--full-name"],{ cwd });
    }
    same(["ls-files","../../main.txt"],{ cwd:"nested/one" });
    same(["status","-s","."],{ cwd:"nested/one" });
    same(["commit","-am","nested changes"],{ cwd:"nested/one" });
    remove("nested/one/new.txt");
    remove("nested/untracked");
    same(["status","--porcelain"]);
    crossCheck();
  });

  it("log --pretty=format: and %xNN match Git",()=>{
    same(["log","--pretty=format:%s","-3"]);
    same(["log","--pretty=tformat:%s","-3"]);
    same(["log","--format=%s","-3"]);
    same(["log","--pretty=format:%h%x20%s%x09%an","-2"]);
    same(["log","--format=format:%s","-1"]);
  });

  it("diff pairs exact renames and takes A...B from the merge base",()=>{
    write("lib/x.js","x\n");
    write("lib/y.js","y\n");
    write("sub/z.js","z\n");
    same(["add","lib","sub"]);
    same(["commit","-m","rename fixtures"]);
    same(["mv","main.txt","renamed.txt"]);
    same(["mv","lib/x.js","lib/x2.js"]);
    same(["mv","sub/z.js","lib/z.js"]);
    same(["diff","--cached"]);
    same(["diff","--cached","--stat"]);
    same(["diff","--cached","--name-status"]);
    same(["diff","--cached","--name-only"]);
    same(["diff","--cached","--no-renames","--stat"]);
    same(["commit","-m","renames"]);
    same(["diff","HEAD~1"]);
    same(["diff","HEAD~1","--stat"]);
    same(["diff","HEAD~1","--name-status"]);
    same(["show","--stat","HEAD"]);
    same(["mv","lib/y.js","sub/y.js"]);
    same(["commit","-m","move y"]);
    same(["show","--stat","HEAD"]);
    same(["diff","HEAD~2..HEAD","--stat"]);
    same(["checkout","-b","three-dot"]);
    write("three.txt","three\n");
    same(["add","three.txt"]);
    same(["commit","-m","on three-dot"]);
    same(["checkout","main"]);
    write("renamed.txt","changed on main\n");
    same(["commit","-am","on main"]);
    same(["diff","main...three-dot","--stat"]);
    same(["diff","three-dot...main","--stat"]);
    same(["diff","main..three-dot","--stat"]);
    same(["diff","...three-dot","--stat"]);
    same(["diff","three-dot...","--stat"]);
    same(["diff","main...three-dot"]);
    same(["merge","three-dot"]);
    same(["branch","-d","three-dot"]);
    same(["mv","renamed.txt","main.txt"]);
    same(["commit","-m","named back"]);
    crossCheck();
  });

  it("diff --no-index compares files and directory trees like Git",()=>{
    write("no-index-left/same.txt","same\n");
    write("no-index-right/same.txt","same\n");
    write("no-index-left/changed.txt","old\n");
    write("no-index-right/changed.txt","new\n");
    write("no-index-left/deleted.txt","gone\n");
    write("no-index-right/added.txt","added\n");
    for (const extra of [[],["--stat"],["--name-only"],["--name-status"]])
      same(["diff","--no-index",...extra,"no-index-left","no-index-right"]);
    same(["diff","--no-index","no-index-left/changed.txt","no-index-right/changed.txt"]);
    write("no-index-right/changed.txt","bad trailing whitespace  \n");
    same(["diff","--no-index","--check","no-index-left/changed.txt","no-index-right/changed.txt"]);
    remove("no-index-left");
    remove("no-index-right");
    crossCheck();
  });

  it("plumbing objects and extended notes match Git",()=>{
    write("plumbing.txt","plumbing object\n");
    same(["hash-object","-t","blob","plumbing.txt"]);
    sameStdin(["hash-object","--stdin-paths"],"plumbing.txt\n");
    same(["add","plumbing.txt"]);
    const tree=same(["write-tree"]).sys.stdout.trim();
    same(["commit-tree",tree,"-p","HEAD","-m","plumbing commit"]);
    const blob=same(["hash-object","-w","plumbing.txt"]).sys.stdout.trim();
    sameStdin(["mktree"],`100644 blob ${blob}\tstandalone.txt\n`);
    sameStdin(["mktree","--batch"],`100644 blob ${blob}\tone.txt\n\n100644 blob ${blob}\ttwo.txt\n\n`);
    const head=launch("sys",roots.sys,["rev-parse","HEAD"],0).stdout.trim();
    const tag=`object ${head}\ntype commit\ntag plumbing-tag\ntagger Test Author <author@example.com> 1700000000 +0000\n\nplumbing tag\n`;
    sameStdin(["mktag"],tag);
    same(["notes","add","-m","first","HEAD"]);
    same(["notes","append","-m","second","HEAD"]);
    write("note-message.txt","from a file\n");
    same(["notes","add","-F","note-message.txt","HEAD~1"]);
    same(["notes","add","--allow-empty","-m","","HEAD~2"]);
    same(["notes","copy","-f","HEAD","HEAD~1"]);
    same(["notes","show","HEAD~1"]);
    same(["notes","get-ref"]);
    same(["notes","prune"]);
    same(["notes","remove","HEAD","HEAD~1","HEAD~2"]);
    same(["update-ref","-d","refs/notes/commits"]);
    sameStdin(["update-ref","--stdin"],`create refs/test/stdin ${head}\n`);
    sameStdin(["update-ref","--stdin"],`verify refs/test/stdin ${head}\n`);
    sameStdin(["update-ref","--stdin"],`delete refs/test/stdin ${head}\n`);
    same(["reset","-q","plumbing.txt"]);
    remove("plumbing.txt");
    remove("note-message.txt");
    crossCheck();
  });

  it("clones a local working repository like Git",()=>{
    const clones={ sys:join(scratch,"local-sys"), iso:join(scratch,"local-iso") };
    const sys=launch("sys",scratch,["clone","-q",roots.sys,clones.sys],0);
    const iso=launch("iso",scratch,["clone","-q",roots.iso,clones.iso],0);
    expect({ status:iso.status,stderr:iso.stderr }).toEqual({ status:sys.status,stderr:sys.stderr });
    const describe=(dir)=>Object.fromEntries(["status --porcelain","log --all --format=%H %P %T %s","show-ref","ls-files -s","branch -a","tag","remote -v"]
      .map((c)=>[c,launch("sys",dir,c.split(" "),0).stdout.split(roots.sys).join("<root>").split(roots.iso).join("<root>")]));
    expect(describe(clones.iso)).toEqual(describe(clones.sys));
    // In the clone: commit a new file, then diff against the hash that was
    // HEAD before it, and against the remote-tracking branch still there.
    const before=launch("sys",clones.sys,["rev-parse","HEAD"],0).stdout.trim();
    for (const side of ["sys","iso"]) {
      writeFileSync(join(clones[side],"after-clone.txt"),"committed in the clone\n");
      expect(launch(side,clones[side],["add","after-clone.txt"],step+1).status).toBe(0);
      expect(launch(side,clones[side],["commit","-m","in the clone"],step+1).status).toBe(0);
    }
    step++;
    for (const args of [["diff",before],["diff","--stat",before],["diff","origin/main"],["diff","--name-status","origin/HEAD"],["diff",before,"HEAD"]]) {
      const sys=launch("sys",clones.sys,args,0), iso=launch("iso",clones.iso,args,0);
      expect({ args,status:iso.status,stdout:iso.stdout }).toEqual({ args,status:sys.status,stdout:sys.stdout });
      expect(sys.stdout).toContain("after-clone.txt");
    }
    const fileClones={ sys:join(scratch,"file-sys"), iso:join(scratch,"file-iso") };
    expect(launch("sys",scratch,["clone","-q",`file://${roots.sys}`,fileClones.sys],0).status).toBe(0);
    expect(launch("iso",scratch,["clone","-q",`file://${roots.iso}`,fileClones.iso],0).status).toBe(0);
    expect(describe(fileClones.iso)).toEqual(describe(fileClones.sys));
  });

  it("push, ls-remote, clone, fetch and pull over smart HTTP",async ()=>{
    const remotes=join(scratch,"remotes");
    for (const side of ["sys","iso"]) {
      launch("sys",scratch,["init","-q","--bare",join(remotes,`${side}.git`)],0);
      launch("sys",scratch,["-C",join(remotes,`${side}.git`),"config","http.receivepack","true"],0);
    }
    const server=await serve(remotes);
    try {
      const url=(side)=>`http://127.0.0.1:${server.port}/${side}.git`;
      for (const side of ["sys","iso"]) launch(side,roots[side],["remote","add","origin",url(side)],0);
      same(["remote"]);
      ok(["push","-u","origin","main"]);
      same(["branch","-a"]);
      same(["branch","-r"]);
      ok(["push","--tags"]);
      same(["config","branch.main.remote"]);
      same(["config","branch.main.merge"]);
      const bare=(side)=>launch("sys",join(remotes,`${side}.git`),["show-ref"],0).stdout;
      expect(bare("iso")).toBe(bare("sys"));
      const listed=ok(["ls-remote","origin"]);
      expect(listed.iso.stdout).toContain("\tHEAD\n");
      expect(listed.iso.stdout).toContain("\trefs/tags/v2^{}\n");
      ok(["ls-remote","--symref","origin"]);
      expect(both(["ls-remote","--exit-code","origin","refs/heads/does-not-exist"]).iso.status).toBe(2);
      ok(["ls-remote","--heads",url("iso")]);
      ok(["ls-remote","--tags","--refs","origin"]);
      // Clone each bare repository with each implementation into a fresh pair.
      const clones={ sys:join(scratch,"clone-sys"), iso:join(scratch,"clone-iso") };
      for (const side of ["sys","iso"]) {
        const result=launch(side,scratch,["clone","-q",url("sys"),clones[side]],0);
        expect({ side, status:result.status, stderr:result.stderr }).toEqual({ side, status:0, stderr:result.stderr });
      }
      const describeClone=(dir)=>Object.fromEntries(["status --porcelain","log --all --format=%H %P %s","ls-files -s","branch -a","tag","rev-parse HEAD","config branch.main.merge"]
        .map((c)=>[c,launch("sys",dir,c.split(" "),0).stdout]));
      expect(describeClone(clones.iso)).toEqual(describeClone(clones.sys));
      // A commit lands in the shared bare repository from a third party.
      launch("sys",clones.sys,["commit","--allow-empty","-m","upstream change"],step+1);
      launch("sys",clones.sys,["push","-q","origin","main"],0);
      launch("sys",clones.sys,["push","-q",url("iso"),"main"],0);
      ok(["fetch","origin"]);
      same(["rev-parse","origin/main"]);
      same(["log","--oneline","origin/main","-1"]);
      ok(["pull","origin","main"]);
      same(["log","--oneline","-2"]);
      same(["status","-sb"]);
      same(["status"]);
      write("local.txt","local\n");
      same(["add","local.txt"]);
      same(["commit","-m","ahead by one"]);
      same(["status","-sb"]);
      same(["status"]);
      ok(["push"]);
      same(["status","-sb"]);
      launch("sys",clones.sys,["pull","-q","origin","main"],0);
      launch("sys",clones.sys,["commit","--allow-empty","-m","behind by one"],step+1);
      launch("sys",clones.sys,["push","-q","origin","main"],0);
      launch("sys",clones.sys,["push","-q",url("iso"),"main"],0);
      ok(["fetch"]);
      same(["status","-sb"]);
      same(["status"]);
      ok(["pull"]);
      same(["status","-sb"]);
      // Git 2.48 behaviour: the fetch above created origin/HEAD as a symref.
      expect(launch("sys",roots.iso,["symbolic-ref","refs/remotes/origin/HEAD"],0).stdout).toBe("refs/remotes/origin/main\n");
      expect(launch("iso",roots.iso,["branch","-a"],0).stdout).toContain("  remotes/origin/HEAD -> origin/main\n");
      expect(launch("iso",roots.iso,["-c","remote.origin.followRemoteHEAD=never","fetch","-q"],0).status).toBe(0);
      expect(launch("sys",roots.iso,["symbolic-ref","refs/remotes/origin/HEAD"],0).stdout).toBe("refs/remotes/origin/main\n");
      crossCheck();
    } finally { server.stop(); }
  },SLOW);

  it(`clones ${BUNMSH} the way the system git does`,async ()=>{
    try { await fetch(`${BUNMSH}/info/refs?service=git-upload-pack`,{ signal:AbortSignal.timeout(15000) }); }
    catch { console.warn("isogit: github.com unreachable; skipping the bunmsh clone"); return; }
    const clones={ sys:join(scratch,"bunmsh-sys"), iso:join(scratch,"bunmsh-iso") };
    for (const side of ["sys","iso"]) {
      const result=launch(side,scratch,["clone","-q",BUNMSH,clones[side]],0);
      expect({ side, status:result.status, stderr:result.stderr }).toEqual({ side, status:0, stderr:result.stderr });
    }
    for (const args of [["rev-parse","HEAD"],["branch","--show-current"],["log","--oneline"],["ls-files"],["status","--porcelain"],["tag"],["remote","-v"]]) {
      const label=`git ${args.join(" ")}`;
      const sys=launch("sys",clones.sys,args,0), iso=launch("iso",clones.iso,args,0);
      expect({ label, status:iso.status, stdout:iso.stdout.split(clones.iso).join("<clone>") })
        .toEqual({ label, status:sys.status, stdout:sys.stdout.split(clones.sys).join("<clone>") });
    }
    const describeClone=(dir)=>Object.fromEntries(["log --all --format=%H %P %T","show-ref","ls-files -s","status --porcelain"]
      .map((c)=>[c,launch("sys",dir,c.split(" "),0).stdout]));
    expect(describeClone(clones.iso)).toEqual(describeClone(clones.sys));
  },300000);
});
